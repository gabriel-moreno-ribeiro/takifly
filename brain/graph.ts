// brain/graph.ts - o cérebro do bot, montado como um grafo do LangGraph
//
// O caminho do grafo:
//
//   START → preparar → contexto → orquestrador ⇄ especialistas do plano, um de cada vez
//                                 orquestrador → plano acabou → conferir → redator → verificar
//                                              → ninguém trabalhou ("oi", "tudo bem?") → situacao → redator → verificar
//
//   contexto (agente de contexto): quando 20 mensagens saíram da janela de 40, o modelo barato atualiza o resumo
//     e resumoLimpo() tira preço, horário e link. O resumo vai nas instruções do orquestrador, especialistas e redator
//   especialistas (memoria, monitor, pesquisador, analista, guia): cada um repete "modelo ⇄ ferramentas" até terminar a sua tarefa
//     e volta ao orquestrador. "pronto" só vale se terminou() confirmar no código que uma ferramenta da tarefa respondeu.
//   orquestrador: chama o modelo no começo do pedido e quando alguém volta sem terminar (refaz o plano, até 2 vezes);
//     quem volta tendo terminado só libera o próximo do plano, sem chamada de modelo
//   conferir: código, sem IA. Vê visto, passaporte, vacina e menor de idade, e deixa o problema como recado
//   situacao: código, sem IA. Junta o que está em andamento (monitoramentos, pesquisas recentes) para o redator
//   verificar → aprovou → planilha → lembrar → END
//             → recusou → volta para redator (até 2 vezes)
//             → recusou de novo → emergencia → planilha → lembrar → END
//   planilha: código. Uma planilha por par de cidades da conversa (GRU→GIG e SDU→VCP são a mesma), reescrita a cada
//     pesquisa nova do par e com no máximo 100 voos; o link fica na tabela planilhas do dados.sqlite
//   lembrar (agente de memória): com pista na mensagem ("moro", "prefiro") e sem o especialista memoria no pedido,
//     o modelo barato propõe fatos que duram e fatosParaGuardar() decide o que entra nas preferências
//
// Usam IA: orquestrador e redator (modelo forte); especialistas, lembrar e contexto (modelo barato). O resto é código.
//
// Para perguntar pelo terminal:   DADOS=:memory: MEMORIA=:memory: node brain/graph.ts "voos de GRU para LIS em 12/12"
// Para gerar o desenho:           DADOS=:memory: MEMORIA=:memory: node brain/graph.ts       (depois: open brain/graph.html)
// (sem DADOS e MEMORIA, ele abre os bancos do bot em uso, em data/)
// Para ver ao vivo:               com o bot ligado, http://localhost:4500 (brain/live.ts; o desenho de lá é brain/live.html)

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, type LangGraphRunnableConfig, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";

import { AGENTES, INSTRUCOES_DO_RESUMO, instrucoesDaMemoria, instrucoesDoOrquestrador, instrucoesDoRedator, Lembrete, type NomeDoAgente, Plano, planoValido } from "./agents.ts";
import { apagarPreferencia, type Dossie, guardarPlanilhaDoPar, guardarPreferencia, lerDossie, lerPlanilhaDoPar, listarMonitoramentos, listarPreferencias } from "../storage/database.ts";
import { type Caderno, conferirNoRegistro, descreverMonitoramento, descreverVoo, LIMITE_DE_PREFERENCIAS, limparArgumentos, avisosDaBusca, servicos } from "./tools.ts";
import { cidadeDoAeroporto, nomeDaCidade, semAcento } from "../rules/airports.ts";
import { conferirViagem, paisDoAeroporto, type Trecho, type Viagem } from "../rules/rules.ts";
import { anotar, rastrear } from "./tracing.ts";
import { anotarNoPainel, ouvinteAoVivo } from "./live.ts";
import { nomesDosModelos, rotuloDosModelos } from "./models.ts";
import { arrumarParaSlack, escreveuChamada, prometeuSemFazer, RESPOSTA_QUE_NAO_SAIU, verificarResposta } from "./checker.ts";
import { REGRA_DO_CUSTO_BENEFICIO, type Voo } from "../sources/flights.ts";
import { hojeEmSaoPaulo } from "../rules/dates.ts";
import { abasDaPesquisa, horas } from "../sources/spreadsheet.ts";

// ---------- CHAVES ----------
// sem .env (worktree nova, CI), as chaves vêm do ambiente: os testes não precisam delas
if (existsSync(import.meta.dirname + "/../.env")) process.loadEnvFile(import.meta.dirname + "/../.env");

// ---------- LIMITES ----------
const PASSOS_POR_AGENTE = 6;      // quantas vezes um especialista pode ser chamado em um pedido
const PASSOS_POR_PEDIDO = 14;     // quantas vezes os especialistas, somados, podem ser chamados em um pedido
const LIMITE_DE_TENTATIVAS = 2;   // quantas respostas recusadas o redator pode corrigir
const LIMITE_DE_REPLANOS = 2;     // quantas vezes o orquestrador pode refazer o plano num pedido, quando alguém volta sem terminar
const JANELA = 40;                // quantas mensagens recentes vão para os modelos
const LOTE_DO_RESUMO = 20;        // quantas mensagens precisam sair da janela para o agente de contexto resumir de novo
const VALIDADE_DOS_PRECOS = 6 * 60 * 60 * 1000;    // 6 horas: depois disso, preço pesquisado não vale mais

// ---------- ESTADO ----------
// a "pasta" que passa pelas etapas. Nestes campos, o valor novo substitui o antigo.
function campo<T>(inicial: T) {
	return Annotation<T>({ reducer: (_antigo, novo) => novo, default: () => inicial });
}

const Estado = Annotation.Root({
	...MessagesAnnotation.spec,          // o campo "messages": a conversa (mensagens novas são somadas às antigas)
	voos: campo<Voo[]>([]),              // tudo o que foi pesquisado e ainda vale: as ferramentas de análise leem daqui
	novos: campo<Voo[]>([]),             // os voos que ainda não foram para uma planilha
	pesquisadoEm: campo(0),              // quando foi a última pesquisa
	buscas: campo<string[]>([]),         // as buscas feitas neste pedido
	plano: campo<NomeDoAgente[]>([]),    // os especialistas que ainda vão trabalhar neste pedido, o primeiro é o atual
	idioma: campo(""),                   // em que idioma a resposta sai
	recados: campo<string[]>([]),        // o que os especialistas deixaram para o redator
	passos: campo(0),                    // quantas vezes os especialistas foram chamados neste pedido
	passosDoAgente: campo(0),            // quantas vezes o especialista atual foi chamado
	tentativas: campo(0),                // quantas respostas o verificador já recusou neste pedido
	correcao: campo(""),                 // o bilhete para o próximo modelo. Fica fora da conversa, então não suja a memória.
	convidou: campo(false),              // já convidou a pessoa a contar os documentos: o convite sai uma vez por conversa
	feitos: campo<string[]>([]),         // cada especialista que voltou ao orquestrador neste pedido: "pesquisador: terminou" ou o que faltou
	replanos: campo(0),                  // quantas vezes o orquestrador refez o plano neste pedido
	resumo: campo(""),                   // o que o agente de contexto guardou das mensagens que já saíram da janela (vale para a conversa toda)
	resumoAte: campo(0),                 // até que mensagem o resumo já cobre
});

// ---------- MODELOS ----------
// quem faz cada papel, e por quê, está em models.ts.
// A Ollama Cloud entende o mesmo formato da OpenAI, então usamos o ChatOpenAI apontando para ela
function criarModelo(nome: string) {
	return new ChatOpenAI({ model: nome, apiKey: process.env.OLLAMA_API_KEY, configuration: { baseURL: "https://ollama.com/v1" }, timeout: 120_000 });
}

