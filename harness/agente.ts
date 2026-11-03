// harness/agente.ts - o cérebro do bot, montado como um grafo do LangGraph
//
// O caminho do grafo:
//
//   START → preparar → orquestrador → especialistas do plano, um de cada vez → conferir → redator → verificar
//
//   especialistas (memoria, monitor, pesquisador, analista): cada um repete "modelo ⇄ ferramentas" até terminar a sua tarefa
//   conferir: código, sem IA. Vê visto, passaporte, vacina e menor de idade, e deixa o problema como recado
//   verificar → aprovou → planilha → END
//             → recusou → volta para redator (até 2 vezes)
//             → recusou de novo → emergencia → planilha → END
//
// Usam IA: orquestrador, especialistas e redator. O resto é código.
//
// Para perguntar pelo terminal:   node harness/agente.ts "voos de GRU para LIS em 12/12"
// Para gerar o desenho:           node harness/agente.ts       (depois: open harness/agente.html)

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { AIMessage, type BaseMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { Annotation, END, type LangGraphRunnableConfig, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenAI } from "@langchain/openai";

import { AGENTES, definirPlano, instrucoesDoOrquestrador, instrucoesDoRedator, type NomeDoAgente, planoDoTexto, planoValido } from "./agentes.ts";
import { type Dossie, lerDossie, listarPreferencias } from "./dados.ts";
import { type Caderno, descreverVoo, limparArgumentos, resumirVoos, servicos } from "./ferramentas.ts";
import { conferirViagem, paisDoAeroporto, type Trecho, type Viagem } from "./regras.ts";
import { anotar, rastrear } from "./rastreio.ts";
import { arrumarParaSlack, escreveuChamada, prometeuSemFazer, verificarResposta } from "./verificador.ts";
import { REGRA_DO_CUSTO_BENEFICIO, type Voo } from "../voos.ts";

// ---------- CHAVES ----------
process.loadEnvFile(import.meta.dirname + "/../.env");

// ---------- LIMITES ----------
const PASSOS_POR_AGENTE = 6;      // quantas vezes um especialista pode ser chamado em um pedido
const PASSOS_POR_PEDIDO = 14;     // quantas vezes os especialistas, somados, podem ser chamados em um pedido
const LIMITE_DE_TENTATIVAS = 2;   // quantas respostas recusadas o redator pode corrigir
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

// ---------- HISTÓRICO ----------
// a conversa fica guardada para sempre, mas só mandamos as mensagens recentes (cada carta custa dinheiro).
// O corte começa numa mensagem do usuário: uma resposta de ferramenta sem o pedido dela daria erro no modelo.
export function cortarHistorico(mensagens: BaseMessage[], limite = 40) {
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
		voos: velhos ? [] : estado.voos,
		novos: velhos ? [] : estado.novos,
	};
}

// ---------- NÓ: ORQUESTRADOR ----------
// decide uma vez só quem trabalha. Quem confere o plano é o código, e nada aqui entra na conversa.
async function noOrquestrador(estado: typeof Estado.State) {
	const temVoos = estado.voos.length > 0;
	const carta = [new SystemMessage(instrucoesDoOrquestrador(temVoos)), ...historicoLimpo(estado.messages)];
	const resposta = await modelo.bindTools([definirPlano], { tool_choice: "required" }).invoke(carta);
	const chamada = resposta.tool_calls?.find((opcao) => opcao.name === "definir_plano");
	const pedidos = Array.isArray(chamada?.args?.agentes) ? chamada.args.agentes : planoDoTexto(resposta.text, temVoos);
	const plano = planoValido(pedidos);
	console.log(`[orquestrador] ${JSON.stringify(plano)} em ${chamada?.args?.idioma ?? "?"}`);
	return { plano, idioma: String(chamada?.args?.idioma ?? "") };
}

