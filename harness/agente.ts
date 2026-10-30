// harness/agente.ts - o cérebro do bot, montado como um grafo do LangGraph
//
// O caminho do grafo (só o nó "modelo" usa IA; todos os outros são código):
//
//   START → preparar → modelo → pediu ferramenta? → sim → ferramentas → volta para modelo
//                                                → não → verificar → aprovou → planilha → END
//                                                                  → recusou → volta para modelo (até 2 vezes)
//                                                                  → recusou de novo → emergencia → planilha → END
//
// Para perguntar pelo terminal:   node harness/agente.ts "voos de GRU para LIS em 12/12"
// Para gerar o desenho:           node harness/agente.ts       (depois: open harness/agente.html)

import { writeFile } from "node:fs/promises";

import { AIMessage, type BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";

import { type Caderno, descreverVoo, diaDaSemana, ferramentasDaEtapa, hojeEmSaoPaulo, limparArgumentos, resumirVoos, servicos, todasAsFerramentas } from "./ferramentas.ts";
import { rastrear } from "./rastreio.ts";
import { arrumarParaSlack, verificarResposta } from "./verificador.ts";
import type { Voo } from "../voos.ts";

// ---------- CHAVES ----------
process.loadEnvFile(import.meta.dirname + "/../.env");

// ---------- LIMITES ----------
const LIMITE_DE_PASSOS = 8;       // quantas vezes o modelo pode ser chamado em um pedido
const LIMITE_DE_TENTATIVAS = 2;   // quantas respostas recusadas o modelo pode corrigir
const VALIDADE_DOS_PRECOS = 6 * 60 * 60 * 1000;    // 6 horas: depois disso, preço pesquisado não vale mais

// ---------- ESTADO ----------
// a "pasta" que passa pelas etapas. Nestes campos, o valor novo substitui o antigo.
function campo<T>(inicial: T) {
	return Annotation<T>({ reducer: (_antigo, novo) => novo, default: () => inicial });
}

const Estado = Annotation.Root({
	...MessagesAnnotation.spec,    // o campo "messages": a conversa (mensagens novas são somadas às antigas)
	voos: campo<Voo[]>([]),        // tudo o que foi pesquisado e ainda vale: as ferramentas de análise leem daqui
	novos: campo<Voo[]>([]),       // os voos que ainda não foram para uma planilha
	pesquisadoEm: campo(0),        // quando foi a última pesquisa
	buscas: campo<string[]>([]),   // as buscas feitas neste pedido
	passos: campo(0),              // quantas vezes o modelo já foi chamado neste pedido
	tentativas: campo(0),          // quantas respostas o verificador já recusou neste pedido
	correcao: campo(""),           // o bilhete do verificador para o modelo. Fica fora da conversa, então não suja a memória.
});

// ---------- MODELO ----------
// a Ollama Cloud entende o mesmo formato da OpenAI, então usamos o ChatOpenAI apontando para ela
const NOME_DO_MODELO = process.env.MODELO ?? "glm-5.3";
const modelo = new ChatOpenAI({
	model: NOME_DO_MODELO,
	apiKey: process.env.OLLAMA_API_KEY,
	configuration: { baseURL: "https://ollama.com/v1" },
	timeout: 120_000,
});

function instrucoes() {
	const hoje = hojeEmSaoPaulo();
	return `Você é o assistente de passagens aéreas do Gabriel, no Slack. Hoje é ${hoje} (${diaDaSemana(hoje)}).
Responda curto e direto, no idioma do pedido.

REGRAS
1. Todo preço, horário, duração, companhia e link vem de uma ferramenta. Copie exatamente como veio: 16h40 continua 16h40, e horário fica em HH:MM. Nunca faça conta de cabeça: use calcular.
2. Para achar voos, chame buscar_voos uma vez por trecho. Passe a cidade como veio no pedido (ela pesquisa todos os aeroportos) e a data como veio no pedido.
3. Se o pedido não disser o dia, pergunte. Nunca escolha uma data.
4. Ida e volta: chame buscar_voos para a ida, buscar_voos para a volta, e depois combinar_ida_e_volta para ter o total.
5. Datas flexíveis ou "qual o dia mais barato": chame buscar_varios_dias.
6. Pergunta sobre voos já pesquisados (o mais rápido, só os diretos, até certo preço): chame filtrar_voos ou melhores_voos. Não pesquise de novo.
7. Os preços já são o total de todos os passageiros, em reais.
8. "Custo-benefício" é o preço somado a R$ 30 por hora de viagem e R$ 200 por escala: quanto menor, melhor. Cite o melhor além do mais barato.
9. Não fale de planilha: o sistema cria e manda o link sozinho depois da sua resposta.
10. Para negrito, use *um asterisco de cada lado*.`;
}

// ---------- HISTÓRICO ----------
// a conversa fica guardada para sempre, mas só mandamos as mensagens recentes (cada carta custa dinheiro).
// O corte começa numa mensagem do usuário: uma resposta de ferramenta sem o pedido dela daria erro no modelo.
export function cortarHistorico(mensagens: BaseMessage[], limite = 40) {
	const ehDoUsuario = (mensagem: BaseMessage) => mensagem.getType() === "human";
	let inicio = mensagens.findIndex((mensagem, i) => i >= mensagens.length - limite && ehDoUsuario(mensagem));
	if (inicio === -1) inicio = mensagens.findLastIndex(ehDoUsuario);    // uma única rodada maior que o limite
	return mensagens.slice(inicio);
}

function textosDoUsuario(mensagens: BaseMessage[]) {
	return cortarHistorico(mensagens).filter((mensagem) => mensagem.getType() === "human").map((mensagem) => mensagem.text);
}

// ---------- NÓ: PREPARAR ----------
// todo pedido novo começa com os contadores zerados, e preço velho não vale mais
function noPreparar(estado: typeof Estado.State) {
	const velhos = Date.now() - estado.pesquisadoEm > VALIDADE_DOS_PRECOS;
	return {
		passos: 0,
		tentativas: 0,
		correcao: "",
		buscas: [],
		voos: velhos ? [] : estado.voos,
		novos: velhos ? [] : estado.novos,
	};
}

// ---------- NÓ: MODELO ----------
async function noModelo(estado: typeof Estado.State) {
	const carta: BaseMessage[] = [new SystemMessage(instrucoes()), ...cortarHistorico(estado.messages)];
	if (estado.correcao) carta.push(new HumanMessage(estado.correcao));

	// o modelo só enxerga as ferramentas da etapa; quando acabam os passos, não enxerga nenhuma e é obrigado a responder
	let resposta;
	if (estado.passos >= LIMITE_DE_PASSOS) {
		carta.push(new HumanMessage("Acabaram as ferramentas deste pedido. Responda agora com o que você já tem."));
		resposta = await modelo.invoke(carta);
	} else {
		resposta = await modelo.bindTools(ferramentasDaEtapa(estado.voos.length > 0)).invoke(carta);
	}
	return { messages: [resposta], passos: estado.passos + 1, correcao: "" };
}

// ---------- NÓ: FERRAMENTAS ----------
// um pedido de cada vez, na ordem: várias buscas ao mesmo tempo no Google poderiam levar a um bloqueio
export async function noFerramentas(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	// buscas é uma cópia: as ferramentas escrevem nela, e o Estado original não pode mudar antes do fim do nó
	const caderno: Caderno = { voos: estado.voos, novos: estado.novos, buscas: [...estado.buscas], textosDoUsuario: textosDoUsuario(estado.messages) };
	const respostas = [];

	for (const chamada of ultima.tool_calls ?? []) {
		let resultado: string;
		try {
			const ferramenta: any = todasAsFerramentas.find((opcao) => opcao.name === chamada.name);
			if (!ferramenta) throw new Error(`a ferramenta ${chamada.name} não existe. As que existem: ${todasAsFerramentas.map((opcao) => opcao.name).join(", ")}`);
			// aqui o zod confere os argumentos; se estiverem errados, o erro volta para o modelo corrigir
			resultado = await ferramenta.invoke(limparArgumentos(chamada.args), { configurable: { caderno } });
		} catch (erro: any) {
			// o erro volta para o modelo como texto: assim ele pode explicar ou tentar de outro jeito
			resultado = "Erro: " + erro.message;
		}
		console.log(`[ferramenta] ${chamada.name} ${JSON.stringify(chamada.args)} -> ${resultado.split("\n")[0]}`);
		respostas.push(new ToolMessage({ tool_call_id: chamada.id!, content: resultado }));
	}

	const pesquisou = caderno.buscas.length > estado.buscas.length;
	return {
		messages: respostas,
		voos: caderno.voos,
		novos: caderno.novos,
		buscas: caderno.buscas,
		pesquisadoEm: pesquisou ? Date.now() : estado.pesquisadoEm,
	};
}

// ---------- NÓ: VERIFICAR ----------
// a última barreira antes do Slack: nenhum valor pode chegar à pessoa sem ter vindo de uma ferramenta
function noVerificar(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	const anteriores = estado.messages.slice(0, -1);
	const texto = arrumarParaSlack(ultima.text);

	const doPedido = anteriores.slice(anteriores.findLastIndex((mensagem) => mensagem.getType() === "human"));
	const retornos = doPedido.filter((mensagem) => mensagem.getType() === "tool").map((mensagem) => mensagem.text);
	const regraDoCustoBeneficio = "R$ 30 por hora e R$ 200 por escala";    // a regra 8 das instruções: o modelo pode citar
	const fatos = [...retornos, ...estado.voos.map(descreverVoo), ...textosDoUsuario(estado.messages), regraDoCustoBeneficio].join("\n");
	const links = [...anteriores.map((mensagem) => mensagem.text), ...estado.voos.map((voo) => voo.link)].join("\n");

	// modelo fraco às vezes manda uma chamada de ferramenta quebrada: ela chega aqui sem texto nenhum
	const problemas = ultima.invalid_tool_calls?.length
		? ["Sua chamada de ferramenta veio com o JSON quebrado. Chame de novo, com os argumentos certos."]
		: verificarResposta(texto, fatos, links);

	if (problemas.length === 0) return { messages: [new AIMessage({ id: ultima.id, content: texto })] };

	console.log(`[verificador] recusou (${estado.tentativas + 1}): ${problemas.join(" / ")}`);
	return {
		messages: [new RemoveMessage({ id: ultima.id! })],    // a resposta errada sai da memória
		tentativas: estado.tentativas + 1,
		correcao: `O verificador recusou sua resposta, e o usuário não chegou a ver.\nResposta recusada: ${texto}\nProblemas:\n- ${problemas.join("\n- ")}\nEscreva de novo a resposta inteira, ou chame uma ferramenta.`,
	};
}

// ---------- NÓ: EMERGÊNCIA ----------
// o modelo errou todas as tentativas: o código escreve a resposta, com menos jeito, mas com os dados certos
function noEmergencia(estado: typeof Estado.State) {
	console.log("[emergencia] o modelo não acertou a resposta");
	const texto = estado.voos.length > 0
		? `Não consegui escrever a resposta com segurança, então seguem os dados direto da pesquisa:\n\n${resumirVoos(estado.voos)}`
		: "Não consegui responder com segurança. Pode repetir o pedido de outro jeito?";
	return { messages: [new AIMessage(texto)], correcao: "" };
}

// ---------- NÓ: PLANILHA ----------
// quem cria a planilha é o código: assim ela nunca é esquecida, nunca é criada duas vezes e o link nunca é inventado
async function noPlanilha(estado: typeof Estado.State) {
	if (estado.novos.length === 0) return {};
	const ultima = estado.messages.at(-1) as AIMessage;
	const rotas = [...new Set(estado.novos.map((voo) => `${voo.origem}→${voo.destino}`))].join(", ");
	try {
		const link = await servicos.criarPlanilha("Passagens " + rotas, estado.novos);
		return { messages: [new AIMessage({ id: ultima.id, content: `${ultima.text}\n\n:bar_chart: Planilha: ${link}` })], novos: [] };
	} catch (erro: any) {
		// os voos continuam em "novos": a próxima mensagem tenta criar a planilha de novo
		return { messages: [new AIMessage({ id: ultima.id, content: `${ultima.text}\n\nNão consegui criar a planilha: ${erro.message}` })] };
	}
}

// ---------- ARESTAS CONDICIONAIS ----------
function depoisDoModelo(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	return ultima.tool_calls?.length ? "ferramentas" : "verificar";
}

function depoisDeVerificar(estado: typeof Estado.State) {
	if (!estado.correcao) return "planilha";
	return estado.tentativas <= LIMITE_DE_TENTATIVAS ? "modelo" : "emergencia";
}

// ---------- GRAFO ----------
// o SqliteSaver guarda a pasta num arquivo depois de cada nó: é a memória que sobrevive ao Ctrl+C
const memoria = SqliteSaver.fromConnString(process.env.MEMORIA ?? import.meta.dirname + "/../memoria.sqlite");

const grafo = new StateGraph(Estado)
	.addNode("preparar", noPreparar)
	.addNode("modelo", noModelo)
	.addNode("ferramentas", noFerramentas)
	.addNode("verificar", noVerificar)
	.addNode("emergencia", noEmergencia)
	.addNode("planilha", noPlanilha)
	.addEdge(START, "preparar")
	.addEdge("preparar", "modelo")
	.addConditionalEdges("modelo", depoisDoModelo, ["ferramentas", "verificar"])
	.addEdge("ferramentas", "modelo")
	.addConditionalEdges("verificar", depoisDeVerificar, ["planilha", "modelo", "emergencia"])
	.addEdge("emergencia", "planilha")
	.addEdge("planilha", END)
	.compile({ checkpointer: memoria });

// ---------- RESPONDER ----------
type Avisar = (progresso: string) => Promise<void> | void;

// o que aparece no Slack enquanto o grafo trabalha
function descreverChamada(chamada: { name: string; args: Record<string, any> }) {
	if (chamada.name === "buscar_voos") return `:mag: Pesquisando ${chamada.args.origem}→${chamada.args.destino} em ${chamada.args.data}...`;
	if (chamada.name === "buscar_varios_dias") return `:mag: Pesquisando ${chamada.args.origem}→${chamada.args.destino} de ${chamada.args.data_inicio} a ${chamada.args.data_fim}...`;
	return ":gear: Analisando os voos...";
}

// stream roda o grafo igual ao invoke, mas entrega o resultado de cada nó assim que ele termina.
// recursionLimit: o freio de mão do LangGraph, bem acima dos nossos limites; só dispara se um limite nosso falhar.
async function rodar(entrada: { messages: BaseMessage[] } | null, config: { configurable: { thread_id: string } }, avisar: Avisar) {
	const callbacks = rastrear(config.configurable.thread_id, NOME_DO_MODELO);
	for await (const passo of await grafo.stream(entrada, { ...config, streamMode: "updates", recursionLimit: 60, callbacks })) {
		const resposta = passo.modelo?.messages?.[0] as AIMessage | undefined;
		for (const chamada of resposta?.tool_calls ?? []) await avisar(descreverChamada(chamada));
	}
	const estado = await grafo.getState(config);
	return estado.values.messages.at(-1)?.text as string;
}

// conversa: o identificador da conversa (no Slack, o canal). Cada um tem a sua pasta separada no arquivo.
export async function responder(conversa: string, texto: string, avisar: Avisar = () => {}): Promise<string> {
	const config = { configurable: { thread_id: conversa } };

	// se o bot caiu no meio de um pedido, primeiro terminamos esse pedido de onde ele parou,
	// e a resposta dele vai junto (ela pode trazer o link de uma planilha)
	let respostaAtrasada = "";
	const anterior = await grafo.getState(config);
	if (anterior.next.length > 0) respostaAtrasada = (await rodar(null, config, avisar)) + "\n\n";

	const resposta = await rodar({ messages: [new HumanMessage(texto)] }, config, avisar);
	return respostaAtrasada + (resposta || "Não consegui escrever uma resposta. Pode repetir o pedido?");
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	const pergunta = process.argv[2];
	if (pergunta) {
		console.log(await responder("terminal", pergunta, console.log));
	} else {
		// o mesmo desenho do grafo.ts: o Mermaid roda no seu navegador e nada do grafo sai do Mac
		const desenho = await grafo.getGraphAsync();
		await writeFile(import.meta.dirname + "/agente.html", `<!doctype html>
<meta charset="utf-8">
<title>Grafo do bot</title>
<pre class="mermaid">${desenho.drawMermaid()}</pre>
<script type="module">
	import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
	mermaid.initialize({ startOnLoad: true });
</script>`);
		console.log("Desenho salvo em agente.html");
	}
}