// um objeto, e não duas constantes: os testes trocam os dois por modelos falsos, como fazem com servicos.buscarVoos
const nomes = nomesDosModelos();
export const modelos: { forte: BaseChatModel; especialista: BaseChatModel } = {
	forte: criarModelo(nomes.forte),
	especialista: criarModelo(nomes.especialista),
};

// ---------- HISTÓRICO ----------
// a conversa fica guardada para sempre, mas só mandamos as mensagens recentes (cada carta custa dinheiro).
// O corte começa numa mensagem do usuário: uma resposta de ferramenta sem o pedido dela daria erro no modelo.
export function cortarHistorico(mensagens: BaseMessage[], limite = JANELA) {
	const ehDoUsuario = (mensagem: BaseMessage) => mensagem.getType() === "human";
	let inicio = mensagens.findIndex((mensagem, i) => i >= mensagens.length - limite && ehDoUsuario(mensagem));
	if (inicio === -1) inicio = mensagens.findLastIndex(ehDoUsuario);    // uma única rodada maior que o limite
	return mensagens.slice(inicio);
}

// dos pedidos antigos, ficam só as perguntas e as respostas: menos texto para um modelo fraco se perder
export function historicoLimpo(mensagens: BaseMessage[]) {
	const cortado = cortarHistorico(mensagens);
	const inicioDoPedido = cortado.findLastIndex((mensagem) => mensagem.getType() === "human");
	return cortado.filter((mensagem, i) => {
		if (i >= inicioDoPedido || mensagem.getType() === "human") return true;
		return mensagem.getType() === "ai" && !(mensagem as AIMessage).tool_calls?.length;
	});
}

function textosDoUsuario(mensagens: BaseMessage[]) {
	return cortarHistorico(mensagens).filter((mensagem) => mensagem.getType() === "human").map((mensagem) => mensagem.text);
}

function conversaDe(config?: LangGraphRunnableConfig) {
	return String(config?.configurable?.thread_id ?? "");
}

function preferenciasDe(config?: LangGraphRunnableConfig) {
	return listarPreferencias(conversaDe(config)).map((preferencia) => preferencia.texto);
}

// a Ollama devolve ids como "chatcmpl-283", que se repetem. Para o LangGraph, mesmo id quer dizer
// "substitua a mensagem antiga": sem um id novo, a resposta apagaria outra mensagem da conversa.
export function comIdNovo(resposta: AIMessage) {
	resposta.id = randomUUID();
	return resposta;
}

// ---------- NÓ: PREPARAR ----------
// todo pedido novo começa com os contadores zerados, e preço velho não vale mais
function noPreparar(estado: typeof Estado.State) {
	const velhos = Date.now() - estado.pesquisadoEm > VALIDADE_DOS_PRECOS;
	return {
		plano: [],
		idioma: "",
		recados: [],
		passos: 0,
		passosDoAgente: 0,
		tentativas: 0,
		correcao: "",
		buscas: [],
		feitos: [],
		replanos: 0,
		voos: velhos ? [] : estado.voos,
		novos: velhos ? [] : estado.novos,
	};
}

// ---------- NÓ: CONTEXTO (o agente de contexto) ----------
// Só as últimas 40 mensagens vão para os modelos, e cada busca gasta 3 ou 4 delas com ferramenta: o bot lembrava
// de uns 5 pedidos. Assim que uma mensagem sai da janela sem estar no resumo, o modelo barato junta o resumo antigo
// com as perguntas e respostas que saíram e com as 20 seguintes, que vão sair logo (sem passar do pedido de agora).
// Nada fica no buraco entre o resumo e a janela, e a próxima chamada só vem depois de mais 20 mensagens:
// uma chamada barata a cada vários pedidos, nunca uma por mensagem. O código limpa o que o modelo escreveu.
export async function noContexto(estado: typeof Estado.State) {
	const inicioDaJanela = estado.messages.length - cortarHistorico(estado.messages).length;
	if (inicioDaJanela <= estado.resumoAte) return {};

	// uma conversa de antes deste nó existir tem centenas de mensagens fora da janela: o primeiro resumo lê só as 60
	// mais recentes delas, para a carta não ficar enorme. O que é mais antigo que isso fica esquecido.
	const desde = Math.max(estado.resumoAte, inicioDaJanela - 3 * LOTE_DO_RESUMO);
	const ate = Math.min(inicioDaJanela + LOTE_DO_RESUMO, estado.messages.findLastIndex((mensagem) => mensagem.getType() === "human"));
	const saindo = estado.messages.slice(desde, ate)
		.filter((mensagem) => mensagem.getType() === "human" || (mensagem.getType() === "ai" && !(mensagem as AIMessage).tool_calls?.length))
		.map((mensagem) => `${mensagem.getType() === "human" ? "Pessoa" : "Bot"}: ${mensagem.text.slice(0, 500)}`);
	try {
		const resposta = await modelos.especialista.invoke([
			new SystemMessage(INSTRUCOES_DO_RESUMO),
			new HumanMessage(`Resumo de antes: ${estado.resumo || "nenhum"}\n\nConversa que vai sair da memória:\n${saindo.join("\n")}`),
		]);
		return { resumo: resumoLimpo(resposta.text), resumoAte: ate };
	} catch (erro: any) {
		// sem resumo o bot responde igual, só esquece mais cedo: o pedido nunca para por causa dele
		console.log(`[contexto] não resumiu: ${erro.message}`);
		return {};
	}
}

// o resumo é texto de modelo e não pode virar "fato": frase com valor (em qualquer moeda), horário, duração, link
// ou documento sai inteira. Documento mora no dossiê, não em texto que vai para todos os prompts e para o Langfuse.
const FORA_DO_RESUMO = /\$|€|£|\b(reais|real|euros?|dolar|dolares|libras?)\b|\d{1,3}(?:\.\d{3})+|\d{1,2}\s*(?::|h)\s*\d{2}|\d+\s*(?:horas?|min)\b|https?:\/\/|passaporte|nascimento|nasceu|vacina|visto|\bcpf\b|\brg\b/i;

export function resumoLimpo(texto: string) {
	const frases = texto.split(/(?<=[.!?])\s+|\n+/);
	return frases.filter((frase) => !FORA_DO_RESUMO.test(semAcento(frase))).join(" ").trim().slice(0, 800);
}

// ---------- NÓ: LEMBRAR (o agente de memória) ----------
// O especialista memoria só guarda quando a pessoa pede ("lembra disso"). Este nó pega o que ela conta de passagem
// ("moro em Recife, quero ir a Lisboa"). Sem pista na mensagem, não gasta chamada; com pista, o modelo barato
// propõe e o código decide o que entra. O que for guardado aparece nas próximas mensagens como "Preferências guardadas".
// Roda no fim do pedido: se o especialista memoria trabalhou nele, a mensagem já foi cuidada, e guardar de novo
// deixaria duas cópias (um "esquece isso" depois apagaria só uma).
// Cada forma de fato e a pista em primeira pessoa que precisa estar na mensagem: "mora" só com "moro".
// Assim "minha sogra mora em Portugal" não vira um fato sobre a pessoa, e "nunca fui a Lisboa" nem chama o modelo.
const FORMAS_DE_FATO: [fato: RegExp, pista: RegExp][] = [
	[/^mora\b/, /\b(moro|morando)\b/],
	[/^vive\b/, /\bvivo\b/],
	[/^(e|sai) de\b/, /\b(sou|saio) de\b/],
	[/^prefere\b/, /\bprefiro\b/],
	[/^evita\b/, /\bevito\b/],
	[/^nao gosta\b/, /\bnao gosto\b/],
	[/^gosta\b/, /\bgosto\b/],
	[/^(odeia|detesta)\b/, /\b(odeio|detesto)\b/],
	[/^costuma\b/, /\bcostumo\b/],
	[/^viaja com\b/, /\bviajo com\b/],
	[/^(sempre|nunca) \w+/, /\b(sempre|nunca) (viajo|voo|prefiro|saio|pego|escolho|compro|sento|vou)\b/],
];
const PEDIU_PARA_LEMBRAR = /\b(lembr|guard|anot|memoriz|esquec|apag)/;    // pedido explícito é do especialista memoria
// saúde, religião e afins só são guardados quando a pessoa pede, pelo especialista memoria: nunca de passagem
const ASSUNTO_SENSIVEL = /diabet|insulin|doen[cç]|remedio|medicament|gravid|gestante|deficien|cadeirante|mobilidade|autis|religi|igreja|judeu|judia|muculman|orientacao sexual|hiv|cancer|depress|ansiedade|alergi|vegan|vegetarian/;

