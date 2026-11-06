// spreadsheet.ts - cria uma planilha no Google Sheets com os voos encontrados
//
// Quem cria a planilha é o Apps Script que você já implantou (a cópia do código está em spreadsheet.gs).
// Ele é um endereço na internet (PLANILHA_VIVA_URL, no .env): mandamos as abas e ele devolve o link.
//
// São dois usos: a pesquisa do bot cria uma planilha nova (criarPlanilha), e o monitor volta na mesma
// planilha a cada checagem para acrescentar o preço de agora (atualizarPlanilha).

import { precoEquivalente, type Voo } from "./flights.ts";

export function horas(minutos: number) {
	// 1050 -> "17h30"
	return Math.floor(minutos / 60) + "h" + String(minutos % 60).padStart(2, "0");
}

// ---------- ORGANIZAR AS ABAS ----------
// todos os voos numa aba só, uma linha por voo, ordenados por data e preço.
// Os muito caros (acima de LIMITE_DA_MEDIA vezes a média do trecho) vão para uma segunda aba,
// para não esconder os bons no meio deles. A média é de cada trecho (rota + data): assim um trecho
// internacional não joga todos os voos dele para a aba dos caros só por custar mais que um nacional.
const LIMITE_DA_MEDIA = 1.5;

export function montarAbas(voos: Voo[]) {
	const trecho = (voo: Voo) => voo.origem + voo.destino + voo.data;
	const media = new Map<string, number>();
	for (const [chave, lista] of Map.groupBy(voos, trecho)) {
		media.set(chave, lista.reduce((soma, voo) => soma + voo.preco, 0) / lista.length);
	}
	const caro = (voo: Voo) => voo.preco > LIMITE_DA_MEDIA * media.get(trecho(voo))!;

	const checado = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).replace(",", "") + " BRT";
	const linha = (voo: Voo) => {
		const [ano, mes, dia] = voo.data.split("-");
		// chegada vem como "12/12 20:00": no mesmo dia basta a hora, em outro dia a data fica
		const chegada = voo.chegada.startsWith(dia + "/" + mes + " ") ? voo.chegada.slice(6) : voo.chegada;
		const tipo = voo.escalas === 0 ? "direto" : voo.escalas === 1 ? "1 escala" : voo.escalas + " escalas";
		return [dia + "/" + mes + "/" + ano, checado, tipo, voo.companhia, voo.saida + "-" + chegada, voo.origem, voo.destino, voo.preco, precoEquivalente(voo), horas(voo.duracao_min), "Google Flights", voo.link];
	};

	const colunas = ["data_voo", "data_check", "tipo", "cia", "horario", "origem", "destino", "preco", "custo_beneficio", "duracao", "provider", "link"];
	const ordenados = voos.toSorted((a, b) => a.data.localeCompare(b.data) || trecho(a).localeCompare(trecho(b)) || a.preco - b.preco);
	return [
		{ nome: "Voos", colunas, linhas: ordenados.filter((voo) => !caro(voo)).map(linha) },
		{ nome: "Acima de " + String(LIMITE_DA_MEDIA).replace(".", ",") + "x a média", colunas, linhas: ordenados.filter(caro).map(linha) },
	];
}

// ---------- FALAR COM O APPS SCRIPT ----------
// uma aba do jeito que o Apps Script espera. "modo" só existe na planilha viva:
// acrescentar = empurra as linhas para o fim da aba (o histórico), reescrever = joga a aba fora e põe esta (o resumo).
export type Aba = {
	nome: string;
	colunas: string[];
	linhas: unknown[][];
	modo?: "acrescentar" | "reescrever";
};

// devolve o link da planilha; se algo der errado, lança um erro com a explicação
async function mandarAoAppsScript(corpo: object): Promise<string> {
	const endereco = process.env.PLANILHA_VIVA_URL;
	if (!endereco) throw new Error("falta PLANILHA_VIVA_URL no arquivo .env");

	const resposta = await fetch(endereco, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(corpo),
	});
	if (!resposta.ok) throw new Error("o Google respondeu com erro " + resposta.status);

	const dados = await resposta.json();
	if (!dados.link) throw new Error("o Google não devolveu o link da planilha");
	return dados.link;
}

// ---------- CRIAR A PLANILHA ----------
// sem "planilha" no pedido, o Apps Script cria uma nova. É o que a pesquisa do bot sempre fez.
export async function criarPlanilha(titulo: string, voos: Voo[]): Promise<string> {
	return mandarAoAppsScript({ titulo, abas: montarAbas(voos) });
}

// ---------- ATUALIZAR UMA PLANILHA QUE JÁ EXISTE ----------
// planilha = o link (ou o id) de uma planilha que já existe. Passando null, o Apps Script cria a primeira
// e devolve o link: é assim que o monitor ganha a planilha dele sem precisar de um passo separado.
export async function atualizarPlanilha(planilha: string | null, titulo: string, abas: Aba[]): Promise<string> {
	return mandarAoAppsScript({ titulo, planilha, abas });
}

// o mesmo molde do "servicos" em brain/tools.ts: o teste troca esta função por uma de mentira
// para não falar com o Google de verdade.
export const servicos = { atualizarPlanilha };
