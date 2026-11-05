// price-watch.ts - o vigia de preços, agora montado como um grafo do LangGraph
//
// Aqui não tem IA: é código comparando números. Cada checagem não gasta crédito, e o modelo não tem como
// inventar uma queda de preço. O relógio acorda de hora em hora e manda ao grafo cada monitoramento que
// está há mais de 2 horas sem checar: assim um Mac que dormiu retoma sozinho.
//
// O caminho do grafo (uma volta por monitoramento):
//
//   START → a viagem já passou? → encerrar → END
//         → estourou o teto de buscas do dia? → END
//         → buscar → registrar → decidir → é novidade? → avisar → END
//                                                      → END
//                  → a busca falhou 2 vezes → falhou → END
//
// O "registrar" é o que faz a planilha ficar viva: toda checagem com preço vira uma linha no sqlite e uma
// linha na planilha do monitoramento. O Slack continua só ouvindo novidade boa, senão seriam 12 mensagens por dia.
//
// Por que não tem checkpointer aqui: o progresso de cada monitoramento já mora no dados.sqlite
// (checado_em, falhas, avisado_preco, menor_preco). Guardar o mesmo progresso em dois lugares daria
// briga entre os dois. Então cada checagem é uma volta nova e inteira, e repetir uma volta não faz mal.
//
// Para checar uma vez agora, sem Slack (dentro da pasta passagens.ts/):   node brain/price-watch.ts
// Para gerar o desenho:                                                   node brain/price-watch.ts --desenho

import { writeFile } from "node:fs/promises";

import { Annotation, Command, END, type LangGraphRunnableConfig, START, StateGraph } from "@langchain/langgraph";

import { atualizarMonitoramento, buscasDoDia, gravarPreco, listarHistorico, listarMonitoramentos, somarBuscasDoDia, type Monitoramento } from "../storage/database.ts";
import { hojeEmSaoPaulo, descreverMonitoramento, precoAtual } from "./tools.ts";
import { enviarRastreio, rastrear } from "./tracing.ts";
import { servicos as planilhas } from "../sources/spreadsheet.ts";

const INTERVALO_ENTRE_CHECAGENS = 2 * 60 * 60 * 1000;    // 2 horas
const PULSO_DO_RELOGIO = 60 * 60 * 1000;                 // 1 hora
const ESPERA_ENTRE_MONITORAMENTOS = 5000;                // 5 segundos
const FALHAS_ATE_AVISAR = 4;                             // 4 checagens seguidas sem conseguir checar

// A TRAVA. A busca do Google não é oficial: martelar leva a captcha e a bloqueio, e o bloqueio derruba
// também a pesquisa interativa do bot, não só o monitor. Um monitoramento ida-e-volta com origem
// multi-aeroporto já são ~6 buscas por checagem, e de 2 em 2 horas são 12 checagens por dia.
// Mude este número à mão se quiser apertar ou soltar; estourado, o monitor pula a checagem em silêncio.
const TETO_DIARIO_DE_BUSCAS = 200;

// uma conexão que caiu não devia virar uma falha do monitoramento: o nó tenta de novo antes de desistir.
// Mas só nesses casos: insistir num captcha ou num 403 não resolve nada e só aumenta o bloqueio.
const TENTATIVAS_DA_BUSCA = 2;
const ESPERA_DA_RETENTATIVA = 1000;
const VALE_TENTAR_DE_NOVO = /fetch failed|timeout|aborted|socket|ECONN|terminated|erro 5\d\d|erro 429/i;

type Avisar = (conversa: string, texto: string) => Promise<unknown>;

// hoje só existe o Slack. Quando o e-mail e o WhatsApp chegarem, cada um é só mais uma função nesta lista:
// os nós não precisam saber quantos canais existem nem qual é qual.
type Canais = Avisar | Avisar[];

// ---------- O TETO DIÁRIO DE BUSCAS ----------
// quantas buscas no Google esta checagem vai custar: o precoAtual roda uma por par origem×destino, e o dobro com volta
function quantasBuscas(m: Monitoramento) {
	const pares = m.origens.split(",").length * m.destinos.split(",").length;
	return m.data_volta ? pares * 2 : pares;
}