// a mensagem que vale mandar ao agente de memória: tem pista em primeira pessoa, não é pedido explícito (esse é do
// especialista memoria) e não fala de assunto sensível. O compactar e o excluir (brain/context.ts) usam a mesma regra
export function podeLembrar(mensagem: string) {
	const normal = semAcento(mensagem).toLowerCase();
	return FORMAS_DE_FATO.some(([, pista]) => pista.test(normal)) && !PEDIU_PARA_LEMBRAR.test(normal) && !ASSUNTO_SENSIVEL.test(normal);
}

export async function noLembrar(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	if (estado.feitos.some((feito) => feito.startsWith("memoria:"))) return {};
	const mensagem = estado.messages.findLast((mensagem) => mensagem.getType() === "human")?.text ?? "";
	if (!podeLembrar(mensagem)) return {};

	const conversa = conversaDe(config);
	const guardadas = listarPreferencias(conversa);
	try {
		const memoria = modelos.especialista.withStructuredOutput(Lembrete, { name: "lembrar", method: "functionCalling" });
		const proposta = await memoria.invoke([new SystemMessage(instrucoesDaMemoria(guardadas.map((preferencia) => preferencia.texto))), new HumanMessage(mensagem)]);
		const { novos, velhos } = fatosParaGuardar(proposta, guardadas, mensagem);
		for (const velho of velhos) apagarPreferencia(conversa, velho.id);
		for (const fato of novos) guardarPreferencia(conversa, fato);
		if (novos.length > 0) console.log(`[lembrar] guardou: ${novos.join("; ")}${velhos.length > 0 ? ` (no lugar de: ${velhos.map((velho) => velho.texto).join("; ")})` : ""}`);
	} catch (erro: any) {
		// sem memória nova o pedido segue igual: este nó nunca derruba uma resposta
		console.log(`[lembrar] não guardou: ${erro.message}`);
	}
	return {};
}

// A conferência do agente de memória: o modelo propõe, o código decide. Entra o fato que:
//   - começa com uma forma de FORMAS_DE_FATO, e a mensagem tem a pista dela ("vai a Lisboa" é o pedido de agora, não um fato);
//   - tirando o verbo, só tem palavras que a pessoa escreveu (nada de completar com o que ela não disse);
//   - não tem número nem valor, nem assunto sensível, e cabe em 120 letras;
//   - não repete o que já está guardado.
// Trocar só vale junto com um fato novo e só o que está guardado com o mesmo texto: apagar sozinho continua
// com o especialista memoria, quando a pessoa pede.
export function fatosParaGuardar(proposta: { guardar: string[]; trocar: string[] }, guardadas: { id: number; texto: string }[], mensagem: string) {
	const normal = (texto: string) => semAcento(texto).toLowerCase().trim();
	// palavras de 4 letras ou mais, sem o "s" do plural: "diretos" e "direto" contam como a mesma
	const palavras = (texto: string) => (normal(texto).match(/[a-z]+/g) ?? []).map((palavra) => palavra.replace(/s$/, "")).filter((palavra) => palavra.length >= 4);
	const daPessoa = new Set(palavras(mensagem));
	const jaTem = new Set(guardadas.map((preferencia) => normal(preferencia.texto)));
	const novos: string[] = [];
	for (const fato of proposta.guardar.map((texto) => texto.trim())) {
		const forma = FORMAS_DE_FATO.find(([doFato]) => doFato.test(normal(fato)));
		const resto = forma ? palavras(normal(fato).replace(forma[0], "")) : [];
		const ancorado = forma !== undefined && forma[1].test(normal(mensagem)) && resto.length > 0 && resto.every((palavra) => daPessoa.has(palavra));
		const temValor = /\d|\b(reais|real|euros?|dolar|dolares)\b/.test(normal(fato));
		if (fato.length > 120 || temValor || ASSUNTO_SENSIVEL.test(normal(fato)) || !ancorado || jaTem.has(normal(fato))) continue;
		jaTem.add(normal(fato));
		novos.push(fato);
	}
	const velhos = novos.length > 0 ? guardadas.filter((preferencia) => proposta.trocar.some((texto) => normal(texto) === normal(preferencia.texto))) : [];
	const vagas = LIMITE_DE_PREFERENCIAS - (guardadas.length - velhos.length);
	return { novos: novos.slice(0, Math.max(0, vagas)), velhos };
}

// o resumo entra nas instruções, nunca na conversa: assim não conta como fala da pessoa nem como fato para o verificador
function comResumo(instrucoes: string, estado: typeof Estado.State) {
	if (!estado.resumo) return instrucoes;
	return `${instrucoes}\n\nResumo da conversa mais antiga (não traz preço nem horário, e para pesquisar a data precisa estar no pedido): ${estado.resumo}`;
}

// ---------- NÓ: ORQUESTRADOR ----------
// O centro do pedido: monta o plano, e todo especialista volta para cá quando acaba. Nada daqui entra na conversa.
// O modelo só é chamado quando há o que decidir: no começo do pedido e quando alguém volta sem terminar.
// Quem volta com a tarefa cumprida (terminou, conferido por código) só libera o próximo do plano, de graça.
// method "functionCalling": na Ollama Cloud o glm-5.3 ignora o "jsonSchema" (o padrão) e devolve lista solta ou texto;
// no teste de 03/11 foram 4 de 4 certos assim, contra 1 de 4 (e ~115 s cada) com o padrão.
async function noOrquestrador(estado: typeof Estado.State) {
	const ultimo = estado.feitos.at(-1);
	if (ultimo && VOLTOU_RESOLVIDO.test(ultimo)) return {};
	// voltou sem terminar, mas o pedido já gastou o que podia: segue para o conferir com o que tem
	if (ultimo && (estado.replanos >= LIMITE_DE_REPLANOS || estado.passos >= PASSOS_POR_PEDIDO)) return { plano: [] };

	const carta = [new SystemMessage(comResumo(instrucoesDoOrquestrador(estado.voos.length > 0, estado.feitos), estado)), ...historicoLimpo(estado.messages)];
	const orquestrador = modelos.forte.withStructuredOutput(Plano, { name: "definir_plano", method: "functionCalling" });
	// ao refazer o plano, o glm-5.3 às vezes responde em texto, sem o plano (prova de 08/11, 2 casos): vem vazio
	// ou com o erro "No tool calls found". Em vez de derrubar o pedido, segue para o conferir com o que já tem,
	// como no limite de replanos. No começo do pedido não há com o que responder: o erro sobe e o retryPolicy tenta de novo
	const resposta = await orquestrador.invoke(carta).catch((erro) => {
		if (!ultimo) throw erro;
		return undefined;
	});
	if (!resposta && ultimo) {
		console.log(`[orquestrador] não devolveu plano depois de "${ultimo}": vai responder com o que tem`);
		return { plano: [], replanos: estado.replanos + 1 };
	}
	if (!resposta) throw new Error("o orquestrador não devolveu o plano");
	// o zod já garantiu o formato; o código tira nome repetido e põe na ordem certa, não chama de novo quem já
	// resolveu a sua parte e não deixa ninguém trabalhar uma terceira vez
	const vezes = (nome: string) => estado.feitos.filter((feito) => feito.startsWith(nome + ":")).length;
	const resolveu = (nome: string) => estado.feitos.some((feito) => feito.startsWith(nome + ":") && VOLTOU_RESOLVIDO.test(feito));
	const plano = planoValido(resposta.agentes).filter((nome) => vezes(nome) < 2 && !resolveu(nome));
	if (!ultimo) return { plano, idioma: resposta.idioma };
	console.log(`[orquestrador] refez o plano depois de "${ultimo}": ${plano.join(", ") || "ninguém, vai responder"}`);
	return { plano, replanos: estado.replanos + 1 };
}

