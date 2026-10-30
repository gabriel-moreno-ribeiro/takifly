// planilha.ts - cria uma planilha no Google Sheets com os voos encontrados
//
// Quem cria a planilha é o Apps Script que você já implantou (passagens/planilha_viva.gs).
// Ele é um endereço na internet (PLANILHA_VIVA_URL, no .env): mandamos as abas e ele devolve o link.

import type { Voo } from "./voos.ts";

function horas(minutos: number) {
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
		const barato = porPreco[0];
		const rapido = porDuracao[0];

		resumo.push([nome, lista.length, barato.preco, barato.companhia, barato.saida, rapido.preco, horas(rapido.duracao_min)]);
		abasDosTrechos.push({
			nome,
			colunas: ["companhia", "preco", "escalas", "duracao", "saida", "chegada", "link"],
			linhas: porPreco.map((voo) => [voo.companhia, voo.preco, voo.escalas, horas(voo.duracao_min), voo.saida, voo.chegada, voo.link]),
		});
	}

	return [
		{
			nome: "Resumo",
			colunas: ["trecho", "voos", "mais_barato", "companhia", "saida", "mais_rapido", "duracao_mais_rapido"],
			linhas: resumo,
		},
		...abasDosTrechos,
	];
}

// ---------- CRIAR A PLANILHA ----------
// devolve o link da planilha nova; se algo der errado, lança um erro com a explicação
export async function criarPlanilha(titulo: string, voos: Voo[]): Promise<string> {
	const endereco = process.env.PLANILHA_VIVA_URL;
	if (!endereco) throw new Error("falta PLANILHA_VIVA_URL no arquivo .env");

	const resposta = await fetch(endereco, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ titulo, abas: montarAbas(voos) }),
	});
	if (!resposta.ok) throw new Error("o Google respondeu com erro " + resposta.status);

	const dados = await resposta.json();
	if (!dados.link) throw new Error("o Google não devolveu o link da planilha");
	return dados.link;
}
