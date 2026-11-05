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
// uma aba "Resumo" com uma linha por trecho, e uma aba por trecho com todos os voos
export function montarAbas(voos: Voo[]) {
	const trechos = new Map<string, Voo[]>();
	for (const voo of voos) {
		const nome = voo.origem + "→" + voo.destino + " " + voo.data.slice(8, 10) + "/" + voo.data.slice(5, 7);
		trechos.set(nome, [...(trechos.get(nome) ?? []), voo]);
	}

	const resumo = [];
	const abasDosTrechos = [];
	for (const [nome, lista] of trechos) {
		const porPreco = lista.toSorted((a, b) => a.preco - b.preco);
		const porDuracao = lista.toSorted((a, b) => a.duracao_min - b.duracao_min);
		const porCustoBeneficio = lista.toSorted((a, b) => precoEquivalente(a) - precoEquivalente(b));
		const barato = porPreco[0];
		const rapido = porDuracao[0];
		const melhor = porCustoBeneficio[0];

		resumo.push([nome, lista.length, barato.preco, barato.companhia, barato.saida, melhor.preco, melhor.companhia, rapido.preco, horas(rapido.duracao_min)]);
		abasDosTrechos.push({
			nome,
			colunas: ["companhia", "preco", "custo_beneficio", "escalas", "duracao", "saida", "chegada", "link"],
			linhas: porPreco.map((voo) => [voo.companhia, voo.preco, precoEquivalente(voo), voo.escalas, horas(voo.duracao_min), voo.saida, voo.chegada, voo.link]),
		});
	}

	return [
		{
			nome: "Resumo",
			colunas: ["trecho", "voos", "mais_barato", "companhia", "saida", "melhor_custo_beneficio", "companhia_cb", "mais_rapido", "duracao_mais_rapido"],
			linhas: resumo,
		},
		...abasDosTrechos,
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
