// judges.ts - os juízes de fatos da prova, sem efeito colateral, para o tests.ts poder testá-los
//
// O exam.ts importa daqui. Nada aqui chama o bot nem carrega o grafo: importar este arquivo não roda a prova.

import { RESPOSTA_QUE_NAO_SAIU } from "../brain/checker.ts";
import { BASE, catalogo } from "./scenarios.ts";

type Busca = { origem: string; destino: string; data: string; adultos?: number; criancas?: number; classe?: string };

export const companhias = BASE.map((voo) => voo.companhia);

function numeroEmReais(texto: string) {
	return Number(texto.replace(/[.\s]/g, "").replace(",", "."));
}

function horasEmMinutos(horas: string, minutos?: string) {
	return Number(horas) * 60 + Number(minutos ?? 0);
}

// confere a resposta sem usar nada do bot: um preço ou uma duração ao lado de uma companhia
// tem de ser daquela companhia. Foi assim que nasceu o erro "Air Europa, 10h de viagem".
export function fatosErrados(resposta: string, buscas: Busca[]) {
	const problemas: string[] = [];
	const precosDasBuscas = buscas.flatMap((busca) => catalogo(busca.origem, busca.destino, busca.data, busca.adultos, busca.criancas, busca.classe));
	for (const linha of resposta.split("\n")) {
		const nomes = companhias.filter((nome) => linha.includes(nome));
		if (nomes.length !== 1) continue;
		const nome = nomes[0];
		const doVoo = precosDasBuscas.filter((voo) => voo.companhia === nome);

		const precos = [...linha.matchAll(/R\$\s*(\d{1,3}(?:[.   ]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g)].map((achado) => numeroEmReais(achado[1]));
		// fora dessa faixa é uma soma ou uma diferença de preços, e não o preço de um voo
		const faixa = doVoo.map((voo) => voo.preco);
		const pareceOPreco = faixa.length === 0 || (precos[0] >= Math.min(...faixa) * 0.5 && precos[0] <= Math.max(...faixa) * 1.5);
		// "coût-bénéfice" e "preço médio" não são o preço do voo: nos 10 mil, 4 respostas certas caíram aqui
		if (precos.length === 1 && pareceOPreco && !doVoo.some((voo) => voo.preco === precos[0]) && !/custo|b[eé]n[eé]f|equivalente|total|soma|a mais|diferen|ida e volta|m[eé]di[ao]|moyen|average|promedio|cupom|desconto|parcela|por pessoa|cada um/i.test(linha)) problemas.push(`preço errado para ${nome}: ${linha}`);

		const duracoes = [...linha.matchAll(/(\d{1,2})\s*h(?:oras?)?(?:\s*e)?\s*(\d{2})?(?:\s*min(?:utos)?)?\s*(?:de\s+)?(?:viagem|voo|dura)/gi)];
		for (const achado of duracoes) {
			const minutos = horasEmMinutos(achado[1], achado[2]);
			// a linha pode comparar com outro voo ("em vez de 24h35"), então vale qualquer duração que exista
			// "economiza 14h15 de viagem" é uma diferença, e não a duração de um voo
			if (/economiz|a mais|a menos|diferen|saves?\b|less|more/i.test(linha)) continue;
			if (!precosDasBuscas.some((voo) => voo.duracao_min === minutos)) problemas.push(`duração errada para ${nome}: ${linha}`);
		}
	}
	return problemas;
}

// a frase de desistência tem "?", e passaria em todo cenário que só pede uma pergunta ou proíbe preço
export function desistiu(resposta: string) {
	return resposta.includes(RESPOSTA_QUE_NAO_SAIU) ? ["o bot desistiu: " + RESPOSTA_QUE_NAO_SAIU] : [];
}

// "R$ 3.147,50" e "3 147.50" contam como 3147.5
export function temValor(resposta: string, valor: number) {
	const semPontos = resposta.replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d)[.\s](\d{3})/g, "$1$2").replace(/(\d),(\d)/g, "$1.$2");
	return semPontos.includes(String(valor));
}

// o que já terminou não roda de novo, e vale a última linha de cada caso, como no scoreboard.ts.
// Um cenário que parou por erro de rede ou de crédito roda sim, porque não diz nada sobre o modelo. Com REFAZER=falhas, os reprovados também
export function casosTerminados(linhas: { caso: string; passou?: boolean; erro?: string }[], refazer = "") {
	const ultimas = new Map(linhas.filter((linha) => !linha.erro).map((linha) => [linha.caso, linha]));
	return new Set([...ultimas.values()].filter((linha) => refazer !== "falhas" || linha.passou).map((linha) => linha.caso));
}

// as datas sem ano ("12/12", "sexta") mudam com o dia: o REJULGAR só vira o veredito de uma linha gravada hoje.
// A conversa da prova termina com o Date.now() do começo do caso; sem ele, conta como outro dia
export function gravadaEmOutroDia(conversa: string, agora = new Date()) {
	const dia = (data: Date) => data.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
	return dia(new Date(Number(conversa.split(" ").at(-1)))) !== dia(agora);
}