// o dia em São Paulo, do mesmo jeito que o hojeEmSaoPaulo, mas do horário desta checagem
function diaDaChecagem(agora: number) {
	return new Date(agora).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

// true = pode buscar, e as buscas já ficaram contadas no sqlite (sobrevive a reinício do processo).
// A conta é feita antes da busca: é melhor contar uma busca que não aconteceu do que estourar o teto.
// shortcut: a retentativa do nó buscar não entra na conta (no máximo uma busca extra por checagem),
// mude para contar dentro do precoAtual se o teto começar a ficar apertado de verdade.
function reservarBuscas(agora: number, quantas: number) {
	const dia = diaDaChecagem(agora);
	if (buscasDoDia(dia) + quantas > TETO_DIARIO_DE_BUSCAS) return false;
	somarBuscasDoDia(dia, quantas);
	return true;
}

// o preço de uma checagem, do jeito que o precoAtual devolve (sem precisar repetir a forma aqui)
type Preco = NonNullable<Awaited<ReturnType<typeof precoAtual>>>;

// ---------- ESTADO ----------
// a "pasta" de UMA checagem: entra um monitoramento, sai o que foi decidido sobre ele
function campo<T>(inicial: T) {
	return Annotation<T>({ reducer: (_antigo, novo) => novo, default: () => inicial });
}

const Estado = Annotation.Root({
	monitoramento: campo<Monitoramento | null>(null),    // qual rota estamos checando
	agora: campo(0),                                     // o horário desta checagem
	preco: campo<Preco | null>(null),                    // o que a busca achou (null = não há voos)
	erro: campo(""),                                     // a busca falhou, e esta é a mensagem
	resultado: campo(""),                                // o que o decidir concluiu
	menorNovo: campo<number | null>(null),               // o menor preço já visto, contando o de agora
});

// quem manda a mensagem não é o grafo: ele recebe as funções prontas, pela config.
// É o mesmo jeito que as ferramentas recebem o "caderno" em tools.ts.
// Pode vir uma função só (o Slack de hoje) ou uma lista: aqui vira sempre uma função que avisa todos.
function avisarDe(config?: LangGraphRunnableConfig): Avisar {
	const canais = config?.configurable?.avisar as Canais | undefined;
	const lista = canais === undefined ? [] : Array.isArray(canais) ? canais : [canais];
	return async (conversa, texto) => {
		for (const canal of lista) await canal(conversa, texto);
	};
}

// ---------- NÓ: ENCERRAR ----------
// a viagem já passou: não há mais o que monitorar.
// Avisa primeiro e só depois desliga: se o Slack falhar, o monitoramento continua ativo e a próxima volta tenta de novo.
async function noEncerrar(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const m = estado.monitoramento!;
	await avisarDe(config)(m.conversa, `:dog: Parei de monitorar ${descreverMonitoramento(m)}: a data da viagem já passou. O Taki largou esse osso.`);
	atualizarMonitoramento(m.id, { ativo: 0 });
	return { resultado: "viagem-passou" };
}

// ---------- NÓ: BUSCAR ----------
// o único nó que fala com o mundo de fora. Se o Google falhar, ele deixa o erro subir:
// o retryPolicy tenta de novo e, se ainda falhar, o errorHandler desvia para o nó "falhou".
async function noBuscar(estado: typeof Estado.State) {
	return { preco: await precoAtual(estado.monitoramento!) };
}

// ---------- NÓ: REGISTRAR ----------
// toda checagem com preço vira uma linha: no sqlite (que é a verdade) e na planilha (que é a vista).
// Nada aqui avisa ninguém: é só memória do preço ao longo do tempo.
async function noRegistrar(estado: typeof Estado.State) {
	const m = estado.monitoramento!;
	const preco = estado.preco;
	if (preco === null) return {};    // sem voos não há preço para registrar

	gravarPreco({
		monitoramento: m.id,
		checado_em: estado.agora,
		total: preco.total,
		companhia_ida: preco.ida.companhia,
		preco_ida: preco.ida.preco,
		link_ida: preco.ida.link,
		companhia_volta: preco.volta?.companhia ?? null,
		preco_volta: preco.volta?.preco ?? null,
		link_volta: preco.volta?.link ?? null,
	});

	// sem PLANILHA_VIVA_URL no .env não existe planilha viva: o histórico no sqlite já ficou gravado,
	// e tentar escrever só daria erro em toda checagem.
	if (!process.env.PLANILHA_VIVA_URL) return {};

	const quando = new Date(estado.agora).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" });
	const dentroDoAlvo = m.preco_alvo !== null && preco.total <= m.preco_alvo ? "sim" : "nao";
	const abas = [
		{
			nome: "Resumo",
			modo: "reescrever" as const,
			colunas: ["monitoramento", "trecho", "preco_alvo", "menor_preco", "preco", "dentro_do_alvo", "checagens", "checado_em"],
			linhas: [[m.id, descreverMonitoramento(m), m.preco_alvo ?? "", m.menor_preco ?? "", preco.total, dentroDoAlvo, listarHistorico(m.id).length, quando]],
		},
		{
			nome: "Histórico",
			modo: "acrescentar" as const,
			colunas: ["checado_em", "preco", "companhia_ida", "preco_ida", "link_ida", "companhia_volta", "preco_volta", "link_volta"],
			linhas: [[quando, preco.total, preco.ida.companhia, preco.ida.preco, preco.ida.link, preco.volta?.companhia ?? "", preco.volta?.preco ?? "", preco.volta?.link ?? ""]],
		},
	];

	// a planilha é a vista, não a verdade: se o Google falhar, o histórico já está gravado e a checagem segue.
	// Por isso o erro morre aqui e não vira uma falha do monitoramento.
	try {
		const link = await planilhas.atualizarPlanilha(m.planilha, `Takifly #${m.id} - ${m.origens}→${m.destinos}`, abas);
		if (link !== m.planilha) atualizarMonitoramento(m.id, { planilha: link });
	} catch (erro) {
		console.log(`[monitor] #${m.id} não conseguiu escrever na planilha: ${(erro as Error).message}`);
	}
	return {};
}

// ---------- NÓ: FALHOU ----------
// falhar calado seria o pior caso: a pessoa acharia que o preço só não baixou
async function noFalhou(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const m = estado.monitoramento!;
	const falhas = m.falhas + 1;
	console.log(`[monitor] #${m.id} falhou (${falhas}): ${estado.erro}`);
	if (falhas === FALHAS_ATE_AVISAR) {
		await avisarDe(config)(m.conversa, `:warning: Não estou conseguindo checar ${descreverMonitoramento(m)} há cerca de um dia (${estado.erro}). O Taki perdeu o faro, mas continua tentando.`);
	}
	atualizarMonitoramento(m.id, { falhas, checado_em: estado.agora });
	return { resultado: "falhou" };
}

// ---------- NÓ: DECIDIR ----------
// só contas, nenhuma IA: o preço de agora é novidade boa ou não?
function noDecidir(estado: typeof Estado.State) {
	const m = estado.monitoramento!;
	const preco = estado.preco;

	// a busca funcionou mas não achou voo nenhum: não é erro e não é aviso
	if (preco === null) {
		atualizarMonitoramento(m.id, { falhas: 0, checado_em: estado.agora });
		return { resultado: "sem-voos" };
	}

	const menorNovo = m.menor_preco === null ? preco.total : Math.min(m.menor_preco, preco.total);
	// com alvo, "bom" é bater o alvo. Sem alvo, "bom" é ser o menor preço já visto.
	const bomPreco = m.preco_alvo !== null ? preco.total <= m.preco_alvo : m.menor_preco !== null && preco.total < m.menor_preco;

	// o preço subiu de novo: a próxima queda merece outro aviso
	if (!bomPreco) {
		atualizarMonitoramento(m.id, { menor_preco: menorNovo, avisado_preco: m.preco_alvo !== null ? null : m.avisado_preco, falhas: 0, checado_em: estado.agora });
		return { resultado: "nada-novo" };
	}

	return { resultado: "preco-bom", menorNovo };
}

// ---------- NÓ: AVISAR ----------
// só avisa se for novidade. Se o Slack falhar, nada é gravado, e a próxima checagem tenta de novo.
async function noAvisar(estado: typeof Estado.State, config: LangGraphRunnableConfig) {
	const m = estado.monitoramento!;
	const preco = estado.preco!;

	if (m.avisado_preco === null || preco.total < m.avisado_preco) {
		const motivo = m.preco_alvo !== null ? `seu alvo é R$ ${m.preco_alvo}` : `era R$ ${m.menor_preco}`;
		const links = [preco.ida.link, preco.volta?.link].filter(Boolean).join("\n");
		await avisarDe(config)(m.conversa, `:dog: *Au au! Preço bom!* ${descreverMonitoramento(m)}: *R$ ${preco.total}* (${motivo}).\nComprar:\n${links}`);
		atualizarMonitoramento(m.id, { avisado_preco: preco.total });
	}
	atualizarMonitoramento(m.id, { menor_preco: estado.menorNovo, falhas: 0, checado_em: estado.agora });
	return {};
}

// ---------- ARESTAS CONDICIONAIS ----------
// a porta de entrada: encerra o que já passou, e segura a busca quando o teto do dia estourou.
// O teto é conferido aqui, antes de qualquer pedido ao Google, e não avisa no Slack: é limite nosso, não notícia.
// Quem é pulado não grava checado_em, então o próximo pulso do relógio tenta de novo.
function porOndeComecar(estado: typeof Estado.State) {
	const m = estado.monitoramento!;
	if (m.data < hojeEmSaoPaulo()) return "encerrar";
	const quantas = quantasBuscas(m);
	if (!reservarBuscas(estado.agora, quantas)) {
		console.log(`[monitor] #${m.id} pulado: o teto de ${TETO_DIARIO_DE_BUSCAS} buscas por dia já estourou (esta checagem custaria ${quantas})`);
		return END;
	}
	return "buscar";
}

function depoisDeDecidir(estado: typeof Estado.State) {
	return estado.resultado === "preco-bom" ? "avisar" : END;
}

// ---------- GRAFO ----------
// exportado para o floorplan desenhar a camada de cima a partir do grafo de verdade, não de uma cópia à mão
export const grafo = new StateGraph(Estado)
	.addNode("encerrar", noEncerrar)
	.addNode("buscar", noBuscar, {
		retryPolicy: {
			maxAttempts: TENTATIVAS_DA_BUSCA,
			initialInterval: ESPERA_DA_RETENTATIVA,
			retryOn: (erro) => VALE_TENTAR_DE_NOVO.test(String(erro?.message ?? "")),
		},
		// roda só depois que as tentativas acabaram. O Command é o que faz o grafo continuar pelo nó "falhou":
		// devolver só o estado pararia o grafo ali.
		errorHandler: (_estado, erro) => new Command({ goto: "falhou", update: { erro: String(erro.error?.message ?? erro.message) } }),
		// o desvio do errorHandler é dinâmico: sem declarar aqui, o desenho mostraria "falhou" como uma caixa solta
		ends: ["falhou"],
	})
	.addNode("falhou", noFalhou)
	.addNode("registrar", noRegistrar)
	.addNode("decidir", noDecidir)
	.addNode("avisar", noAvisar)
	.addConditionalEdges(START, porOndeComecar, ["encerrar", "buscar", END])
	.addEdge("buscar", "registrar")
	.addEdge("registrar", "decidir")
	.addConditionalEdges("decidir", depoisDeDecidir, ["avisar", END])
	.addEdge("encerrar", END)
	.addEdge("falhou", END)
	.addEdge("avisar", END)
	.compile();

// ---------- CHECAR TODOS ----------
export async function checarMonitoramentos(avisar: Canais, agora = Date.now(), espera = ESPERA_ENTRE_MONITORAMENTOS) {
	const vencidos = listarMonitoramentos().filter((monitoramento) => agora - monitoramento.checado_em >= INTERVALO_ENTRE_CHECAGENS);
	for (const monitoramento of vencidos) {
		try {
			// uma volta do grafo por monitoramento, e cada volta vira um trace no Langfuse
			await grafo.invoke({ monitoramento, agora }, { configurable: { avisar }, callbacks: rastrear("monitor-" + monitoramento.id, "monitor") });
		} catch (erro) {
			// um monitoramento com problema não pode parar os outros
			console.log(`[monitor] #${monitoramento.id} não terminou: ${(erro as Error).message}`);
		}
		await new Promise((pronto) => setTimeout(pronto, espera));
	}
	return vencidos.length;
}

// ---------- O RELÓGIO ----------
// o LangGraph não tem relógio: alguém de fora precisa chamar o grafo de hora em hora. É este pedaço.
export function ligarMonitor(avisar: Canais) {
	let rodando = false;    // uma checagem demorada não pode começar por cima da outra
	const pulso = async () => {
		if (rodando) return;
		rodando = true;
		try {
			const quantos = await checarMonitoramentos(avisar);
			if (quantos > 0) console.log(`[monitor] ${quantos} monitoramento(s) checado(s)`);
		} catch (erro) {
			console.log("[monitor] a checagem falhou:", erro);
		}
		rodando = false;
	};
	pulso();
	setInterval(pulso, PULSO_DO_RELOGIO);
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	if (process.argv[2] === "--desenho") {
		// o Mermaid roda no seu navegador: nada do grafo sai do Mac
		const desenho = await grafo.getGraphAsync();
		// o LangGraph cria um nó interno para o errorHandler. Ele não é uma etapa nossa e aparece solto no
		// desenho, sem seta nenhuma; o que ele faz já está desenhado na seta pontilhada de buscar para falhou.
		const mermaid = desenho.drawMermaid().split("\n").filter((linha) => !linha.includes("__error_handler__")).join("\n");
		await writeFile(import.meta.dirname + "/price-watch.html", `<!doctype html>
<meta charset="utf-8">
<title>Grafo do monitor</title>
<pre class="mermaid">${mermaid}</pre>
<script type="module">
	import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
	mermaid.initialize({ startOnLoad: true });
</script>`);
		console.log("Desenho salvo em brain/price-watch.html");
	} else {
		const quantos = await checarMonitoramentos(async (conversa, texto) => console.log(`[para ${conversa}] ${texto}`));
		console.log(`${quantos} monitoramento(s) checado(s)`);
		await enviarRastreio();
	}
}