// as mensagens deste pedido: da última mensagem do usuário em diante
function mensagensDoPedido(mensagens: BaseMessage[]) {
	return mensagens.slice(mensagens.findLastIndex((mensagem) => mensagem.getType() === "human"));
}

// ---------- O QUE CONTA COMO FATO ----------
// só o retorno de uma ferramenta, mais o que já está pesquisado. Serve ao verificador e ao recado.
// O texto das páginas da internet fica à parte (textoDaWeb): ele não pode provar preço em R$.
function respostasDasFerramentas(estado: typeof Estado.State, daWeb: boolean) {
	const pedido = mensagensDoPedido(estado.messages);
	const naWeb = new Set(pedido.flatMap((mensagem) => ((mensagem as AIMessage).tool_calls ?? []).filter((chamada) => chamada.name === "buscar_na_web").map((chamada) => chamada.id)));
	return pedido.filter((mensagem) => mensagem.getType() === "tool" && naWeb.has((mensagem as ToolMessage).tool_call_id) === daWeb).map((mensagem) => mensagem.text);
}

function fatosDoPedido(estado: typeof Estado.State) {
	return [...respostasDasFerramentas(estado, false), ...estado.voos.map(descreverVoo), REGRA_DO_CUSTO_BENEFICIO].join("\n");
}

function textoDaWeb(estado: typeof Estado.State) {
	return respostasDasFerramentas(estado, true).join("\n");
}

// os links que valem: os que vieram de ferramenta, de mensagem do bot (como a planilha) ou de voo pesquisado.
// Link escrito pelo usuário não vale: senão um link de golpe passaria. Da internet, só vale o endereço da própria
// página achada: o texto dela chega sem link nenhum (sources/web.ts).
function linksDaConversa(mensagens: BaseMessage[], voos: Voo[]) {
	return [...mensagens.filter((mensagem) => mensagem.getType() !== "human").map((mensagem) => mensagem.text), ...voos.map((voo) => voo.link)].join("\n");
}

// o recado do especialista vai inteiro para as instruções do redator, e o verificador só olha a resposta
// final: sem isto, um preço inventado na nota de um especialista vira fato na boca do redator.
function recadoConferido(nome: string, recado: string, estado: typeof Estado.State) {
	const fatos = fatosDoPedido(estado);
	const problemas = verificarResposta(recado, fatos, linksDaConversa(estado.messages, estado.voos), textosDoUsuario(estado.messages).join("\n"), textoDaWeb(estado));
	if (problemas.length === 0) return recado;
	console.log(`[${nome}] recado recusado: ${problemas.join(" / ")}`);
	return "não terminou: a nota deste especialista trouxe dado que não veio de ferramenta, e foi descartada";
}

// ---------- A TAREFA CUMPRIDA ----------
// dizer "pronto" não basta: o código confere se, neste pedido, uma ferramenta da tarefa do especialista
// respondeu sem erro. Listar aeroportos ou ver o dia da semana ajuda, mas não é pesquisar.
const FERRAMENTAS_DA_TAREFA: Partial<Record<NomeDoAgente, string[]>> = { pesquisador: ["buscar_voos", "buscar_hoteis"] };

// as respostas que as ferramentas da tarefa deste especialista deram neste pedido
function respostasDaTarefa(nome: NomeDoAgente, mensagens: BaseMessage[]) {
	const daTarefa = FERRAMENTAS_DA_TAREFA[nome] ?? AGENTES[nome].ferramentas.map((ferramenta) => ferramenta.name);
	const pedido = mensagensDoPedido(mensagens);
	const chamadas = new Set(pedido.flatMap((mensagem) => ((mensagem as AIMessage).tool_calls ?? []).filter((chamada) => daTarefa.includes(chamada.name)).map((chamada) => chamada.id)));
	return pedido.filter((mensagem) => mensagem.getType() === "tool" && chamadas.has((mensagem as ToolMessage).tool_call_id));
}

export function terminou(nome: NomeDoAgente, mensagens: BaseMessage[]) {
	return respostasDaTarefa(nome, mensagens).some((resposta) => !resposta.text.startsWith("Erro:"));
}

// Como o especialista voltou, decidido pelo código e não pelo que ele escreveu:
//   "terminou": uma ferramenta da tarefa deu resultado. O orquestrador só libera o próximo.
//   "a ferramenta recusou": tentou, e todas deram Erro ("só pesquiso até 9 pessoas: pergunte"). O Erro já diz
//     ao redator o que perguntar, então ninguém insiste e o orquestrador também só libera o próximo.
//   qualquer outra coisa (o "faltou a data" que ele escreveu): o orquestrador refaz o plano.
function comoVoltou(nome: NomeDoAgente, estado: typeof Estado.State, recado: string) {
	const respostas = respostasDaTarefa(nome, estado.messages);
	if (respostas.some((resposta) => !resposta.text.startsWith("Erro:"))) return "terminou";
	if (respostas.length > 0) return "a ferramenta recusou";
	return recado || "não fez nada";
}
const VOLTOU_RESOLVIDO = /: (terminou|a ferramenta recusou)$/;

// "Pronto!", "*pronto*" e "Done." também: o modelo escreve de vários jeitos
const ehPronto = (texto: string) => /^[\s*_.!]*(pronto|feito|done)[\s*_.!]*$/i.test(texto);

// ---------- NÓS: ESPECIALISTAS ----------
// todo especialista funciona igual: lê o pedido, chama as suas ferramentas e, quando termina, deixa um recado,
// sai do plano e volta ao orquestrador contando como foi (comoVoltou)
function criarEspecialista(nome: NomeDoAgente) {
	const { ferramentas, instrucoes } = AGENTES[nome];

	return async (estado: typeof Estado.State, config: LangGraphRunnableConfig) => {
		const sair = (recado: string) => {
			const conferido = recado.trim() && !ehPronto(recado) ? recadoConferido(nome, recado, estado) : "";
			const situacao = comoVoltou(nome, estado, conferido);
			// terminou numa segunda vez: o "faltou" da primeira já não vale, e o redator não pode perguntar o que já foi resolvido
			const anteriores = situacao === "terminou" ? estado.recados.filter((anterior) => !anterior.startsWith(nome + ":")) : estado.recados;
			return {
				plano: estado.plano.slice(1),
				passosDoAgente: 0,
				correcao: "",
				recados: conferido ? [...anteriores, `${nome}: ${conferido}`] : anteriores,
				feitos: [...estado.feitos, `${nome}: ${situacao}`],
			};
		};
		if (estado.passosDoAgente >= PASSOS_POR_AGENTE || estado.passos >= PASSOS_POR_PEDIDO) return sair("não terminou: chegou ao limite de passos");

		const preferencias = preferenciasDe(config);
		const guardadas = preferencias.length > 0 ? `\nPreferências guardadas: ${preferencias.join("; ")}.` : "";
		const carta: BaseMessage[] = [new SystemMessage(comResumo(instrucoes() + guardadas, estado)), ...historicoLimpo(estado.messages)];
		if (estado.correcao) carta.push(new HumanMessage(estado.correcao));

		const resposta = await modelos.especialista.bindTools!(ferramentas).invoke(carta);
		const contagem = { passos: estado.passos + 1, passosDoAgente: estado.passosDoAgente + 1 };
		if (resposta.tool_calls?.length) return { messages: [comIdNovo(resposta)], ...contagem, correcao: "" };

		// modelo fraco às vezes quebra a chamada, escreve a chamada como texto ou só promete: ele tem outra chance
		const texto = arrumarParaSlack(resposta.text);
		if (resposta.invalid_tool_calls?.length || escreveuChamada(texto) || prometeuSemFazer(texto)) {
			console.log(`[${nome}] não chamou a ferramenta direito: ${texto.slice(0, 100)}`);
			return { ...contagem, correcao: "Você não chamou a ferramenta do jeito certo. Chame a ferramenta agora, ou escreva o que faltou." };
		}
		// "pronto" (ou nada) sem nem ter tentado a tarefa é a mesma promessa vazia, dita de outro jeito: ele volta para fazer.
		// Se tentou e a ferramenta recusou, não insiste: mandar chamar de novo empurraria o modelo a contornar a regra
		if ((ehPronto(texto) || !texto.trim()) && respostasDaTarefa(nome, estado.messages).length === 0) {
			console.log(`[${nome}] disse pronto sem ter feito a tarefa`);
			return { ...contagem, correcao: "Você escreveu \"pronto\", mas não chamou nenhuma ferramenta da sua tarefa neste pedido. Chame a ferramenta agora, ou escreva em uma frase o que faltou." };
		}
		return { ...sair(texto), ...contagem, passosDoAgente: 0 };
	};
}

