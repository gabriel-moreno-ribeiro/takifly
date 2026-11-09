// live.ts - o painel ao vivo: mostra no navegador cada passo do grafo, na hora em que o bot trabalha
//
// O grafo avisa o começo e o fim de cada nó por um callback do LangChain (ouvinteAoVivo, ligado em rodar()
// no graph.ts). Os avisos ficam numa lista curta na memória e vão para a página brain/live.html por SSE,
// que acende o nó no desenho. Nada vai para a internet: o servidor só escuta no próprio Mac (127.0.0.1).
//
// Para ver:   com o bot ligado (bot.ts liga o painel sozinho), abra http://localhost:4500
// O painel é um enfeite: qualquer erro aqui vira uma linha no log e o bot segue respondendo.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { nomesDosModelos } from "./models.ts";

const PORTA = 4500;
const GUARDADOS = 400;    // quantos avisos a página recebe ao abrir: dá para ver os últimos pedidos

// fase "nota": o que acontece fora de um nó (a planilha escolhida, a espera, o juiz, o cancelamento, o contexto).
// link vira um link clicável na página; ate é quando uma espera acaba, para a página contar os segundos.
export type Aviso = { hora: string; conversa: string; no: string; fase: "inicio" | "fim" | "erro" | "modelo" | "nota"; detalhe: string; link?: string; ate?: string };

export const avisos: Aviso[] = [];
const paginas = new Set<ServerResponse>();

function publicar(aviso: Aviso) {
	avisos.push(aviso);
	if (avisos.length > GUARDADOS) avisos.shift();
	for (const pagina of paginas) pagina.write(`data: ${JSON.stringify(aviso)}\n\n`);
}

// quem está fora do grafo conta ao painel por aqui. Como o resto do painel, nunca derruba quem chamou
export function anotarNoPainel(conversa: string, no: string, detalhe: string, extra: Pick<Aviso, "link" | "ate"> = {}) {
	try {
		publicar({ hora: new Date().toISOString(), conversa, no, fase: "nota", detalhe, ...extra });
	} catch (erro: any) {
		console.log(`[painel] aviso perdido: ${erro.message}`);
	}
}

const corta = (texto: unknown, tamanho = 160) => String(texto ?? "").replace(/\s+/g, " ").trim().slice(0, tamanho);

// o que cada nó decidiu, numa linha: a saída do nó é a parte do estado que ele mudou
export function resumirSaida(no: string, saida: any) {
	if (!saida || typeof saida !== "object") return "";
	const mensagem = saida.messages?.[0];
	const chamadas = mensagem?.tool_calls ?? [];
	if (chamadas.length > 0) return "pediu: " + chamadas.map((chamada: any) => `${chamada.name}(${corta(Object.values(chamada.args ?? {}).join(", "), 60)})`).join("; ");
	if (no === "ferramentas") return (saida.messages ?? []).map((resposta: any) => corta(String(resposta.content).split("\n")[0], 90)).join(" | ");
	if (no === "orquestrador") {
		// "idioma" só vem no plano do começo do pedido; sem ele, é a volta de um especialista
		if (!("plano" in saida)) return "segue o plano, sem chamar o modelo";
		if ("idioma" in saida) return saida.plano.length > 0 ? "plano: " + saida.plano.join(" → ") : "ninguém precisa trabalhar";
		return saida.plano.length > 0 ? "refez o plano: " + saida.plano.join(" → ") : "parou de replanejar: responde com o que tem";
	}
	if (saida.feitos?.length) return "voltou: " + corta(saida.feitos.at(-1));
	if (saida.correcao && no === "verificar") return "recusou: " + corta(saida.correcao.split("Problemas:")[1] ?? saida.correcao);
	if (saida.correcao) return "bilhete: " + corta(saida.correcao);
	if (no === "verificar") return "aprovou";
	if (no === "contexto") return saida.resumo ? "resumo novo: " + corta(saida.resumo) : "nada a resumir";
	if (saida.recados?.length) return corta(saida.recados.at(-1));
	if (mensagem?.content) return corta(mensagem.content);
	return "";
}

// O callback do LangChain. Um nó do grafo começa com a etiqueta "graph:step:N" e o nome em langgraph_node;
// o resto (o modelo, o zod, o parser) roda dentro dele e não aparece como nó.
export function ouvinteAoVivo(conversa: string) {
	const nos = new Map<string, string>();    // runId → nó, para saber quem terminou
	const avisar = (no: string, fase: Aviso["fase"], detalhe = "") => {
		try {
			publicar({ hora: new Date().toISOString(), conversa, no, fase, detalhe });
		} catch (erro: any) {
			console.log(`[painel] aviso perdido: ${erro.message}`);
		}
	};
	return {
		handleChainStart(_cadeia: unknown, _entrada: unknown, runId: string, _pai?: string, etiquetas?: string[], meta?: Record<string, any>) {
			const no = meta?.langgraph_node;
			if (!no || no === "__start__" || !etiquetas?.some((etiqueta) => etiqueta.startsWith("graph:step:"))) return;
			nos.set(runId, no);
			avisar(no, "inicio");
		},
		handleChainEnd(saida: unknown, runId: string) {
			const no = nos.get(runId);
			if (!no) return;
			nos.delete(runId);
			let detalhe = "";
			try {
				detalhe = resumirSaida(no, saida);
			} catch {}
			avisar(no, "fim", detalhe);
		},
		handleChainError(erro: Error, runId: string) {
			const no = nos.get(runId);
			if (!no) return;
			nos.delete(runId);
			avisar(no, "erro", corta(erro?.message));
		},
		handleChatModelStart(_modelo: unknown, _cartas: unknown, _runId: string, _pai?: string, extra?: Record<string, any>, _etiquetas?: string[], meta?: Record<string, any>) {
			avisar(meta?.langgraph_node ?? "?", "modelo", String(meta?.ls_model_name ?? extra?.invocation_params?.model ?? ""));
		},
	};
}