// ---------- O QUE CONTA COMO FATO ----------
// só o retorno de uma ferramenta, mais o que já está pesquisado. Serve ao verificador e ao recado.
function fatosDoPedido(estado: typeof Estado.State) {
	const doPedido = estado.messages.slice(estado.messages.findLastIndex((mensagem) => mensagem.getType() === "human"));
	const retornos = doPedido.filter((mensagem) => mensagem.getType() === "tool").map((mensagem) => mensagem.text);
	return [...retornos, ...estado.voos.map(descreverVoo), REGRA_DO_CUSTO_BENEFICIO].join("\n");
}

// o recado do especialista vai inteiro para as instruções do redator, e o verificador só olha a resposta
// final: sem isto, um preço inventado na nota de um especialista vira fato na boca do redator.
function recadoConferido(nome: string, recado: string, estado: typeof Estado.State) {
	const fatos = fatosDoPedido(estado);
	const problemas = verificarResposta(recado, fatos, fatos, textosDoUsuario(estado.messages).join("\n"));
	if (problemas.length === 0) return recado;
	console.log(`[${nome}] recado recusado: ${problemas.join(" / ")}`);
	return "não terminou: a nota deste especialista trouxe dado que não veio de ferramenta, e foi descartada";
}

// ---------- NÓS: ESPECIALISTAS ----------
// todo especialista funciona igual: lê o pedido, chama as suas ferramentas e, quando termina, deixa um recado e sai do plano
function criarEspecialista(nome: NomeDoAgente) {
	const { ferramentas, instrucoes } = AGENTES[nome];

	return async (estado: typeof Estado.State, config: LangGraphRunnableConfig) => {
		const sair = (recado: string) => {
			const conferido = recado && !/^pronto\.?$/i.test(recado.trim()) ? recadoConferido(nome, recado, estado) : "";
			return {
				plano: estado.plano.slice(1),
				passosDoAgente: 0,
				correcao: "",
				recados: conferido ? [...estado.recados, `${nome}: ${conferido}`] : estado.recados,
			};
		};
		if (estado.passosDoAgente >= PASSOS_POR_AGENTE || estado.passos >= PASSOS_POR_PEDIDO) return sair("não terminou: chegou ao limite de passos");

		const preferencias = preferenciasDe(config);
		const guardadas = preferencias.length > 0 ? `\nPreferências guardadas: ${preferencias.join("; ")}.` : "";
		const carta: BaseMessage[] = [new SystemMessage(instrucoes() + guardadas), ...historicoLimpo(estado.messages)];
		if (estado.correcao) carta.push(new HumanMessage(estado.correcao));

		const resposta = await modelo.bindTools(ferramentas).invoke(carta);
		const contagem = { passos: estado.passos + 1, passosDoAgente: estado.passosDoAgente + 1 };
		if (resposta.tool_calls?.length) return { messages: [comIdNovo(resposta)], ...contagem, correcao: "" };

		// modelo fraco às vezes quebra a chamada, escreve a chamada como texto ou só promete: ele tem outra chance
		const texto = arrumarParaSlack(resposta.text);
		if (resposta.invalid_tool_calls?.length || escreveuChamada(texto) || prometeuSemFazer(texto)) {
			console.log(`[${nome}] não chamou a ferramenta direito: ${texto.slice(0, 100)}`);
			return { ...contagem, correcao: "Você não chamou a ferramenta do jeito certo. Chame a ferramenta agora, ou escreva o que faltou." };
		}
		return { ...sair(texto), ...contagem, passosDoAgente: 0 };
	};
}

