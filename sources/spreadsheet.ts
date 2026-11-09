// spreadsheet.ts - cria uma planilha no Google Sheets com os voos encontrados
//
// Quem cria a planilha é o Apps Script que você já implantou (a cópia do código está em spreadsheet.gs).
// Ele é um endereço na internet (PLANILHA_VIVA_URL, no .env): mandamos as abas e ele devolve o link.
//
// São dois usos, os dois por atualizarPlanilha: a pesquisa do bot tem uma planilha por par de cidades
// (abasDaPesquisa, reescrita a cada pesquisa nova do par), e o monitor volta na planilha dele a cada
// checagem para acrescentar o preço de agora.

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

// o voo que já está numa planilha leva a hora em que foi checado: reescrever a planilha não pode dizer que é de agora
export type VooDaPlanilha = Voo & { checado?: string };

const agoraEmSaoPaulo = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).replace(",", "") + " BRT";

export function montarAbas(voos: VooDaPlanilha[]) {
	const trecho = (voo: Voo) => voo.origem + voo.destino + voo.data;
	const media = new Map<string, number>();
	for (const [chave, lista] of Map.groupBy(voos, trecho)) {
		media.set(chave, lista.reduce((soma, voo) => soma + voo.preco, 0) / lista.length);
	}
	const caro = (voo: Voo) => voo.preco > LIMITE_DA_MEDIA * media.get(trecho(voo))!;

	const checado = agoraEmSaoPaulo();
	const linha = (voo: VooDaPlanilha) => {
		const [ano, mes, dia] = voo.data.split("-");
		// chegada vem como "12/12 20:00": no mesmo dia basta a hora, em outro dia a data fica
		const chegada = voo.chegada.startsWith(dia + "/" + mes + " ") ? voo.chegada.slice(6) : voo.chegada;
		const tipo = voo.escalas === 0 ? "direto" : voo.escalas === 1 ? "1 escala" : voo.escalas + " escalas";
		return [dia + "/" + mes + "/" + ano, voo.checado ?? checado, tipo, voo.companhia, voo.saida + "-" + chegada, voo.origem, voo.destino, voo.preco, precoEquivalente(voo), horas(voo.duracao_min), "Google Flights", voo.link];
	};

	const colunas = ["data_voo", "data_check", "tipo", "cia", "horario", "origem", "destino", "preco", "custo_beneficio", "duracao", "provider", "link"];
	const ordenados = voos.toSorted((a, b) => a.data.localeCompare(b.data) || trecho(a).localeCompare(trecho(b)) || a.preco - b.preco);
	return [
		{ nome: "Voos", colunas, linhas: ordenados.filter((voo) => !caro(voo)).map(linha) },
		{ nome: "Acima de " + String(LIMITE_DA_MEDIA).replace(".", ",") + "x a média", colunas, linhas: ordenados.filter(caro).map(linha) },
	];
}

// ---------- NO MÁXIMO 100 VOOS POR PLANILHA ----------
// uma busca flexível de São Paulo traz centenas de voos, e ninguém lê uma planilha assim. Quando passa do limite,
// ficam primeiro o mais barato, o mais rápido e o de melhor custo-benefício de cada trecho (rota + data), depois
// os diretos, e o resto completa por custo-benefício. Com mais de 33 trechos, os três de cada um já passam de 100:
// aí entram o mais barato de todos os trechos, depois o mais rápido de todos, e o custo-benefício é o primeiro a faltar.
// "garantidos" diz quais desses três couberam em todos os trechos, para a planilha não prometer o que não fez.
export const LIMITE_DE_VOOS = 100;
const OS_TRES = ["o mais barato", "o mais rápido", "o de melhor custo-benefício"];

export function voosQueCabem<T extends Voo>(voos: T[], limite = LIMITE_DE_VOOS) {
	if (voos.length <= limite) return { ficam: voos, fora: 0, garantidos: OS_TRES };
	const trechos = [...Map.groupBy(voos, (voo) => voo.origem + voo.destino + voo.data).values()];
	const melhor = (lista: T[], nota: (voo: T) => number) => lista.reduce((escolhido, voo) => (nota(voo) < nota(escolhido) ? voo : escolhido));
	const porCustoBeneficio = (a: T, b: T) => precoEquivalente(a) - precoEquivalente(b);
	const deCadaTrecho = [(voo: T) => voo.preco, (voo: T) => voo.duracao_min, precoEquivalente].map((nota) => trechos.map((lista) => melhor(lista, nota)));
	const ordem = [...deCadaTrecho.flat(), ...voos.filter((voo) => voo.escalas === 0).toSorted(porCustoBeneficio), ...voos.toSorted(porCustoBeneficio)];
	const ficam = [...new Set(ordem)].slice(0, limite);
	const ficou = new Set(ficam);
	return { ficam, fora: voos.length - ficam.length, garantidos: OS_TRES.filter((_, i) => deCadaTrecho[i].every((voo) => ficou.has(voo))) };
}

// As abas da planilha de um par de cidades, todas para reescrever: a pesquisa nova troca o que estava lá.
// O Apps Script pula aba sem linha nenhuma, e aí a aba velha ficaria com os voos de antes: aba vazia vai com uma
// linha dizendo que está vazia. A última aba diz quantos voos ficaram de fora (o .gs não muda: é só mais uma aba).
export function abasDaPesquisa(voos: VooDaPlanilha[]) {
	const agora = agoraEmSaoPaulo();
	const { ficam, fora, garantidos } = voosQueCabem(voos.map((voo) => (voo.checado ? voo : { ...voo, checado: agora })));
	const abas: Aba[] = montarAbas(ficam).map((aba) => ({ ...aba, modo: "reescrever", linhas: aba.linhas.length > 0 ? aba.linhas : [aba.colunas.map((_, i) => (i === 0 ? "nenhum voo aqui" : ""))] }));
	const faltaram = OS_TRES.filter((qual) => !garantidos.includes(qual));
	const ficaram = garantidos.length === OS_TRES.length
		? `Ficaram ${OS_TRES.slice(0, 2).join(", ")} e ${OS_TRES[2]} de cada trecho, depois os diretos.`
		: `São trechos demais para caberem os três de cada um: ${garantidos.length > 0 ? `ficou ${garantidos.join(" e ")} de cada trecho, mas ` : ""}${faltaram.join(" e ")} de alguns trechos ficaram de fora.`;
	const aviso = fora > 0 ? `${ficam.length} voos nesta planilha e ${fora} ficaram de fora: o limite é ${LIMITE_DE_VOOS}. ${ficaram}` : `Todos os ${ficam.length} voos achados estão nesta planilha.`;
	abas.push({ nome: "Sobre esta planilha", colunas: ["aviso", "atualizada_em"], linhas: [[aviso, agora]], modo: "reescrever" });
	return { abas, ficam, fora };
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

// ---------- ATUALIZAR UMA PLANILHA QUE JÁ EXISTE ----------
// planilha = o link (ou o id) de uma planilha que já existe. Passando null, o Apps Script cria a primeira
// e devolve o link: é assim que o monitor ganha a planilha dele sem precisar de um passo separado.
export async function atualizarPlanilha(planilha: string | null, titulo: string, abas: Aba[]): Promise<string> {
	return mandarAoAppsScript({ titulo, planilha, abas });
}

// o mesmo molde do "servicos" em brain/tools.ts: o teste troca esta função por uma de mentira
// para não falar com o Google de verdade.
export const servicos = { atualizarPlanilha };