// ---------- NÓ: FERRAMENTAS ----------
// quantas vezes cada ferramenta já foi chamada neste pedido: as chamadas desde a última mensagem do usuário
function chamadasDoPedido(mensagens: BaseMessage[]) {
	const contagem: Record<string, number> = {};
	for (const mensagem of mensagensDoPedido(mensagens)) {
		for (const chamada of (mensagem as AIMessage).tool_calls ?? []) contagem[chamada.name] = (contagem[chamada.name] ?? 0) + 1;
	}
	return contagem;
}

// um pedido de cada vez, na ordem: várias buscas ao mesmo tempo no Google poderiam levar a um bloqueio
export async function noFerramentas(estado: typeof Estado.State, config?: LangGraphRunnableConfig) {
	const ultima = estado.messages.at(-1) as AIMessage;
	// buscas é uma cópia: as ferramentas escrevem nela, e o Estado original não pode mudar antes do fim do nó
	const caderno: Caderno = {
		voos: estado.voos,
		novos: estado.novos,
		buscas: [...estado.buscas],
		textosDoUsuario: textosDoUsuario(estado.messages),
		preferencias: preferenciasDe(config),
		conversa: conversaDe(config),
	};
	const usadas = chamadasDoPedido(estado.messages.slice(0, -1));
	const respostas = [];

	for (const chamada of ultima.tool_calls ?? []) {
		let resultado: string;
		try {
			// o registro confere se a ferramenta é deste agente, se está ligada e se ainda cabe no limite do pedido
			const ferramenta: any = conferirNoRegistro(estado.plano[0], chamada.name, usadas[chamada.name] ?? 0);
			usadas[chamada.name] = (usadas[chamada.name] ?? 0) + 1;
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

// ---------- NÓ: CONFERIR AS REGRAS DA VIAGEM ----------
// Um Voo nosso é um trecho inteiro, com as escalas somadas dentro dele, e estado.voos guarda TODAS as
// opções pesquisadas, não a viagem escolhida. Então aqui monta-se a viagem mais simples que dá para
// afirmar: a ida mais barata do primeiro dia e a volta mais barata do último.
//
// shortcut: as regras de conexão e de bagagem ficam de fora, porque a busca não traz trecho por trecho;
// as de visto, passaporte, vacina e menor de idade não dependem disso. Quando a busca trouxer cada
// perna do voo, é só preencher mais trechos aqui — o rules.ts já sabe conferir conexão.
function maisMinutos(quando: string, minutos: number) {
	const data = new Date(quando + ":00Z");
	data.setUTCMinutes(data.getUTCMinutes() + minutos);
	return data.toISOString().slice(0, 16);
}

function comoTrecho(voo: Voo): Trecho {
	const partida = `${voo.data}T${voo.saida}`;
	return { origem: voo.origem, destino: voo.destino, partida, chegada: maisMinutos(partida, voo.duracao_min), companhia: voo.companhia };
}

export function viagemDosVoos(voos: Voo[], dossie: Dossie | null): Viagem | null {
	if (voos.length === 0) return null;
	const paisDeCasa = paisDoAeroporto(voos[0].origem) || "BR";
	// viagem dentro do país não tem visto, passaporte nem vacina para conferir: o nó fica calado
	const foraDeCasa = voos.find((voo) => paisDoAeroporto(voo.destino) && paisDoAeroporto(voo.destino) !== paisDeCasa);
	if (!foraDeCasa) return null;

	const maisBarato = (dia: string) => voos.filter((voo) => voo.data === dia).toSorted((a, b) => a.preco - b.preco)[0];
	const dias = [...new Set(voos.map((voo) => voo.data))].toSorted();
	const ida = maisBarato(dias[0])!;
	const volta = dias.length > 1 ? maisBarato(dias.at(-1)!) : undefined;
	const dias_de_permanencia = volta ? Math.round((Date.parse(volta.data) - Date.parse(ida.data)) / 86_400_000) : undefined;

	return {
		viajantes: [{
			nacionalidade: dossie?.nacionalidade ?? "BR",
			passaporte_validade: dossie?.passaporte_validade ?? undefined,
			nascimento: dossie?.nascimento ?? undefined,
			vacina_febre_amarela: dossie?.vacina_febre_amarela ?? undefined,
		}],
		trechos: volta ? [comoTrecho(ida), comoTrecho(volta)] : [comoTrecho(ida)],
		pais_destino: paisDoAeroporto(foraDeCasa.destino),
		motivo: "turismo",
		dias_de_permanencia,
	};
}

// o nó não fala com a pessoa: ele deixa a lista como recado, e o redator explica. É a mesma porta por
// onde os especialistas falam com o redator, então nada de novo precisou entrar no Estado.
// o que o redator precisa saber das regras desta viagem. null = não há viagem para conferir.
// Exportado para a prova: a decisão de quando calar mora aqui, e o nó é só cola.
export function regrasDaViagem(voos: Voo[], dossie: Dossie | null, hoje?: string) {
	const viagem = viagemDosVoos(voos, dossie);
	if (!viagem) {
		// aeroporto fora da tabela não pode virar silêncio: "não conferi" é honesto, e afirmar que
		// precisa de visto seria chute, porque pode ser um aeroporto brasileiro que não listamos.
		const desconhecidos = [...new Set(voos.map((voo) => voo.destino).filter((destino) => !paisDoAeroporto(destino)))];
		if (desconhecidos.length === 0) return null;    // viagem dentro do país: não há regra para conferir
		return { avisos: [], recadoExtra: `não conheço o aeroporto ${desconhecidos.join(", ")}, então NÃO conferi visto, passaporte nem vacina desta viagem: diga isso em uma linha` };
	}
	const todos = conferirViagem(viagem, hoje);
	// quem nunca cadastrou documento nenhum não pode ouvir "cadastre o passaporte" em toda busca de
	// preço: sobra o que depende só do destino, e o convite para contar os documentos uma vez.
	return {
		avisos: dossie ? todos : todos.filter((aviso) => aviso.regra === "visto"),
		recadoExtra: dossie ? "" : "o usuário ainda não contou os documentos dele: no FIM da resposta, em uma frase curta e simples, diga que se ele contar a validade do passaporte e a data de nascimento você confere os documentos da viagem também",
	};
}

// Só os voos deste pedido. O estado.voos guarda tudo o que foi pesquisado nas últimas 6 horas, e sem
// este filtro uma pergunta sobre a Índia herda os voos de Miami da pergunta anterior: num teste de
// verdade o bot avisou sobre visto americano numa viagem para Nova Deli. As buscas deste pedido estão
// em estado.buscas, que o noPreparar zera, no formato "ORIGEM|DESTINO|DATA|...".
export function voosDestePedido(estado: typeof Estado.State) {
	const trechos = new Set(estado.buscas.map((chave) => chave.split("|").slice(0, 3).join("|")));
	return estado.voos.filter((voo) => trechos.has(`${voo.origem}|${voo.destino}|${voo.data}`));
}

function noConferir(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const conversa = conversaDe(config);
	const regras = regrasDaViagem(voosDestePedido(estado), lerDossie(conversa));
	// o convite para contar os documentos sai uma vez por conversa: nos 10 mil ele abria quase toda resposta,
	// e foi o trecho que o juiz de escrita mais reclamou (tom de robô, fecho de efeito, enrolação)
	const convite = regras?.recadoExtra && !estado.convidou ? regras.recadoExtra : "";
	if (!regras || (regras.avisos.length === 0 && !convite)) return {};

	console.log(`[regras] ${regras.avisos.map((aviso) => `${aviso.gravidade}:${aviso.regra}`).join(", ") || "só o recado extra"}`);
	anotar(conversa, "regras_da_viagem", true, regras.avisos.map((aviso) => aviso.regra).join(", "));
	const linhas = regras.avisos.map((aviso) => `${aviso.gravidade === "impede" ? "IMPEDE A VIAGEM" : "atenção"}: ${aviso.texto}`);
	return { recados: [...estado.recados, `regras da viagem: ${[...linhas, convite].filter(Boolean).join(" | ")}`], convidou: estado.convidou || Boolean(convite) };
}

// ---------- NÓ: SITUAÇÃO ----------
// plano vazio: ninguém precisa trabalhar. Mas um "oi, tudo bem?" muitas vezes quer dizer "e aí, alguma novidade?".
// O código junta o que está em andamento e deixa como recado; o redator usa só se a pessoa cumprimentou.
// Não passa pelo conferir: sem pesquisa neste pedido, não há viagem para conferir.
function haQuanto(quando: number) {
	const minutos = Math.round((Date.now() - quando) / 60_000);
	return minutos < 60 ? `${minutos} min` : `${Math.round(minutos / 60)} h`;
}

export function noSituacao(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const monitoramentos = listarMonitoramentos(conversaDe(config)).map((m) => {
		const alvo = m.preco_alvo ? `, alvo R$ ${m.preco_alvo}` : "";
		const menor = m.menor_preco ? `, menor preço visto R$ ${m.menor_preco}` : ", ainda sem preço";
		const quando = m.checado_em ? `, conferido há ${haQuanto(m.checado_em)}` : ", ainda não conferido";
		return `monitoramento #${m.id}: ${descreverMonitoramento(m)}${alvo}${menor}${quando}`;
	});
	// estado.voos já vem sem os preços com mais de 6 horas: o noPreparar tirou
	const pesquisas = [...Map.groupBy(estado.voos, (voo) => `${voo.origem}→${voo.destino} em ${voo.data}`)].map(([trecho, voos]) => {
		const barato = voos.toSorted((a, b) => a.preco - b.preco)[0];
		return `pesquisa recente ${trecho}: ${voos.length} voos, o mais barato: ${descreverVoo(barato)}`;
	});
	const linhas = [...monitoramentos, ...pesquisas];
	const situacao = linhas.length > 0 ? linhas.join(" | ") : "nada em andamento: nenhum monitoramento ativo e nenhuma pesquisa nas últimas 6 horas";
	return { recados: [...estado.recados, `situação atual (use só se a pessoa cumprimentou ou perguntou como estão as coisas: responda com educação e conte isto em até 3 linhas; se ela pediu outra coisa, ignore): ${situacao}`] };
}

// ---------- NÓ: REDATOR ----------
// o único que fala com o usuário. Ele não tem ferramentas: só pode usar o que os outros trouxeram.
async function noRedator(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const carta: BaseMessage[] = [new SystemMessage(comResumo(instrucoesDoRedator(estado.idioma, preferenciasDe(config), estado.recados), estado)), ...historicoLimpo(estado.messages)];
	if (estado.correcao) carta.push(new HumanMessage(estado.correcao));
	const resposta = await modelos.forte.invoke(carta);
	return { messages: [comIdNovo(resposta)], correcao: "" };
}

// ---------- NÓ: VERIFICAR ----------
// a última barreira antes do Slack: nenhum valor pode chegar à pessoa sem ter vindo de uma ferramenta
function noVerificar(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const ultima = estado.messages.at(-1) as AIMessage;
	const anteriores = estado.messages.slice(0, -1);
	const texto = arrumarParaSlack(ultima.text);

	// os recados também contam: os de código (conferir, situacao) vêm do banco, e os dos especialistas já passaram pelo recadoConferido
	const fatos = [fatosDoPedido(estado), ...estado.recados].join("\n");
	const doUsuario = textosDoUsuario(estado.messages).join("\n");
	const links = linksDaConversa(anteriores, estado.voos);

	const problemas = verificarResposta(texto, fatos, links, doUsuario, textoDaWeb(estado));
	if (problemas.length === 0) return { messages: [new AIMessage({ id: ultima.id, content: texto })] };

	console.log(`[verificador] recusou (${estado.tentativas + 1}): ${problemas.join(" / ")}`);
	anotar(conversaDe(config), "verificador_recusou", false, problemas.join(" | "));
	return {
		messages: [new RemoveMessage({ id: ultima.id! })],    // a resposta errada sai da memória
		tentativas: estado.tentativas + 1,
		correcao: `O verificador recusou sua resposta, e o usuário não chegou a ver.\nResposta recusada: ${texto}\nProblemas:\n- ${problemas.join("\n- ")}\nEscreva de novo a resposta inteira.`,
	};
}

// ---------- NÓ: EMERGÊNCIA ----------
// o redator errou todas as tentativas: o código escreve a resposta, com menos jeito, mas com os dados certos
function noEmergencia(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	console.log("[emergencia] o redator não acertou a resposta");
	anotar(conversaDe(config), "emergencia", false, "o redator errou todas as tentativas");
	const texto = estado.voos.length > 0
		? `Não consegui escrever a resposta direito, então vai o essencial, direto da pesquisa:\n\n${listarVoosParaPessoa(estado.voos)}`
		: RESPOSTA_QUE_NAO_SAIU;
	return { messages: [new AIMessage(texto)], correcao: "" };
}

// a lista da emergência é para gente: o resumirVoos é para o modelo e traz custo-benefício (parece preço e não é)
// e nome de ferramenta. Tudo aqui sai de estado.voos, que só tem o que as ferramentas devolveram
export function listarVoosParaPessoa(voos: Voo[]) {
	const ddmm = (data: string) => `${data.slice(8, 10)}/${data.slice(5, 7)}`;
	const escalas = (n: number) => (n === 0 ? "direto" : n === 1 ? "1 escala" : `${n} escalas`);
	return [...Map.groupBy(voos, (voo) => `${voo.origem} → ${voo.destino} em ${ddmm(voo.data)}`)].map(([trecho, lista]) => {
		const ordem = lista.toSorted((a, b) => a.preco - b.preco);
		const linhas = ordem.slice(0, 5).map((voo) => `R$ ${voo.preco.toLocaleString("pt-BR")} · ${voo.companhia} · ${escalas(voo.escalas)} · ${horas(voo.duracao_min)} · sai ${voo.saida}`);
		const mais = lista.length > 5 ? `\n(e mais ${lista.length - 5} voos na planilha)` : "";
		return `*${trecho}*\n${linhas.join("\n")}${mais}\n<${ordem[0].link}|Ver no Google Voos>`;
	}).join("\n\n");
}

// ---------- NÓ: PLANILHA ----------
// quem cria a planilha é o código: assim ela nunca é esquecida, nunca é criada duas vezes e o link nunca é inventado.
// Uma planilha por par de cidades da conversa, sem ordem: GRU→GIG, CGH→SDU e a volta Rio→São Paulo caem na mesma.
// A pesquisa seguinte do par junta os voos novos com os que estão lá (o trecho pesquisado de novo troca os dele)
// e reescreve a planilha, que nunca passa de 100 voos (abasDaPesquisa, em sources/spreadsheet.ts).
export function parDeCidades(origem: string, destino: string) {
	return [cidadeDoAeroporto(origem), cidadeDoAeroporto(destino)].toSorted().join("|");
}

async function noPlanilha(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	if (estado.novos.length === 0) return {};
	const conversa = conversaDe(config);
	const ultima = estado.messages.at(-1) as AIMessage;
	const trecho = (voo: Voo) => `${voo.origem}|${voo.destino}|${voo.data}`;
	const hoje = hojeEmSaoPaulo();
	const linhas: string[] = [];
	const naoForam: Voo[] = [];
	for (const [par, novos] of Map.groupBy(estado.novos, (voo) => parDeCidades(voo.origem, voo.destino))) {
		// o nome vai no sentido desta pesquisa: GRU→REC é "São Paulo–Recife", a volta é "Recife–São Paulo"
		const nome = [novos[0].origem, novos[0].destino].map((iata) => nomeDaCidade(cidadeDoAeroporto(iata))).join("–");
		let guardada: ReturnType<typeof lerPlanilhaDoPar> = null;
		let link = "";
		try {
			guardada = lerPlanilhaDoPar(conversa, par);
			// dos voos que já estavam lá saem os trechos pesquisados de novo (o preço novo vale) e os de dia que já passou
			const pesquisados = new Set(novos.map(trecho));
			const antigos = (guardada?.voos ?? []).filter((voo) => !pesquisados.has(trecho(voo)) && voo.data >= hoje);
			const { abas, ficam, fora } = abasDaPesquisa([...antigos, ...novos]);
			const mandar = (planilha: string | null) => servicos.atualizarPlanilha(planilha, "Takifly " + nome, abas);
			let nova = !guardada;
			// uma falha passageira do Google não pode trocar a planilha da pessoa: tenta de novo uma vez. Se falhar de novo,
			// ela pode ter sido apagada do Drive, e sem uma nova o par ficaria sem planilha para sempre
			link = await mandar(guardada?.link ?? null).catch(async (erro) => {
				if (!guardada) throw erro;
				console.log(`[planilha] não atualizei a de ${nome} (${erro.message}): tento de novo`);
				return mandar(guardada.link).catch((deNovo) => {
					console.log(`[planilha] não atualizei a de ${nome} de novo (${deNovo.message}): crio outra`);
					nova = true;
					return mandar(null);
				});
			});
			try {
				guardarPlanilhaDoPar(conversa, par, link, ficam);
			} catch (erro: any) {
				// a planilha existe: o link vai para a pessoa mesmo assim. A próxima pesquisa do par cria outra
				console.log(`[planilha] não guardei o link da de ${nome}: ${erro.message}`);
			}
			const cortados = fora > 0 ? `, ${fora} ficaram de fora` : "";
			anotarNoPainel(conversa, "planilha", `${nova ? "nova" : "reaproveitada"}: ${nome}, ${ficam.length} voos${cortados}`, { link });
			// o começo ":bar_chart: Planilha:" fica: o quality/style-judge.ts reconhece esta linha por ele
			linhas.push(`:bar_chart: Planilha: <${link}|abrir os ${ficam.length} voos de ${nome} na planilha>${fora > 0 ? ` (${fora} não couberam)` : ""}`);
		} catch (erro: any) {
			// os voos deste par continuam em "novos": a próxima mensagem tenta de novo. O motivo técnico fica no log
			console.log(`[planilha] não criei a de ${nome}: ${erro.message}`);
			anotarNoPainel(conversa, "planilha", `falhou: ${nome} (${erro.message})`);
			naoForam.push(...novos);
			linhas.push(`Não consegui ${guardada ? "atualizar" : "criar"} a planilha de ${nome} agora. Na sua próxima mensagem eu tento de novo.`);
		}
	}
	return { messages: [new AIMessage({ id: ultima.id, content: `${ultima.text}\n\n${linhas.join("\n")}` })], novos: naoForam };
}

// ---------- ARESTAS CONDICIONAIS ----------
// o plano acabou: as regras da viagem antes de escrever. Se ninguém trabalhou ("oi"), não há regra para conferir,
// e o redator recebe a situação atual
function depoisDoOrquestrador(estado: typeof Estado.State) {
	return estado.plano[0] ?? (estado.feitos.length > 0 ? "conferir" : "situacao");
}

// pediu ferramenta: vai rodar. Recebeu bilhete de correção: ele mesmo de novo. Saiu do plano: volta ao orquestrador
function depoisDoEspecialista(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	if (ultima.tool_calls?.length) return "ferramentas";
	return estado.correcao ? estado.plano[0] : "orquestrador";
}

// a resposta da ferramenta volta para quem pediu, que ainda é o primeiro do plano
function depoisDasFerramentas(estado: typeof Estado.State) {
	return estado.plano[0] ?? "orquestrador";
}

function depoisDeVerificar(estado: typeof Estado.State) {
	if (!estado.correcao) return "planilha";
	return estado.tentativas <= LIMITE_DE_TENTATIVAS ? "redator" : "emergencia";
}

// ---------- GRAFO ----------
// o SqliteSaver guarda a pasta num arquivo depois de cada nó: é a memória que sobrevive ao Ctrl+C
const memoria = SqliteSaver.fromConnString(process.env.MEMORIA ?? import.meta.dirname + "/../data/memoria.sqlite");

// as conversas que têm memória, da que mexeu por último à mais antiga, para o painel. Lê a tabela do SqliteSaver
// direto: o list() dele abriria cada checkpoint guardado. O id do checkpoint cresce com o tempo (uuid6).
// shortcut: depende do nome da tabela do @langchain/langgraph-checkpoint-sqlite 1.1; se ele mudar, a lista sai vazia (o teste avisa)
export function listarConversas(): string[] {
	try {
		const linhas = (memoria as any).db.prepare("SELECT thread_id, MAX(checkpoint_id) AS ultimo FROM checkpoints WHERE checkpoint_ns = '' GROUP BY thread_id ORDER BY ultimo DESC").all();
		return linhas.map((linha: { thread_id: string }) => linha.thread_id);
	} catch {
		return [];    // nenhum pedido rodou ainda: a tabela nem existe
	}
}

const ESPECIALISTAS = ["memoria", "monitor", "pesquisador", "analista", "guia"] as const;
const CAMINHOS_DO_ORQUESTRADOR = [...ESPECIALISTAS, "conferir", "situacao"] as const;
const CAMINHOS_DO_ESPECIALISTA = [...ESPECIALISTAS, "ferramentas", "orquestrador"] as const;
const CAMINHOS_DAS_FERRAMENTAS = [...ESPECIALISTAS, "orquestrador"] as const;

// exportado para o floorplan desenhar a camada de cima a partir do grafo de verdade, não de uma cópia à mão
export const grafo = new StateGraph(Estado)
	.addNode("preparar", noPreparar)
	.addNode("lembrar", noLembrar)
	.addNode("contexto", noContexto)
	.addNode("orquestrador", noOrquestrador, { retryPolicy: { maxAttempts: 2 } })    // resposta fora do formato: tenta mais uma vez
	.addNode("memoria", criarEspecialista("memoria"))
	.addNode("monitor", criarEspecialista("monitor"))
	.addNode("pesquisador", criarEspecialista("pesquisador"))
	.addNode("analista", criarEspecialista("analista"))
	.addNode("guia", criarEspecialista("guia"))    // clima e internet: as dúvidas de viagem que não são preço
	.addNode("ferramentas", noFerramentas)
	.addNode("conferir", noConferir)
	.addNode("situacao", noSituacao)
	.addNode("redator", noRedator)
	.addNode("verificar", noVerificar)
	.addNode("emergencia", noEmergencia)
	.addNode("planilha", noPlanilha)
	.addEdge(START, "preparar")
	.addEdge("preparar", "contexto")
	.addEdge("contexto", "orquestrador")
	.addConditionalEdges("orquestrador", depoisDoOrquestrador, [...CAMINHOS_DO_ORQUESTRADOR])
	.addConditionalEdges("memoria", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("monitor", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("pesquisador", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("analista", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("guia", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("ferramentas", depoisDasFerramentas, [...CAMINHOS_DAS_FERRAMENTAS])
	.addEdge("conferir", "redator")
	.addEdge("situacao", "redator")
	.addEdge("redator", "verificar")
	.addConditionalEdges("verificar", depoisDeVerificar, ["planilha", "redator", "emergencia"])
	.addEdge("emergencia", "planilha")
	.addEdge("planilha", "lembrar")
	.addEdge("lembrar", END)
	.compile({ checkpointer: memoria });

// ---------- RESPONDER ----------
type Avisar = (progresso: string) => Promise<void> | void;

// ---------- O QUE APARECE NO SLACK ENQUANTO O GRAFO TRABALHA ----------
// a data chega como a pessoa escreveu ("12/12", "próxima sexta"); só a data em AAAA-MM-DD vira dd/mm
const paraPessoa = (data: unknown) => (typeof data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data) ? `${data.slice(8, 10)}/${data.slice(5, 7)}` : data);

export function descreverChamada(chamada: { name: string; args: Record<string, any> }) {
	const { origem, destino, data, ate, cidade } = chamada.args;
	if (chamada.name === "buscar_voos") return `:mag: Procurando voos de ${origem} para ${destino} ${ate ? `de ${paraPessoa(data)} a ${paraPessoa(ate)}` : `em ${paraPessoa(data)}`}...`;
	if (chamada.name === "buscar_hoteis") return `:hotel: Procurando hotel em ${cidade}...`;
	if (chamada.name === "criar_monitoramento") return `:eyes: Ligando o monitoramento de preço de ${origem} para ${destino}...`;
	if (chamada.name.includes("monitoramento")) return ":eyes: Olhando seus monitoramentos...";
	if (chamada.name.startsWith("guardar_")) return ":memo: Anotando o que você me contou...";
	if (chamada.name.includes("preferencia")) return ":memo: Olhando o que eu tenho anotado...";
	if (chamada.name === "ver_clima") return `:partly_sunny: Vendo o tempo em ${cidade}...`;
	if (chamada.name === "buscar_na_web") return `:globe_with_meridians: Procurando na internet: ${String(chamada.args.pergunta ?? "").slice(0, 80)}...`;
	return ":bar_chart: Comparando os voos...";
}

// o stream avisa quando um nó TERMINA: a frase diz o que começa depois dele. Nó sem frase não muda o aviso
const DEPOIS_DO_PLANO: Record<string, string> = { pesquisador: ":mag: Indo atrás dos voos...", analista: ":bar_chart: Comparando os voos...", monitor: ":eyes: Cuidando do monitoramento...", memoria: ":memo: Anotando...", guia: ":globe_with_meridians: Indo atrás da informação..." };
export function descreverPasso(no: string, resultado: any) {
	if (no === "orquestrador") return DEPOIS_DO_PLANO[resultado?.plano?.[0]] ?? "";
	if (no === "conferir" || no === "situacao") return ":pencil2: Escrevendo a resposta...";
	if (no === "redator") return ":mag_right: Conferindo cada preço e horário...";
	if (no === "verificar" && resultado?.correcao) return ":repeat: Um número não bateu com a pesquisa. Reescrevendo...";
	return "";
}

// stream roda o grafo igual ao invoke, mas entrega o resultado de cada nó assim que ele termina.
// recursionLimit: o freio de mão do LangGraph, bem acima dos nossos limites; só dispara se um limite nosso falhar.
async function rodar(entrada: { messages: BaseMessage[] } | null, config: { configurable: { thread_id: string } }, avisar: Avisar) {
	// o Langfuse guarda o rastro; o ouvinte do painel ao vivo (brain/live.ts) mostra cada nó na hora
	const callbacks = [...rastrear(config.configurable.thread_id, rotuloDosModelos()), ouvinteAoVivo(config.configurable.thread_id)];
	for await (const passo of await grafo.stream(entrada, { ...config, streamMode: "updates", recursionLimit: 60, callbacks })) {
		// cada passo traz o resultado de um nó: conta o que vem depois dele, e o que cada ferramenta pedida vai fazer
		for (const [no, resultado] of Object.entries(passo) as [string, any][]) {
			const frase = descreverPasso(no, resultado);
			if (frase) await avisar(frase);
			for (const chamada of resultado?.messages?.[0]?.tool_calls ?? []) await avisar(descreverChamada(chamada));
		}
	}
	const estado = await grafo.getState(config);
	return estado.values.messages.at(-1)?.text as string;
}

// conversa: o identificador da conversa (no Slack, o canal). Cada um tem a sua pasta separada no arquivo.
export async function responder(conversa: string, texto: string, avisar: Avisar = () => {}): Promise<string> {
	const config = { configurable: { thread_id: conversa } };
	// a busca grande desenha a barra de progresso por aqui. O próximo pedido da conversa troca pela função nova
	avisosDaBusca.set(conversa, avisar);

	// se o bot caiu no meio de um pedido, primeiro terminamos esse pedido de onde ele parou,
	// e a resposta dele vai junto (ela pode trazer o link de uma planilha)
	let respostaAtrasada = "";
	const anterior = await grafo.getState(config);
	try {
		if (anterior.next.length > 0) respostaAtrasada = (await rodar(null, config, avisar)) + "\n\n";
	} catch (erro: any) {
		// uma retomada que quebra sempre prenderia o canal: a mensagem nova começa do zero e descarta o pedido antigo
		console.log(`[responder] não retomei o pedido anterior: ${erro.message}`);
		anotar(conversa, "retomada_falhou", false, erro.message);
		// o explicarErro prometeu "continuo de onde parei": sem este aviso, o pedido antigo sumia em silêncio
		respostaAtrasada = "Não consegui terminar o pedido anterior; se ainda precisar dele, mande de novo.\n\n";
	}

	const resposta = await rodar({ messages: [new HumanMessage(texto)] }, config, avisar);
	return respostaAtrasada + (resposta || RESPOSTA_QUE_NAO_SAIU);
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	const pergunta = process.argv[2];
	if (pergunta) {
		console.log(await responder("terminal", pergunta, console.log));
	} else {
		// o mesmo desenho do grafo.ts: o Mermaid roda no seu navegador e nada do grafo sai do Mac
		const desenho = await grafo.getGraphAsync();
		await writeFile(import.meta.dirname + "/graph.html", `<!doctype html>
<meta charset="utf-8">
<title>Grafo do bot</title>
<pre class="mermaid">${desenho.drawMermaid()}</pre>
<script type="module">
	import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
	mermaid.initialize({ startOnLoad: true });
</script>`);
		console.log("Desenho salvo em graph.html");
	}
}
