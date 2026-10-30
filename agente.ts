// agente.ts - o cérebro do bot, montado como um grafo do LangGraph
//
// O caminho do grafo:
//
//   START → modelo → (pediu ferramenta?) → sim → ferramentas → volta para modelo
//                                        → não → END
//
// Para perguntar pelo terminal:   node agente.ts "voos de GRU para LIS em 12/12"
// Para gerar o desenho:           node agente.ts       (depois: open agente.html)

import { writeFile } from "node:fs/promises";

import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";

import { criarPlanilha } from "./planilha.ts";
import { buscarVoos, type Voo } from "./voos.ts";

// ---------- CHAVES ----------
process.loadEnvFile(import.meta.dirname + "/.env");

// ---------- ESTADO ----------
// a "pasta" que passa pelas etapas
const Estado = Annotation.Root({
	...MessagesAnnotation.spec,    // o campo "messages": a conversa (mensagens novas são somadas às antigas)
	voos: Annotation<Voo[]>({      // os voos pesquisados que ainda não foram para uma planilha
		reducer: (_antigo, novo) => novo,    // aqui o valor novo substitui o antigo
		default: () => [],
	}),
});

// ---------- MODELO ----------
// a Ollama Cloud entende o mesmo formato da OpenAI, então usamos o ChatOpenAI apontando para ela
const modelo = new ChatOpenAI({
	model: "glm-5.3",
	apiKey: process.env.OLLAMA_API_KEY,
	configuration: { baseURL: "https://ollama.com/v1" },
	timeout: 120_000,
}).bindTools([
	// bindTools: entrega ao modelo o "cardápio" de ferramentas. Ele só PEDE; quem executa é o nó "ferramentas"
	{
		type: "function",
		function: {
			name: "buscar_voos",
			description: "Pesquisa voos reais só de ida no Google Flights, para um trecho e um dia.",
			parameters: {
				type: "object",
				properties: {
					origem: { type: "string", description: "Código do aeroporto de origem, como GRU" },
					destino: { type: "string", description: "Código do aeroporto de destino, como LIS" },
					data: { type: "string", description: "Data no formato AAAA-MM-DD" },
				},
				required: ["origem", "destino", "data"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "criar_planilha",
			description: "Cria uma planilha no Google Sheets com todos os voos pesquisados desde a última planilha e devolve o link.",
			parameters: {
				type: "object",
				properties: {
					titulo: { type: "string", description: "Título da planilha, como Passagens GRU para Lisboa" },
				},
				required: ["titulo"],
			},
		},
	},
]);

function instrucoes() {
	const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });    // "sv-SE" escreve AAAA-MM-DD
	return `Você é o assistente de passagens aéreas do Gabriel, e conversa com ele pelo Slack. Hoje é ${hoje}.
Responda curto e direto, no mesmo idioma em que ele escrever.
Nunca invente preços, horários ou companhias: use só o que vier da ferramenta buscar_voos.
Quando ele pedir voos, chame buscar_voos uma vez para cada combinação de trecho e dia.
Quando terminar as pesquisas de um pedido, chame criar_planilha uma vez e mande o link na resposta.
Para negrito, use *um asterisco de cada lado* (é o formato do Slack).`;
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

// ---------- NÓ: MODELO ----------
async function noModelo(estado: typeof Estado.State) {
	const resposta = await modelo.invoke([new SystemMessage(instrucoes()), ...cortarHistorico(estado.messages)]);
	return { messages: [resposta] };
}

// ---------- NÓ: FERRAMENTAS ----------
// o que o modelo lê: os 10 mais baratos, para a carta não ficar enorme (a planilha recebe todos)
function resumirParaOModelo(voos: Voo[]) {
	if (voos.length === 0) return "Nenhum voo encontrado.";
	const linhas = voos.slice(0, 10).map((voo) => `R$ ${voo.preco} | ${voo.companhia} | ${voo.escalas} escala(s) | ${voo.duracao_min} min | sai ${voo.saida} | chega ${voo.chegada}`);
	return `${voos.length} voos, os mais baratos:\n${linhas.join("\n")}\nComprar: ${voos[0].link}`;
}

async function noFerramentas(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	const respostas = [];
	let voos = estado.voos;

	for (const chamada of ultima.tool_calls ?? []) {
		let resultado;
		try {
			if (chamada.name === "buscar_voos") {
				const { origem, destino, data } = chamada.args;
				const novos = await buscarVoos(origem, destino, data);
				// se o mesmo trecho for pesquisado de novo, ficam só os preços mais recentes
				const outrosTrechos = voos.filter((voo) => voo.origem !== origem || voo.destino !== destino || voo.data !== data);
				voos = [...outrosTrechos, ...novos];
				resultado = resumirParaOModelo(novos);
			} else if (chamada.name === "criar_planilha") {
				if (voos.length === 0) {
					resultado = "Não há voos novos para colocar numa planilha. Pesquise antes.";
				} else {
					resultado = "Planilha criada: " + (await criarPlanilha(chamada.args.titulo, voos));
					voos = [];
				}
			} else {
				resultado = "Essa ferramenta não existe: " + chamada.name;
			}
		} catch (erro: any) {
			// o erro volta para o modelo como texto: assim ele pode explicar ou tentar de outro jeito
			resultado = "Erro: " + erro.message;
		}
		console.log(`[ferramenta] ${chamada.name} ${JSON.stringify(chamada.args)} -> ${resultado.split("\n")[0]}`);
		respostas.push(new ToolMessage({ tool_call_id: chamada.id!, content: resultado }));
	}
	return { messages: respostas, voos };
}

// ---------- ARESTA CONDICIONAL ----------
// a decisão do caminho: se o modelo pediu ferramenta, vai para "ferramentas"; se não, terminou
function proximoPasso(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	return ultima.tool_calls?.length ? "ferramentas" : END;
}

// ---------- GRAFO ----------
// o SqliteSaver guarda a pasta num arquivo depois de cada nó: é a memória que sobrevive ao Ctrl+C
const memoria = SqliteSaver.fromConnString(import.meta.dirname + "/memoria.sqlite");

const grafo = new StateGraph(Estado)
	.addNode("modelo", noModelo)
	.addNode("ferramentas", noFerramentas)
	.addEdge(START, "modelo")
	.addConditionalEdges("modelo", proximoPasso, ["ferramentas", END])
	.addEdge("ferramentas", "modelo")
	.compile({ checkpointer: memoria });

// ---------- RESPONDER ----------
// conversa: o identificador da conversa (no Slack, o canal). Cada um tem a sua pasta separada no arquivo.
export async function responder(conversa: string, texto: string): Promise<string> {
	const config = { configurable: { thread_id: conversa } };

	// se o bot caiu no meio de um pedido, primeiro terminamos esse pedido de onde ele parou,
	// e a resposta dele vai junto (ela pode trazer o link de uma planilha)
	let respostaAtrasada = "";
	const anterior = await grafo.getState(config);
	if (anterior.next.length > 0) {
		const retomado = await grafo.invoke(null, config);
		respostaAtrasada = retomado.messages.at(-1)?.text + "\n\n";
	}

	const final = await grafo.invoke({ messages: [new HumanMessage(texto)] }, config);
	return respostaAtrasada + (final.messages.at(-1)?.text || "Não consegui escrever uma resposta. Pode repetir o pedido?");
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	const pergunta = process.argv[2];
	if (pergunta) {
		console.log(await responder("terminal", pergunta));
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