// ---------- AS CONVERSAS E O CONTEXTO ----------
// o painel não importa o grafo (o grafo importa o painel): quem liga o painel entrega as ações (brain/channel.ts)
export type AcoesDoPainel = {
	conversas(): string[] | Promise<string[]>;
	retrato(conversa: string): Promise<unknown>;
	executar(conversa: string, acao: "compactar" | "excluir"): Promise<string>;
};

//   GET  /conversas                   a lista das conversas que têm memória
//   GET  /conversas/<id>              o retrato de uma (brain/context.ts)
//   POST /conversas/<id>/compactar    e /excluir: só com o Origin do próprio painel. Sem isto, qualquer página aberta
//                                     no navegador poderia mandar um POST para cá e apagar a memória de alguém
async function rotaDasConversas(pedido: IncomingMessage, resposta: ServerResponse, acoes: AcoesDoPainel | undefined, origens: string[]) {
	const partes = new URL(pedido.url ?? "/", "http://painel").pathname.split("/").filter(Boolean).map(decodeURIComponent);
	const json = (codigo: number, corpo: unknown) => resposta.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(corpo));
	const [, conversa, acao] = partes;
	if (!acoes) return json(404, { erro: "o painel foi ligado sem as ações das conversas" });
	if (conversa !== undefined && !/^[\w.:-]{1,80}$/.test(conversa)) return json(400, { erro: "conversa inválida" });
	try {
		if (pedido.method === "GET" && partes.length === 1) return json(200, await acoes.conversas());
		if (pedido.method === "GET" && partes.length === 2) return json(200, await acoes.retrato(conversa));
		if (pedido.method === "POST" && partes.length === 3 && (acao === "compactar" || acao === "excluir")) {
			if (!origens.includes(pedido.headers.origin ?? "")) return json(403, { erro: "pedido de fora do painel" });
			return json(200, { texto: await acoes.executar(conversa, acao) });
		}
		return json(404, { erro: "rota que não existe" });
	} catch (erro: any) {
		console.log(`[painel] a rota ${pedido.method} ${pedido.url} quebrou: ${erro.message}`);
		return json(500, { erro: "não deu certo; o motivo está no log do bot" });
	}
}

// Liga o servidor da página. Porta ocupada ou página faltando não derrubam o bot: só avisam no log.
export function ligarPainel(porta = PORTA, acoes?: AcoesDoPainel) {
	let pagina: string;
	try {
		const { forte, especialista } = nomesDosModelos();
		pagina = readFileSync(import.meta.dirname + "/live.html", "utf8").replaceAll("{{FORTE}}", forte).replaceAll("{{BARATO}}", especialista);
	} catch (erro: any) {
		console.log(`[painel] sem a página brain/live.html (${erro.message}). O bot segue sem o painel.`);
		return undefined;
	}
	const servidor = createServer((pedido, resposta) => {
		// só atende quem chama pelo nome do próprio Mac: um site aberto no navegador que aponte o domínio dele
		// para 127.0.0.1 (DNS rebinding) leria as mensagens do Slack que passam por aqui
		const minhaPorta = (servidor.address() as any)?.port;
		const nomes = [`localhost:${minhaPorta}`, `127.0.0.1:${minhaPorta}`];
		if (!nomes.includes(pedido.headers.host ?? "")) {
			resposta.writeHead(403).end();
			return;
		}
		if (pedido.url === "/conversas" || pedido.url?.startsWith("/conversas/")) {
			void rotaDasConversas(pedido, resposta, acoes, nomes.map((nome) => "http://" + nome)).catch((erro) => {
				console.log(`[painel] ${erro.message}`);
				if (!resposta.headersSent) resposta.writeHead(500).end();
			});
			return;
		}
		if (pedido.method !== "GET") {
			resposta.writeHead(405).end();
			return;
		}
		if (pedido.url === "/eventos") {
			resposta.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
			resposta.flushHeaders();    // sem isto, com a lista vazia (bot recém-ligado) a página ficaria em "conectando…"
			for (const aviso of avisos) resposta.write(`data: ${JSON.stringify(aviso)}\n\n`);
			paginas.add(resposta);
			pedido.on("close", () => paginas.delete(resposta));
			return;
		}
		// sem cache: depois de uma atualização do bot, a página velha não pode aparecer
		resposta.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		resposta.end(pagina);
	});
	servidor.on("error", (erro: any) => console.log(`[painel] não liguei o painel na porta ${porta}: ${erro.message}. O bot segue sem ele.`));
	servidor.listen(porta, "127.0.0.1", () => console.log(`[painel] ao vivo em http://localhost:${(servidor.address() as any)?.port}`));
	return servidor;
}