// ---------- NÓ: FERRAMENTAS ----------
// um pedido de cada vez, na ordem: várias buscas ao mesmo tempo no Google poderiam levar a um bloqueio
export async function noFerramentas(estado: typeof Estado.State, config?: LangGraphRunnableConfig) {
	const ultima = estado.messages.at(-1) as AIMessage;
	// buscas é uma cópia: as ferramentas escrevem nela, e o Estado original não pode mudar antes do fim do nó
	const caderno: Caderno = {
		voos: estado.voos,
		novos: estado.novos,
		buscas: [...estado.buscas],
		textosDoUsuario: [...textosDoUsuario(estado.messages), ...preferenciasDe(config)],
		conversa: conversaDe(config),
	};
	const permitidas: { name: string }[] = AGENTES[estado.plano[0]]?.ferramentas ?? [];
	const respostas = [];

	for (const chamada of ultima.tool_calls ?? []) {
		let resultado: string;
		try {
			const ferramenta: any = permitidas.find((opcao) => opcao.name === chamada.name);
			if (!ferramenta) throw new Error(`a ferramenta ${chamada.name} não é sua. As suas são: ${permitidas.map((opcao) => opcao.name).join(", ")}`);
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
// perna do voo, é só preencher mais trechos aqui — o regras.ts já sabe conferir conexão.
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
		recadoExtra: dossie ? "" : "o usuário ainda não contou os documentos dele: diga, em uma linha, que se ele disser a validade do passaporte e a data de nascimento, você passa a conferir passaporte, vacina e autorização de menor",
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
	if (!regras || (regras.avisos.length === 0 && !regras.recadoExtra)) return {};

	console.log(`[regras] ${regras.avisos.map((aviso) => `${aviso.gravidade}:${aviso.regra}`).join(", ") || "só o recado extra"}`);
	anotar(conversa, "regras_da_viagem", true, regras.avisos.map((aviso) => aviso.regra).join(", "));
	const linhas = regras.avisos.map((aviso) => `${aviso.gravidade === "impede" ? "IMPEDE A VIAGEM" : "atenção"}: ${aviso.texto}`);
	return { recados: [...estado.recados, `regras da viagem: ${[...linhas, regras.recadoExtra].filter(Boolean).join(" | ")}`] };
}

// ---------- NÓ: REDATOR ----------
// o único que fala com o usuário. Ele não tem ferramentas: só pode usar o que os outros trouxeram.
async function noRedator(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const carta: BaseMessage[] = [new SystemMessage(instrucoesDoRedator(estado.idioma, preferenciasDe(config), estado.recados)), ...historicoLimpo(estado.messages)];
	if (estado.correcao) carta.push(new HumanMessage(estado.correcao));
	const resposta = await modelo.invoke(carta);
	return { messages: [comIdNovo(resposta)], correcao: "" };
}

// ---------- NÓ: VERIFICAR ----------
// a última barreira antes do Slack: nenhum valor pode chegar à pessoa sem ter vindo de uma ferramenta
function noVerificar(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const ultima = estado.messages.at(-1) as AIMessage;
	const anteriores = estado.messages.slice(0, -1);
	const texto = arrumarParaSlack(ultima.text);

	const doPedido = anteriores.slice(anteriores.findLastIndex((mensagem) => mensagem.getType() === "human"));
	const retornos = doPedido.filter((mensagem) => mensagem.getType() === "tool").map((mensagem) => mensagem.text);
	const regraDoCustoBeneficio = REGRA_DO_CUSTO_BENEFICIO;    // a mesma regra das instruções do redator: ele pode citar os números
	const fatos = [...retornos, ...estado.voos.map(descreverVoo), regraDoCustoBeneficio].join("\n");
	const doUsuario = textosDoUsuario(estado.messages).join("\n");
	// link escrito pelo usuário não vale: senão um link de golpe passaria
	const links = [...anteriores.filter((mensagem) => mensagem.getType() !== "human").map((mensagem) => mensagem.text), ...estado.voos.map((voo) => voo.link)].join("\n");

	const problemas = verificarResposta(texto, fatos, links, doUsuario);
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
function proximoDoPlano(estado: typeof Estado.State) {
	return estado.plano[0] ?? "conferir";    // acabou o plano: as regras da viagem antes de escrever
}

// o especialista pediu ferramenta? Se não, segue o plano (ou ele mesmo de novo, se ainda não saiu do plano)
function depoisDoEspecialista(estado: typeof Estado.State) {
	const ultima = estado.messages.at(-1) as AIMessage;
	return ultima.tool_calls?.length ? "ferramentas" : proximoDoPlano(estado);
}

function depoisDeVerificar(estado: typeof Estado.State) {
	if (!estado.correcao) return "planilha";
	return estado.tentativas <= LIMITE_DE_TENTATIVAS ? "redator" : "emergencia";
}

// ---------- GRAFO ----------
// o SqliteSaver guarda a pasta num arquivo depois de cada nó: é a memória que sobrevive ao Ctrl+C
const memoria = SqliteSaver.fromConnString(process.env.MEMORIA ?? import.meta.dirname + "/../memoria.sqlite");

const CAMINHOS = ["memoria", "monitor", "pesquisador", "analista", "conferir"] as const;
const CAMINHOS_DO_ESPECIALISTA = ["ferramentas", ...CAMINHOS] as const;

// exportado para o floorplan desenhar a camada de cima a partir do grafo de verdade, não de uma cópia à mão
export const grafo = new StateGraph(Estado)
	.addNode("preparar", noPreparar)
	.addNode("orquestrador", noOrquestrador)
	.addNode("memoria", criarEspecialista("memoria"))
	.addNode("monitor", criarEspecialista("monitor"))
	.addNode("pesquisador", criarEspecialista("pesquisador"))
	.addNode("analista", criarEspecialista("analista"))
	.addNode("ferramentas", noFerramentas)
	.addNode("conferir", noConferir)
	.addNode("redator", noRedator)
	.addNode("verificar", noVerificar)
	.addNode("emergencia", noEmergencia)
	.addNode("planilha", noPlanilha)
	.addEdge(START, "preparar")
	.addEdge("preparar", "orquestrador")
	.addConditionalEdges("orquestrador", proximoDoPlano, [...CAMINHOS])
	.addConditionalEdges("memoria", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("monitor", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("pesquisador", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("analista", depoisDoEspecialista, [...CAMINHOS_DO_ESPECIALISTA])
	.addConditionalEdges("ferramentas", proximoDoPlano, [...CAMINHOS])
	.addEdge("conferir", "redator")
	.addEdge("redator", "verificar")
	.addConditionalEdges("verificar", depoisDeVerificar, ["planilha", "redator", "emergencia"])
	.addEdge("emergencia", "planilha")
	.addEdge("planilha", END)
	.compile({ checkpointer: memoria });

// ---------- RESPONDER ----------
type Avisar = (progresso: string) => Promise<void> | void;

// o que aparece no Slack enquanto o grafo trabalha
function descreverChamada(chamada: { name: string; args: Record<string, any> }) {
	if (chamada.name === "buscar_voos") return `:mag: Pesquisando ${chamada.args.origem}→${chamada.args.destino} em ${chamada.args.data}...`;
	if (chamada.name === "buscar_varios_dias") return `:mag: Pesquisando ${chamada.args.origem}→${chamada.args.destino} de ${chamada.args.data_inicio} a ${chamada.args.data_fim}...`;
	if (chamada.name === "criar_monitoramento") return `:eyes: Criando o monitoramento de ${chamada.args.origem}→${chamada.args.destino}...`;
	return ":gear: Analisando os voos...";
}

// stream roda o grafo igual ao invoke, mas entrega o resultado de cada nó assim que ele termina.
// recursionLimit: o freio de mão do LangGraph, bem acima dos nossos limites; só dispara se um limite nosso falhar.
async function rodar(entrada: { messages: BaseMessage[] } | null, config: { configurable: { thread_id: string } }, avisar: Avisar) {
	const callbacks = rastrear(config.configurable.thread_id, NOME_DO_MODELO);
	for await (const passo of await grafo.stream(entrada, { ...config, streamMode: "updates", recursionLimit: 60, callbacks })) {
		// cada passo traz o resultado de um nó; se um especialista pediu ferramentas, conta o que está acontecendo
		for (const resultado of Object.values(passo) as { messages?: AIMessage[] }[]) {
			for (const chamada of resultado?.messages?.[0]?.tool_calls ?? []) await avisar(descreverChamada(chamada));
		}
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
