// tools.ts - tudo o que o modelo pode pedir para o código fazer
//
// A ideia: cada decisão ou conta que dá para fazer com código sai da cabeça do modelo.
// Um modelo fraco erra data, soma e filtro; o código não erra. O modelo só escolhe QUAL ferramenta usar.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { hojeEmSaoPaulo, somarDias } from "../rules/dates.ts";
import { aeroportosDoPais, cidadeDoAeroporto, descreverAeroporto, nomeDaCidade, nomesDoAeroporto, resolverAeroportos, semAcento } from "../rules/airports.ts";
import { apagarPreferencia, cancelarMonitoramento, criarMonitoramento, type Dossie, guardarDossie, guardarPreferencia, listarMonitoramentos, listarPreferencias, type Monitoramento } from "../storage/database.ts";
import { buscarHospedagem, conferirPedido as conferirPedidoDeHospedagem, resumirHospedagens } from "../sources/hotels.ts";
import { atualizarPlanilha, horas } from "../sources/spreadsheet.ts";
import { buscarCalendario, buscarVoos, type DiaDoCalendario, precoEquivalente, type Voo } from "../sources/flights.ts";
import { pesquisarNaWeb, resumirAchados } from "../sources/web.ts";
import { descreverClima, verClima } from "../sources/weather.ts";
import { regrasDeEntrada } from "../rules/rules.ts";

// ---------- SERVIÇOS DE FORA ----------
// o que sai do Mac fica neste objeto para a prova (exam.ts) poder trocar por versões de mentira
export const servicos = { buscarVoos, buscarCalendario, buscarHospedagem, atualizarPlanilha, pesquisarNaWeb, verClima, esperar: (ms: number) => new Promise((pronto) => setTimeout(pronto, ms)) };

// ---------- O AVISO DE PROGRESSO DA BUSCA ----------
// o responder (graph.ts) guarda aqui, por conversa, a função que edita o aviso no Slack; a busca grande usa para a barra.
// Um pedido por vez em cada conversa (a fila do bot.ts), então a chave conversa basta
export const avisosDaBusca = new Map<string, (texto: string) => unknown>();

// ---------- O CADERNO ----------
// o que as ferramentas leem e escrevem enquanto o nó "ferramentas" roda; no fim, o nó copia para o Estado do grafo
export type Caderno = {
	voos: Voo[];                 // tudo o que foi pesquisado e ainda vale
	novos: Voo[];                // o que ainda não foi para uma planilha
	buscas: string[];            // as buscas feitas neste pedido
	textosDoUsuario: string[];   // o que a pessoa escreveu: serve para conferir se a data foi mesmo dita
	// as preferências guardadas, separadas: só a trava do lugar as usa. Misturadas aos textos, "mora em Natal"
	// contava como a data "Natal" e soltava qualquer data, e o .at(-1) lia a preferência no lugar da última mensagem
	preferencias?: string[];
	conversa: string;            // de quem são os monitoramentos e as preferências
	// o pedido foi cancelado (brain/channel.ts): o LangGraph para o stream, mas o nó que está rodando segue sozinho.
	// Sem conferir isto, uma busca grande cancelada continuaria indo ao Google em segundo plano
	sinal?: AbortSignal;
};

function cadernoDe(config: any): Caderno {
	return config.configurable.caderno;
}

// não há limite de buscas por pedido: pedido grande só demora mais. Depois das primeiras, o bot vai com calma,
// porque busca demais seguida faz o Google responder "erro 429" e recusar por um tempo (o vigia usa o mesmo Google)
const BUSCAS_SEM_PAUSA = 12;
const PAUSA_ENTRE_BUSCAS = 3_000;
const PAUSA_DEPOIS_DO_429 = 30_000;
const BUSCAS_PARA_A_BARRA = 6;    // a partir daqui a busca mostra a barra e avisa que vai demorar
const CHAMADAS_DE_BUSCA_POR_PEDIDO = 12;    // a trava contra o modelo em loop: conta chamadas da ferramenta, não buscas

// ---------- DATAS ----------
// hojeEmSaoPaulo e somarDias moram em rules/dates.ts; o export abaixo mantém quem já importa daqui funcionando
export { hojeEmSaoPaulo, somarDias };
const MESES = [
	["janeiro", "january", "enero", "janvier", "gennaio", "januar"],
	["fevereiro", "february", "febrero", "fevrier", "febbraio", "februar"],
	["marco", "march", "marzo", "mars", "marz"],
	["abril", "april", "avril", "aprile"],
	["maio", "may", "mayo", "mai", "maggio"],
	["junho", "june", "junio", "juin", "giugno", "juni"],
	["julho", "july", "julio", "juillet", "luglio", "juli"],
	["agosto", "august", "aout"],
	["setembro", "september", "septiembre", "septembre", "settembre"],
	["outubro", "october", "octubre", "octobre", "ottobre", "oktober"],
	["novembro", "november", "noviembre", "novembre"],
	["dezembro", "december", "diciembre", "decembre", "dicembre", "dezember"],
];
const DIAS_DA_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const NOMES_DOS_DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function diaDaSemana(data: string) {
	return NOMES_DOS_DIAS[new Date(data + "T00:00:00Z").getUTCDay()];
}

// monta a data e confere se ela existe: 30/02 vira 02/03 no JavaScript, e aqui isso é erro
function montarData(ano: number, mes: number, dia: number) {
	const data = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
	const existe = !Number.isNaN(Date.parse(data)) && new Date(data + "T00:00:00Z").toJSON().slice(0, 10) === data;
	if (!existe) throw new Error(`a data ${dia}/${mes}/${ano} não existe`);
	return data;
}

// sem ano: se o dia já passou neste ano, é o do ano que vem
function proximaOcorrencia(mes: number, dia: number, hoje: string) {
	const ano = Number(hoje.slice(0, 4));
	const data = montarData(ano, mes, dia);
	return data >= hoje ? data : montarData(ano + 1, mes, dia);
}

// "doze de dezembro" -> "12 de dezembro"
const POR_EXTENSO: Record<string, number> = {
	primeiro: 1, um: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14,
	quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
};

function trocarNumeros(texto: string) {
	return texto
		.replace(/\b(vinte|trinta) e (um|dois|tres|quatro|cinco|seis|sete|oito|nove)\b/g, (_, dezena, unidade) => String(POR_EXTENSO[dezena] + POR_EXTENSO[unidade]))
		.replace(/\b[a-z]+\b/g, (palavra) => (Object.hasOwn(POR_EXTENSO, palavra) ? String(POR_EXTENSO[palavra]) : palavra));
}

// "12 de dezembro", "12. Dezember", "December 12, 2026"
function dataComNomeDoMes(limpo: string, hoje: string) {
	const diaPrimeiro = [...limpo.matchAll(/\b(\d{1,2})(?:\.|º|°|o|st|nd|rd|th)?\s+(?:de\s+|del\s+|of\s+)?([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/g)].map((a) => ({ dia: a[1], nome: a[2], ano: a[3] }));
	const mesPrimeiro = [...limpo.matchAll(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/g)].map((a) => ({ dia: a[2], nome: a[1], ano: a[3] }));
	for (const { dia, nome, ano } of [...diaPrimeiro, ...mesPrimeiro]) {
		const mes = MESES.findIndex((nomes) => nomes.includes(nome)) + 1;
		if (mes > 0) return ano ? montarData(Number(ano), mes, Number(dia)) : proximaOcorrencia(mes, Number(dia), hoje);
	}
	return null;
}

// "12/12", "12.12.26", "12 de dezembro", "dia 13", "amanhã", "daqui a 10 dias", "Natal", "próxima sexta", "2026-12-12" -> AAAA-MM-DD
export function entenderData(texto: string, hoje = hojeEmSaoPaulo()) {
	const limpo = trocarNumeros(semAcento(texto));
	let achado;
	let data;

	// "semana passada" virava os mesmos dias do ano que vem (o proximaOcorrencia só olha para a frente) e a busca rodava
	if (/passad[ao]|ontem|anteontem|yesterday|last (week|month|year)|retrasad/.test(limpo)) throw new Error(`"${texto}" já passou. Pergunte qual é o dia certo, no futuro.`);

	if ((achado = limpo.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) data = montarData(Number(achado[1]), Number(achado[2]), Number(achado[3]));
	else if ((achado = limpo.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/))) data = montarData(Number(achado[3].padStart(4, "20")), Number(achado[2]), Number(achado[1]));
	else if ((achado = limpo.match(/\b(\d{1,2})(?:[/.-]|\s+do\s+)(\d{1,2})\b/))) data = proximaOcorrencia(Number(achado[2]), Number(achado[1]), hoje);
	else if (limpo.includes("vespera de natal")) data = proximaOcorrencia(12, 24, hoje);
	else if (limpo.includes("natal")) data = proximaOcorrencia(12, 25, hoje);
	else if (/vespera de ano novo|reveillon|virada/.test(limpo)) data = proximaOcorrencia(12, 31, hoje);
	else if (limpo.includes("ano novo")) data = proximaOcorrencia(1, 1, hoje);
	else if (limpo.includes("depois de amanha")) data = somarDias(hoje, 2);
	else if (/amanha|tomorrow/.test(limpo)) data = somarDias(hoje, 1);
	else if (/hoje|today/.test(limpo)) data = hoje;
	else if ((achado = limpo.match(/\b(?:daqui a|em)\s+(\d{1,3})\s+dias\b/))) data = somarDias(hoje, Number(achado[1]));
	else if ((data = dataComNomeDoMes(limpo, hoje))) { /* já veio pronta */ }
	else if ((achado = limpo.match(/\bdia\s+(\d{1,2})\b/))) {
		// só o dia: este mês se ainda não passou, senão o mês que vem
		const dia = Number(achado[1]);
		const mesAtual = Number(hoje.slice(5, 7));
		const anoAtual = Number(hoje.slice(0, 4));
		const candidato = montarData(anoAtual, mesAtual, dia);
		data = candidato >= hoje ? candidato : mesAtual === 12 ? montarData(anoAtual + 1, 1, dia) : montarData(anoAtual, mesAtual + 1, dia);
	} else {
		const indice = DIAS_DA_SEMANA.findIndex((nome) => limpo.includes(nome));
		if (indice === -1) throw new Error(`não entendi a data "${texto}". Pergunte qual é o dia.`);
		// de 1 a 7 dias: "sexta" dita numa sexta é a da semana seguinte
		const faltam = ((indice - new Date(hoje + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
		data = somarDias(hoje, faltam);
	}

	if (data < hoje) throw new Error(`a data ${data} já passou. Avise e pergunte qual é o dia certo.`);
	return data;
}

// a trava contra a data inventada: o número do dia ou uma palavra de tempo precisa ter aparecido no que a pessoa escreveu.
// shortcut: "2 adultos" conta como o dia 2, então uma data inventada no dia 2 passaria; suficiente até a prova mostrar o contrário.
export function dataFoiDita(data: string, textos: string[]) {
	const dia = Number(data.slice(8, 10));
	return textos.some((texto) => {
		const limpo = trocarNumeros(semAcento(texto));
		const palavraDeTempo = /hoje|amanha|semana|segunda|terca|quarta|quinta|sexta|sabado|domingo|seguinte|vespera|anterior|depois|antes|daqui|natal|ano novo|reveillon|today|tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday/.test(limpo);
		return palavraDeTempo || new RegExp(`(^|\\D)0?${dia}(\\D|$)`).test(limpo);
	});
}

// ---------- PERÍODOS ----------
// "dezembro", "janeiro de 2027", "dezembro ou janeiro": o mês inteiro, do dia 1 ao último. Mês que já começou vale de
// hoje até o fim dele; mês que já acabou é o do ano que vem. "12/12" continua um dia só, pelo entenderData.
const MAX_DIAS_DO_PERIODO = 180;    // o calendário do Google devolveu 4 meses numa chamada; 6 meses é o teto
const DIAS_SEM_PERIODO = 90;        // "quando estiver mais barato", sem mês: os próximos 3 meses
// sem período, só quando a pessoa quer o mais barato E disse que a data não importa. Sem "barato", "qualquer dia
// serve" continua virando pergunta (cenário data-qualquer-dia): ela não pediu o mais barato
const MAIS_BARATO = /barat|em conta/;
const DATA_NAO_IMPORTA = /qualquer (data|dia|epoca|mes|momento)|tanto faz|datas? flexive|quando (estiver|for|tiver|ficar|sair)|(data|dia|epoca|mes|periodo) mais (barat|em conta)/;
// pedaço de mês não é o mês inteiro: "primeira semana de dezembro" pesquisaria dezembro todo
const PEDACO_DE_MES = /\b(primeira|segunda|terceira|quarta|ultima) (semana|quinzena)|\b(inicio|comeco|meio|metade|fim|final) d[eo]\b/;
// dias soltos ("10/12, 15/12 e 18/12", "10/12 ou 15/12", "10, 15 e 18 de dezembro"): o calendário de 10 a 18 conferiria
// dias que ninguém pediu (prova de 09/11). Esses vão para o buscar_voos, um por dia
const DIAS_SOLTOS = [/(\b\d{1,2}\/\d{1,2}\b[^/]*){3}/, /\b\d{1,2}\/\d{1,2}\s+ou\s+\d{1,2}\/\d{1,2}\b/, /\b\d{1,2}\s*,\s*\d{1,2}\s+(e|ou)\s+\d{1,2}\b/, /\b\d{1,2}\s+ou\s+\d{1,2}\s+de\s+[a-z]+/];

// os meses citados no texto, na ordem em que aparecem
function mesesDoTexto(limpo: string) {
	return MESES.flatMap((nomes, indice) => [...limpo.matchAll(new RegExp(`\\b(?:${nomes.join("|")})\\b(?:\\s+(?:de\\s+)?(\\d{4}))?`, "g"))]
		.map((achado) => ({ mes: indice + 1, ano: achado[1] ? Number(achado[1]) : null, posicao: achado.index })))
		.toSorted((a, b) => a.posicao - b.posicao);
}

// "dezembro" e "dezembro de 2027" são meses; "12 de dezembro" é um dia (tem número fora do ano)
const ehMes = (limpo: string) => mesesDoTexto(limpo).length > 0 && !/\d/.test(limpo.replace(/\b\d{4}\b/g, ""));
const ultimoDiaDoMes = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).toJSON().slice(0, 10);

// o primeiro e o último dia de um texto: uma data é ela mesma; um ou mais meses vão do primeiro ao último.
// Cada mês sem ano é o primeiro que ainda não acabou em aPartirDe, e depois vão em ordem: "janeiro ou dezembro",
// dito em novembro, é dezembro de 2026 a janeiro de 2027
function limitesDoTexto(texto: string, hoje: string, aPartirDe = hoje) {
	const limpo = semAcento(texto);
	if (!ehMes(limpo)) {
		const data = entenderData(texto, hoje);
		return [data, data];
	}
	// "sexta de dezembro" virava a próxima sexta, em novembro
	if (DIAS_DA_SEMANA.some((nome) => limpo.includes(nome))) throw new Error(`"${texto}" não é um período: pergunte os dias.`);
	const limites = mesesDoTexto(limpo).map(({ mes, ano }) => {
		const anoCerto = ano ?? Number(aPartirDe.slice(0, 4)) + (ultimoDiaDoMes(Number(aPartirDe.slice(0, 4)), mes) < aPartirDe ? 1 : 0);
		const fim = ultimoDiaDoMes(anoCerto, mes);
		if (fim < hoje) throw new Error(`${texto} já passou. Avise e pergunte qual é o período certo, no futuro.`);
		return [montarData(anoCerto, mes, 1), fim];
	}).toSorted((a, b) => a[0].localeCompare(b[0]));
	return [limites[0][0] < hoje ? hoje : limites[0][0], limites.at(-1)![1]];
}

export function entenderPeriodo(de: string, ate?: string, hoje = hojeEmSaoPaulo()) {
	const [inicio, fimDoComeco] = limitesDoTexto(de, hoje);
	const fim = ate ? limitesDoTexto(ate, hoje, inicio)[1] : fimDoComeco;
	if (fim < inicio) throw new Error(`o fim do período (${fim}) é antes do começo (${inicio}). Avise e pergunte as datas certas.`);
	const dias = (Date.parse(fim) - Date.parse(inicio)) / 86_400_000 + 1;
	if (dias > MAX_DIAS_DO_PERIODO) throw new Error(`o período de ${inicio} a ${fim} tem ${dias} dias, e o limite é ${MAX_DIAS_DO_PERIODO}. Pergunte quais meses a pessoa prefere.`);
	return [inicio, fim];
}

// os meses pedidos, quando o período é só de meses: "dezembro ou fevereiro" pesquisa de dezembro a fevereiro numa
// chamada só, e janeiro sai depois. Com um dia numa das pontas, vale o intervalo inteiro
export function mesesPedidos(de: string, ate?: string) {
	const textos = [de, ate].filter((texto): texto is string => Boolean(texto)).map(semAcento);
	return textos.every(ehMes) ? new Set(textos.flatMap((texto) => mesesDoTexto(texto).map(({ mes }) => mes))) : null;
}

// o dia com o mês, do jeito que a pessoa escreve: "10/12", "10.12", "10 de dezembro"
function diaEMesDitos(data: string, textos: string[]) {
	const dia = Number(data.slice(8, 10));
	const mes = Number(data.slice(5, 7));
	const jeitos = new RegExp(`(^|\\D)0?${dia}\\s*[/.-]\\s*0?${mes}(\\D|$)|\\b0?${dia}\\s+(de\\s+)?(${MESES[mes - 1].join("|")})\\b`);
	return textos.some((texto) => jeitos.test(trocarNumeros(texto)));
}

// a trava do período, mais dura que a do buscar_voos, porque aqui um período inventado vira até 180 dias:
// o mês (e o ano, se veio) ou o dia COM o mês precisam ter aparecido no que a pessoa escreveu
function conferirPeriodo(caderno: Caderno, de?: string, ate?: string) {
	const textos = caderno.textosDoUsuario.map(semAcento);
	const ultimo = textos.at(-1) ?? "";
	if (DIAS_SOLTOS.some((jeito) => jeito.test(ultimo))) throw new Error("o pedido dá dias soltos, não um período. Chame buscar_voos uma vez para cada dia.");
	if (!de) {
		let ultimoTemData = mesesDoTexto(ultimo).length > 0;
		try {
			ultimoTemData ||= Boolean(entenderData(ultimo));
		} catch { /* sem data na mensagem */ }
		if (ultimoTemData) throw new Error("o pedido traz data ou mês: passe o período em de e ate, como veio no pedido.");
		if (!textos.some((texto) => MAIS_BARATO.test(texto) && DATA_NAO_IMPORTA.test(texto))) throw new Error("a pessoa não disse o mês nem as datas. Não escolha um período: pergunte.");
		const hoje = hojeEmSaoPaulo();
		return [somarDias(hoje, 1), somarDias(hoje, DIAS_SEM_PERIODO)];
	}
	for (const texto of [de, ate].filter((texto): texto is string => Boolean(texto))) {
		const limpo = semAcento(texto).trim();
		if (PEDACO_DE_MES.test(limpo)) throw new Error(`"${texto}" é um pedaço do mês: pergunte os dias exatos.`);
		if (!ehMes(limpo)) {
			const data = entenderData(texto);
			// "natal", "amanhã" valem se a pessoa escreveu a mesma coisa; um número de dia solto, não
			if (!textos.some((pedido) => pedido.includes(limpo)) && !diaEMesDitos(data, textos)) throw new Error(`a data ${data} não aparece no pedido com o dia e o mês. Não escolha uma data: pergunte.`);
			continue;
		}
		for (const { mes, ano } of mesesDoTexto(limpo)) {
			const nome = new RegExp(`\\b(?:${MESES[mes - 1].join("|")})\\b`);
			if (!textos.some((pedido) => nome.test(pedido))) throw new Error(`o mês "${MESES[mes - 1][0]}" não aparece no pedido. Não escolha o período: pergunte.`);
			if (ano && !textos.some((pedido) => pedido.includes(String(ano)))) throw new Error(`o ano ${ano} não aparece no pedido. Passe o mês como veio, sem ano.`);
		}
	}
	return entenderPeriodo(de, ate);
}

// ---------- ESCREVER UM VOO ----------
// a duração já vai em horas: o modelo nunca mais precisa converter minutos (foi assim que "1000 min" virou "10h")
export function descreverVoo(voo: Voo) {
	return `R$ ${voo.preco} | ${voo.companhia} | ${voo.escalas} escala(s) | duração ${horas(voo.duracao_min)} | sai ${voo.saida} | chega ${voo.chegada} | custo-benefício R$ ${precoEquivalente(voo)}`;
}

function nomeDoTrecho(voo: Voo) {
	return `${voo.origem}→${voo.destino} em ${voo.data}`;
}

function agruparPorTrecho(voos: Voo[]) {
	return Map.groupBy(voos, nomeDoTrecho);
}

// o resumo já vem pronto, com os três vencedores escolhidos pelo código
function resumirTrecho(nome: string, voos: Voo[]) {
	const barato = voos.toSorted((a, b) => a.preco - b.preco)[0];
	const rapido = voos.toSorted((a, b) => a.duracao_min - b.duracao_min)[0];
	const melhor = voos.toSorted((a, b) => precoEquivalente(a) - precoEquivalente(b))[0];
	const caro = voos.toSorted((a, b) => b.preco - a.preco)[0];
	// a lista também vai junto: sem ela, o modelo diz que uma companhia "não apareceu" só porque não venceu nada
	const lista = voos.toSorted((a, b) => a.preco - b.preco).slice(0, 10).map(descreverVoo).join("\n");
	const resto = voos.length > 10 ? `\nHá mais ${voos.length - 10} voos: use filtrar_voos para ver.` : "";
	// a média vem pronta: na prova, o analista somou o custo-benefício achando que era preço
	const media = Math.round(voos.reduce((soma, voo) => soma + voo.preco, 0) / voos.length);
	return `${nome} (${voos.length} voos)\nMais barato: ${descreverVoo(barato)}\nMais rápido: ${descreverVoo(rapido)}\nMelhor custo-benefício: ${descreverVoo(melhor)}\nMais caro: ${descreverVoo(caro)}\nPreço médio dos ${voos.length} voos: R$ ${media}\nComprar: ${barato.link}\nOs voos, do mais barato ao mais caro:\n${lista}${resto}`;
}

export function resumirVoos(voos: Voo[]) {
	return [...agruparPorTrecho(voos)].map(([nome, lista]) => resumirTrecho(nome, lista)).join("\n\n");
}

// ---------- PESQUISAR ----------
// devolve os voos, ou null se a mesma busca já foi feita neste pedido (um modelo fraco costuma repetir)
async function pesquisar(caderno: Caderno, origem: string, destino: string, data: string, adultos: number, criancas: number, classe: string) {
	const chave = [origem, destino, data, adultos, criancas, classe].join("|");
	if (caderno.buscas.includes(chave)) return null;
	caderno.sinal?.throwIfAborted();
	if (caderno.buscas.length >= BUSCAS_SEM_PAUSA) await servicos.esperar(PAUSA_ENTRE_BUSCAS);
	caderno.sinal?.throwIfAborted();
	caderno.buscas.push(chave);

	const buscar = () => servicos.buscarVoos(origem, destino, data, adultos, criancas, classe);
	// o Google pediu calma: espera e tenta uma vez mais. Se recusar de novo, vira "A BUSCA FALHOU" como qualquer erro
	const voos = await buscar().catch(async (erro) => {
		if (!/erro 429/.test(erro.message)) throw erro;
		await servicos.esperar(PAUSA_DEPOIS_DO_429);
		return buscar();
	});
	// se o mesmo trecho for pesquisado de novo, ficam só os preços mais recentes
	const outroTrecho = (voo: Voo) => voo.origem !== origem || voo.destino !== destino || voo.data !== data;
	caderno.voos = [...caderno.voos.filter(outroTrecho), ...voos];
	caderno.novos = [...caderno.novos.filter(outroTrecho), ...voos];
	return voos;
}

// "▓▓▓░░░░░░░ 9 de 21": o aviso que a pessoa vê enquanto uma busca grande anda. faltaMs é a estimativa pelo ritmo até agora
export function barraDaBusca(feitas: number, total: number, agora: string, faltaMs: number | null) {
	const cheios = Math.round((feitas / total) * 10);
	const falta = faltaMs === null ? "" : faltaMs < 60_000 ? " · falta menos de 1 min" : ` · falta uns ${Math.round(faltaMs / 60_000)} min`;
	return `:taki: Esse pedido é grande: são ${total} buscas no Google. Vou com calma, então dessa vez demora um pouquinho mais.\n${"▓".repeat(cheios)}${"░".repeat(10 - cheios)} ${feitas} de ${total} · ${agora}${falta}`;
}

// um aeroporto com erro não derruba os outros: a resposta conta o que deu certo e o que falhou
async function pesquisarVarios(caderno: Caderno, origens: string[], destinos: string[], datas: string[], adultos: number, criancas: number, classe: string) {
	if (origens.some((origem) => destinos.includes(origem))) throw new Error("a origem e o destino são o mesmo lugar. Avise e pergunte o destino certo.");
	const achados: Voo[] = [];
	const avisos: string[] = [];
	const total = datas.length * origens.length * destinos.length;
	const avisar = total >= BUSCAS_PARA_A_BARRA ? avisosDaBusca.get(caderno.conversa) : undefined;
	const comeco = Date.now();
	let feitas = 0;
	for (const data of datas) {
		for (const origem of origens) {
			for (const destino of destinos) {
				await avisar?.(barraDaBusca(feitas, total, `${origem}→${destino} em ${data.slice(8, 10)}/${data.slice(5, 7)}`, feitas > 1 ? ((Date.now() - comeco) / feitas) * (total - feitas) : null));
				feitas++;
				try {
					const voos = await pesquisar(caderno, origem, destino, data, adultos, criancas, classe);
					if (voos === null) achados.push(...caderno.voos.filter((voo) => voo.origem === origem && voo.destino === destino && voo.data === data));
					else if (voos.length === 0) avisos.push(`${origem}→${destino} em ${data}: nenhum voo encontrado.`);
					else achados.push(...voos);
				} catch (erro: any) {
					avisos.push(`${origem}→${destino} em ${data}: A BUSCA FALHOU (${erro.message}). Isso não quer dizer que não há voos: avise que a pesquisa falhou e peça para tentar de novo.`);
				}
			}
		}
	}
	return { achados, avisos };
}

function conferirData(caderno: Caderno, texto: string) {
	const data = entenderData(texto);
	if (!dataFoiDita(data, caderno.textosDoUsuario)) throw new Error(`a data ${data} não aparece no pedido. Não escolha uma data: pergunte qual é o dia.`);
	// se o pedido fala em sexta, a data precisa cair numa sexta: modelo fraco erra essa conta
	const ultimo = semAcento(caderno.textosDoUsuario.at(-1) ?? "");
	const citados = DIAS_DA_SEMANA.filter((nome) => ultimo.includes(nome));
	const diaDaData = DIAS_DA_SEMANA[new Date(data + "T00:00:00Z").getUTCDay()];
	if (citados.length > 0 && !citados.includes(diaDaData)) throw new Error(`${data} cai em ${diaDaSemana(data)}, mas o pedido fala em ${citados.join(" ou ")}. Passe a data como veio no pedido, como "próxima sexta".`);
	return data;
}

// a trava contra o lugar inventado: o lugar precisa ter aparecido no que a pessoa escreveu.
// Antes, um código fora da tabela escrita à mão PULAVA a trava, e aí o modelo podia enfiar qualquer
// destino na busca. Agora a tabela é o mundo todo, então a trava vale sempre; só um código sem nome
// de cidade cadastrado (67 aeroportos de 4133) passa reto, e aí quem confere é o Google.
export function conferirLugar(caderno: Caderno, texto: string) {
	const codigos = resolverAeroportos(texto);
	const nomes = nomesDoAeroporto(codigos);
	if (nomes.length === 0) return codigos;
	// o nome vem de fonte de fora e pode ter "-", "." ou "(": sem escapar, viraria regex quebrada
	const formas = [...nomes, ...codigos.map((codigo) => codigo.toLowerCase())].map((forma) => forma.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
	// "moro em Recife" guardado vale como origem dita; para a data e para o "só diretos" não vale (ver o Caderno)
	const textos = [...caderno.textosDoUsuario, ...(caderno.preferencias ?? [])];
	const foiDito = textos.some((pedido) => formas.some((forma) => new RegExp(`\\b${forma}\\b`).test(semAcento(pedido))));
	if (!foiDito) throw new Error(`"${texto}" não aparece no pedido. Não escolha origem nem destino: pergunte.`);
	return codigos;
}

// o destino pode ser um país inteiro ("Alemanha"): os aeroportos grandes dele. A trava é a mesma do lugar: o nome
// do país precisa ter aparecido no que a pessoa escreveu. Cidade ou aeroporto seguem pelo conferirLugar
const MAX_AEROPORTOS_DO_PAIS = 30;    // um calendário por aeroporto: a Alemanha tem 22, o Japão 28, os Estados Unidos 95
function conferirDestinos(caderno: Caderno, texto: string) {
	const pais = aeroportosDoPais(texto);
	if (!pais) return conferirLugar(caderno, texto);
	const textos = [...caderno.textosDoUsuario, ...(caderno.preferencias ?? [])].map(semAcento);
	if (!textos.some((pedido) => pais.nomes.some((nome) => new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`).test(pedido)))) throw new Error(`"${texto}" não aparece no pedido. Não escolha o destino: pergunte.`);
	if (pais.codigos.length === 0) throw new Error(`não conheço aeroporto grande em ${texto}. Pergunte a cidade.`);
	if (pais.codigos.length > MAX_AEROPORTOS_DO_PAIS) throw new Error(`${texto} tem ${pais.codigos.length} aeroportos grandes, é demais para pesquisar de uma vez. Pergunte a cidade ou a região.`);
	return pais.codigos;
}

// aceita "business", "premium economy", "primeira classe"...: o modelo não precisa acertar a palavra exata
export function entenderClasse(texto: string) {
	const limpo = semAcento(texto);
	if (limpo.includes("premium")) return "premium";
	if (/execut|business/.test(limpo)) return "executiva";
	if (/primeira|first/.test(limpo)) return "primeira";
	if (/econom|coach/.test(limpo)) return "economica";
	throw new Error(`a classe "${texto}" não existe. As classes são economica, premium, executiva e primeira: avise e pergunte qual prefere.`);
}

// ---------- OS CAMPOS QUE SE REPETEM ----------
// z.coerce: se o modelo mandar "2" em vez de 2, o código conserta sozinho
const passageiros = {
	adultos: z.coerce.number().int().default(1).describe("Quantos adultos. Se o pedido não disser, 1."),
	criancas: z.coerce.number().int().default(0).describe("Quantas crianças de 2 a 11 anos. Se o pedido não disser, 0."),
	classe: z.string().default("economica").describe("economica, premium, executiva ou primeira. Se o pedido não disser, economica."),
};

function trechoNaMemoria(origem?: string, destino?: string, data?: string) {
	const origens = origem ? resolverAeroportos(origem) : null;
	const destinos = destino ? resolverAeroportos(destino) : null;
	const dia = data ? entenderData(data) : null;
	return (voo: Voo) => (!origens || origens.includes(voo.origem)) && (!destinos || destinos.includes(voo.destino)) && (!dia || voo.data === dia);
}

// ---------- COMO ESCREVER UMA DESCRIPTION ----------
// A description é a única coisa que o modelo lê para escolher a ferramenta. Toda description segue
// a mesma ordem, em até quatro frases:
//   1. o que faz   2. quando usar   3. quando NÃO usar, e qual usar no lugar   4. o que devolve
// A frase 3 é a que evita a troca: duas ferramentas parecidas precisam apontar uma para a outra.

// ---------- FERRAMENTAS PARA ENTENDER E BUSCAR ----------
// a saída de emergência: quando o nome não resolveu sozinho, o modelo vê os candidatos com cidade,
// país e tamanho do aeroporto e pergunta à pessoa qual é. Resolver errado calado é o que não pode.
const listarAeroportos = tool(
	async ({ cidade }) => `${cidade}: ${resolverAeroportos(cidade).map(descreverAeroporto).join(", ")}`,
	{
		name: "listar_aeroportos",
		description: "Lista os aeroportos de uma cidade: código, cidade, país e tamanho. Use só quando a pessoa pediu para ver os aeroportos, ou quando buscar_voos reclamou de um lugar ambíguo. Para pesquisar voos, chame buscar_voos direto com o nome da cidade. Devolve uma linha por aeroporto.",
		schema: z.object({ cidade: z.string() }),
	},
);

const diaDaSemanaFerramenta = tool(
	async ({ texto }) => {
		const data = entenderData(texto);
		return `${data} (${diaDaSemana(data)})`;
	},
	{
		name: "dia_da_semana",
		description: "Converte uma data em palavras (12/12, amanhã, próxima sexta) em AAAA-MM-DD mais o dia da semana. Use só quando a pessoa perguntou em que dia cai uma data. Para pesquisar voos, passe a data direto em buscar_voos, que já entende. Devolve a data e o dia da semana.",
		schema: z.object({ texto: z.string() }),
	},
);

// um dia ou um intervalo de dias, na mesma ferramenta: eram duas (buscar_voos e buscar_varios_dias) e o
// modelo fraco trocava uma pela outra. Um dia devolve o resumo inteiro do trecho; vários, só o mais barato de cada dia.
const buscarVoosFerramenta = tool(
	async ({ origem, destino, data, ate, adultos, criancas, classe }, config) => {
		const caderno = cadernoDe(config);
		// antes isto falhava dentro da busca e virava "A BUSCA FALHOU": o redator pedia para tentar de novo, à toa
		if (adultos + criancas > 9) throw new Error("só pesquiso até 9 passageiros de uma vez. Não pesquise com um número menor: pergunte à pessoa como dividir o grupo.");
		const inicio = conferirData(caderno, data);
		const fim = ate ? conferirData(caderno, ate) : inicio;
		if (fim < inicio) throw new Error(`o último dia (${fim}) é antes do primeiro (${inicio}). Avise e pergunte as datas certas.`);
		const datas: string[] = [];
		for (let dia = inicio; dia <= fim && datas.length < 7; dia = somarDias(dia, 1)) datas.push(dia);

		const classeCerta = entenderClasse(classe);
		// fora da econômica, a classe vai no texto: "classe luxo" não existe, e a resposta precisa dizer qual foi pesquisada
		const cabecalho = classeCerta === "economica" ? [] : [`Classe pesquisada: ${classeCerta}. Diga isso na resposta.`];
		const { achados, avisos } = await pesquisarVarios(caderno, conferirLugar(caderno, origem), conferirLugar(caderno, destino), datas, adultos, criancas, classeCerta);
		if (datas.length === 1) {
			const trechos = [...agruparPorTrecho(achados)].map(([nome, voos]) => resumirTrecho(nome, voos));
			return [...cabecalho, ...trechos, ...avisos].join("\n\n") || "Nenhum voo encontrado.";
		}
		const maisBaratoDoDia = [...Map.groupBy(achados, (voo) => voo.data).values()].map((voos) => voos.toSorted((a, b) => a.preco - b.preco)[0]);
		const linhas = maisBaratoDoDia.toSorted((a, b) => a.preco - b.preco).map((voo) => `${voo.data} (${diaDaSemana(voo.data)}) ${voo.origem}→${voo.destino}: ${descreverVoo(voo)}`);
		const cortado = fim > datas.at(-1)! ? [`Só pesquisei até ${datas.at(-1)}: o limite é de 7 dias.`] : [];
		return [linhas.length ? "Do dia mais barato ao mais caro:" : "Nenhum voo encontrado.", ...linhas, ...avisos, ...cortado].join("\n");
	},
	{
		name: "buscar_voos",
		description: "Pesquisa voos reais só de ida, de uma origem para um destino, em um dia ou em um intervalo de até 7 dias seguidos. Use uma vez por trecho: ida e volta são duas chamadas, com origem e destino invertidos. Para hotel, use buscar_hoteis; não pesquise o que a pessoa não pediu. Devolve, para um dia, o mais barato, o mais rápido, o melhor custo-benefício e a lista por preço; para um intervalo, o mais barato de cada dia.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código do aeroporto, como São Paulo ou GRU"),
			destino: z.string().describe("Cidade ou código do aeroporto, como Lisboa ou LIS"),
			data: z.string().describe("A data como veio no pedido, como 12/12 ou próxima sexta. Num intervalo, o primeiro dia."),
			ate: z.string().optional().describe("Só quando o pedido dá um intervalo de dias seguidos (de 10/12 a 14/12): o último dia. Para um dia só, deixe de fora."),
			...passageiros,
		}),
	},
);

// ---------- O MAIS BARATO NUM PERÍODO OU NUM PAÍS ----------
// "Salvador para a Alemanha, dezembro ou janeiro, o que for mais barato": o buscar_voos olha no máximo 7 dias de uma
// cidade, um dia por chamada ao Google. Aqui, uma chamada ao calendário de preços (sources/flights.ts) cobre o período
// inteiro de uma rota; com um país, uma por aeroporto grande. O calendário é aproximado, então os dias mais baratos
// passam pela busca de verdade, e são esses voos que entram no caderno, na planilha e na resposta.
const PAUSA_ENTRE_CALENDARIOS = 500;
const CONFERIDOS_NA_BUSCA = 2;    // o dia mais barato e o melhor de outra cidade (ou de outro dia)

const buscarMaisBaratoFerramenta = tool(
	async ({ origem, destino, de, ate, adultos, criancas, classe }, config) => {
		const caderno = cadernoDe(config);
		if (adultos + criancas > 9) throw new Error("só pesquiso até 9 passageiros de uma vez. Não pesquise com um número menor: pergunte à pessoa como dividir o grupo.");
		const [inicio, fim] = conferirPeriodo(caderno, de, ate);
		const origens = conferirLugar(caderno, origem);
		const destinos = conferirDestinos(caderno, destino);
		if (origens.some((codigo) => destinos.includes(codigo))) throw new Error("a origem e o destino são o mesmo lugar. Avise e pergunte o destino certo.");
		const classeCerta = entenderClasse(classe);

		const rotas = origens.flatMap((saida) => destinos.map((chegada) => [saida, chegada]));
		const avisar = rotas.length >= BUSCAS_PARA_A_BARRA ? avisosDaBusca.get(caderno.conversa) : undefined;
		const meses = de ? mesesPedidos(de, ate) : null;
		const dias: (DiaDoCalendario & { origem: string; destino: string })[] = [];
		const falhas: string[] = [];
		const comeco = Date.now();
		for (const [feitas, [saida, chegada]] of rotas.entries()) {
			caderno.sinal?.throwIfAborted();
			await avisar?.(barraDaBusca(feitas, rotas.length, `calendário ${saida}→${chegada}`, feitas > 1 ? ((Date.now() - comeco) / feitas) * (rotas.length - feitas) : null));
			if (feitas > 0) await servicos.esperar(PAUSA_ENTRE_CALENDARIOS);
			try {
				for (const dia of await servicos.buscarCalendario(saida, chegada, inicio, fim, adultos, criancas, classeCerta, caderno.sinal)) {
					if (!meses || meses.has(Number(dia.data.slice(5, 7)))) dias.push({ ...dia, origem: saida, destino: chegada });
				}
			} catch (erro: any) {
				caderno.sinal?.throwIfAborted();
				falhas.push(`${saida}→${chegada} (${erro.message})`);
			}
		}
		const periodo = `de ${inicio} a ${fim}`;
		// "A BUSCA FALHOU" é a marca que o verificador conhece: com ela, "a pesquisa falhou" passa e "não há voos" não
		if (dias.length === 0) {
			if (falhas.length > 0) return `A BUSCA FALHOU (calendário de preços): ${falhas.join("; ")}. Isso não quer dizer que não há voos: avise que a pesquisa falhou e peça para tentar de novo.`;
			return `Nenhum voo no calendário do Google ${periodo}.`;
		}
		await avisar?.(barraDaBusca(rotas.length, rotas.length, "conferindo os dias mais baratos na busca de verdade", null));

		const porPreco = dias.toSorted((a, b) => a.preco - b.preco || a.data.localeCompare(b.data));
		// o primeiro de cada grupo é o mais barato dele, porque a lista já vem ordenada pelo preço
		const melhorDeCada = (chave: (dia: (typeof dias)[number]) => string) => [...Map.groupBy(porPreco, chave).values()].map((grupo) => grupo[0]);
		const porCidade = melhorDeCada((dia) => dia.destino);
		const porMes = melhorDeCada((dia) => dia.data.slice(0, 7)).toSorted((a, b) => a.data.localeCompare(b.data));
		const cidade = (iata: string) => `${nomeDaCidade(cidadeDoAeroporto(iata))} (${iata})`;
		// sem "R$": o verificador só aceita preço com moeda, e o do calendário é aproximado. Na resposta, só o da busca de verdade
		const linha = (dia: (typeof dias)[number]) => `${dia.data} (${diaDaSemana(dia.data)}) ${dia.origem}→${cidade(dia.destino)}: calendário ${dia.preco}`;

		const conferir = [porPreco[0], porCidade.length > 1 ? porCidade[1] : porPreco.find((dia) => dia.data !== porPreco[0].data)].filter((dia) => dia !== undefined).slice(0, CONFERIDOS_NA_BUSCA);
		const achados: Voo[] = [];
		const avisos: string[] = [];
		for (const dia of conferir) {
			const busca = await pesquisarVarios(caderno, [dia.origem], [dia.destino], [dia.data], adultos, criancas, classeCerta);
			achados.push(...busca.achados);
			avisos.push(...busca.avisos);
		}

		return [
			...(classeCerta === "economica" ? [] : [`Classe pesquisada: ${classeCerta}. Diga isso na resposta.`]),
			`Calendário de preços do Google ${periodo}, só ida, ${rotas.length} rota(s): o voo mais barato de cada dia${meses ? ", só nos meses pedidos" : ""}. O número depois de "calendário" é aproximado e não é preço para a resposta: use só os preços em R$ da busca de verdade, no fim.`,
			`O dia mais barato: ${linha(porPreco[0])}.`,
			...(porCidade.length > 1 ? ["O mais barato de cada cidade:", ...porCidade.slice(0, 8).map(linha)] : []),
			...(porMes.length > 1 ? ["O mais barato de cada mês:", ...porMes.map(linha)] : []),
			"Os 5 dias mais baratos:", ...porPreco.slice(0, 5).map(linha),
			...(falhas.length > 0 ? [`A BUSCA FALHOU no calendário de: ${falhas.join("; ")}. Diga que essas rotas ficaram de fora.`] : []),
			"",
			"Busca de verdade nos dias mais baratos:",
			[...agruparPorTrecho(achados)].map(([nome, voos]) => resumirTrecho(nome, voos)).join("\n\n") || "Nenhum voo encontrado.",
			...avisos,
		].join("\n");
	},
	{
		name: "buscar_mais_barato",
		description: "Acha o voo mais barato num período (um mês, \"dezembro ou janeiro\", \"quando estiver mais barato\") ou para um país inteiro (Alemanha), pelo calendário de preços do Google, e confere os dias mais baratos na busca de verdade. Use quando a pessoa quer o dia ou a cidade mais barata e deu um mês, um período de mais de 7 dias ou um país, ou disse que qualquer data serve. Para um dia, ou até 7 dias seguidos numa cidade, use buscar_voos. Devolve o dia mais barato, o mais barato de cada cidade e de cada mês, e os voos de verdade dos dias mais baratos.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código do aeroporto, como Salvador ou SSA"),
			destino: z.string().describe("Cidade, código do aeroporto ou país, como Lisboa, LIS ou Alemanha"),
			de: z.string().optional().describe("O período como veio no pedido: um mês (dezembro), os meses juntos (dezembro ou janeiro) ou o primeiro dia (10/12). Deixe de fora só se a pessoa disse que qualquer data serve: aí pesquiso os próximos 90 dias."),
			ate: z.string().optional().describe("O fim do período, quando veio separado: janeiro, 31/01."),
			...passageiros,
		}),
	},
);

const calcular = tool(
	async ({ operacao, valores }, config) => {
		const contas = {
			soma: (a: number, b: number) => a + b,
			subtracao: (a: number, b: number) => a - b,
			multiplicacao: (a: number, b: number) => a * b,
			divisao: (a: number, b: number) => a / b,
		};
		// preço vezes os passageiros da própria busca é o erro "Total R$ 55.520" da prova (busca de 2 adultos, × 2), e o "Resultado:" vira fato.
		// Busca de 1 adulto × 4 é a conta certa do conta-quatro-pessoas, por isso só o número da busca é recusado.
		// shortcut: só vê as buscas deste pedido (o noPreparar zera); numa pergunta seguinte, o × 2 passa. Subir quando a prova mostrar esse caso.
		const passageiros = new Set(cadernoDe(config).buscas.map((chave) => chave.split("|")).map(([, , , adultos, criancas]) => Number(adultos) + Number(criancas)).filter((total) => total > 1));
		const repetido = valores.find((valor) => passageiros.has(valor));
		if (operacao === "multiplicacao" && repetido && valores.some((valor) => valor >= 100)) throw new Error(`os preços dos voos já são o total dos ${repetido} passageiros pesquisados: não multiplique pelo número de pessoas. Use o preço como veio.`);
		// média é soma e divisão: sem ela aqui, o analista fazia a conta de cabeça e o verificador recusava
		const resultado = operacao === "media" ? valores.reduce(contas.soma) / valores.length : valores.reduce(contas[operacao]);
		if (!Number.isFinite(resultado)) throw new Error("essa conta não tem resultado");
		return `Resultado: ${Math.round(resultado * 100) / 100}`;
	},
	{
		name: "calcular",
		description: "Faz uma conta com dois ou mais números: soma, subtracao, multiplicacao, divisao ou media. Use para toda conta de preço: por pessoa, diferença entre dois preços, média dos voos. Os preços dos voos já são o total de todos os passageiros pesquisados: não multiplique pelo número de pessoas da busca. Para somar ida e volta de voos já pesquisados, use somar_ida_e_volta; para diferença de tempo de voo, use comparar_duracoes. Devolve o resultado com duas casas decimais.",
		schema: z.object({
			operacao: z.enum(["soma", "subtracao", "multiplicacao", "divisao", "media"]),
			valores: z.array(z.coerce.number()).min(2),
		}),
	},
);

// ---------- FERRAMENTAS PARA ANALISAR O QUE JÁ FOI PESQUISADO ----------
const listarTrechos = tool(
	async (_args, config) => {
		const trechos = agruparPorTrecho(cadernoDe(config).voos);
		return [...trechos].map(([nome, voos]) => `${nome}: ${voos.length} voos`).join("\n") || "Nada pesquisado ainda.";
	},
	{
		name: "listar_trechos",
		description: "Lista os trechos já pesquisados nesta conversa: origem, destino, data e quantos voos cada um tem. Use para saber o que já existe antes de filtrar ou comparar. Não pesquisa nada novo. Devolve uma linha por trecho.",
		schema: z.object({}),
	},
);

const filtrarVoos = tool(
	async (filtro, config) => {
		const ordens = {
			preco: (a: Voo, b: Voo) => a.preco - b.preco,
			duracao: (a: Voo, b: Voo) => a.duracao_min - b.duracao_min,
			custo_beneficio: (a: Voo, b: Voo) => precoEquivalente(a) - precoEquivalente(b),
			saida: (a: Voo, b: Voo) => a.saida.localeCompare(b.saida),
		};
		const caderno = cadernoDe(config);
		// com um trecho só, o modelo não precisa dizer qual é: nos 10 mil ele escreveu "2026-09-11" para uma busca de 2027 e a ferramenta recusou
		const umTrechoSo = agruparPorTrecho(caderno.voos).size === 1;
		const noTrecho = umTrechoSo ? () => true : trechoNaMemoria(filtro.origem, filtro.destino, filtro.data);
		// modelo fraco preenche os campos que não usa com 0. Aqui 0 quer dizer "só diretos", então só vale se o pedido falar disso.
		const falouDeEscalas = /diret|direct|direk|escala|escale|stop|conex|parada/.test(semAcento(caderno.textosDoUsuario.at(-1) ?? ""));
		const escalasMaximas = filtro.escalas_maximas === 0 && !falouDeEscalas ? undefined : filtro.escalas_maximas;
		const voos = caderno.voos
			.filter(noTrecho)
			.filter((voo) => escalasMaximas === undefined || voo.escalas <= escalasMaximas)
			// preço ou duração 0 não existem, então 0 quer dizer "sem limite"
			.filter((voo) => !filtro.preco_maximo || voo.preco <= filtro.preco_maximo)
			.filter((voo) => !filtro.duracao_maxima_horas || voo.duracao_min <= filtro.duracao_maxima_horas * 60)
			.filter((voo) => !filtro.companhia || semAcento(voo.companhia).includes(semAcento(filtro.companhia)))
			.filter((voo) => !filtro.saida_depois_de || voo.saida >= filtro.saida_depois_de)
			.filter((voo) => !filtro.saida_antes_de || voo.saida <= filtro.saida_antes_de)
			.toSorted(ordens[filtro.ordenar_por]);
		if (voos.length === 0) return "Nenhum dos voos pesquisados passa nesse filtro.";
		const linhas = voos.slice(0, 10).map((voo) => `${nomeDoTrecho(voo)}: ${descreverVoo(voo)}`);
		// a lista é cortada em 10: sem isto, o modelo diria que o décimo é o mais caro de todos
		const caro = voos.toSorted((a, b) => b.preco - a.preco)[0];
		const resto = voos.length > 10 ? `\nA lista mostra só 10. Mais caro de todos: ${nomeDoTrecho(caro)}: ${descreverVoo(caro)}` : "";
		return `${voos.length} voos passam no filtro:\n${linhas.join("\n")}${resto}\nComprar: ${voos[0].link}`;
	},
	{
		name: "filtrar_voos",
		description: "Filtra e ordena os voos já pesquisados: só diretos (escalas_maximas 0), até um preço (preco_maximo), até tantas horas (duracao_maxima_horas), de uma companhia, por horário de saída, ou ordenados por preco, duracao, custo_beneficio ou saida. Use quando a pessoa quer uma parte dos voos ou outra ordem. Não pesquisa de novo: para outra data ou cidade, use buscar_voos. Devolve os 10 primeiros que passam no filtro.",
		schema: z.object({
			origem: z.string().optional(),
			destino: z.string().optional(),
			data: z.string().optional(),
			escalas_maximas: z.coerce.number().int().optional(),
			preco_maximo: z.coerce.number().optional(),
			duracao_maxima_horas: z.coerce.number().optional(),
			companhia: z.string().optional(),
			saida_depois_de: z.string().optional().describe("Horário no formato HH:MM"),
			saida_antes_de: z.string().optional().describe("Horário no formato HH:MM"),
			ordenar_por: z.enum(["preco", "duracao", "custo_beneficio", "saida"]).default("preco"),
		}),
	},
);

const compararTrechos = tool(
	async ({ origem, destino }, config) => {
		const voos = cadernoDe(config).voos.filter(trechoNaMemoria(origem, destino));
		if (voos.length === 0) return "Nenhum voo pesquisado nesse trecho.";
		const trechos = [...agruparPorTrecho(voos)].map(([nome, lista]) => resumirTrecho(nome, lista));
		const barato = voos.toSorted((a, b) => a.preco - b.preco)[0];
		return [`Mais barato de todos: ${nomeDoTrecho(barato)}: ${descreverVoo(barato)}`, ...trechos].join("\n\n");
	},
	{
		name: "comparar_trechos",
		description: "Para cada trecho já pesquisado, diz o mais barato, o mais rápido, o melhor custo-benefício e o mais caro, e no início o mais barato de todos. Use para comparar aeroportos, cidades ou datas que já foram pesquisados. Para o total de ida mais volta, use somar_ida_e_volta. Devolve um resumo por trecho.",
		schema: z.object({ origem: z.string().optional(), destino: z.string().optional() }),
	},
);

const somarIdaEVolta = tool(
	async ({ origem, destino }, config) => {
		const { voos } = cadernoDe(config);
		const idas = voos.filter(trechoNaMemoria(origem, destino));
		const voltas = voos.filter(trechoNaMemoria(destino, origem));
		if (idas.length === 0 || voltas.length === 0) return `Falta pesquisar ${idas.length === 0 ? "a ida" : "a volta"} com buscar_voos.`;

		const combinacoes = idas.flatMap((ida) => voltas.filter((volta) => volta.data >= ida.data).map((volta) => ({ ida, volta, total: ida.preco + volta.preco })));
		if (combinacoes.length === 0) return "Nenhuma volta pesquisada é depois da ida.";
		const barata = combinacoes.toSorted((a, b) => a.total - b.total)[0];
		const melhor = combinacoes.toSorted((a, b) => precoEquivalente(a.ida) + precoEquivalente(a.volta) - precoEquivalente(b.ida) - precoEquivalente(b.volta))[0];
		const descrever = (c: typeof barata) => `Total R$ ${c.total}\n  Ida ${nomeDoTrecho(c.ida)}: ${descreverVoo(c.ida)}\n  Volta ${nomeDoTrecho(c.volta)}: ${descreverVoo(c.volta)}`;
		return `Mais barato:\n${descrever(barata)}\nMelhor custo-benefício:\n${descrever(melhor)}\n(soma de duas passagens só de ida)`;
	},
	{
		name: "somar_ida_e_volta",
		description: "Soma o preço de cada ida com cada volta já pesquisadas e devolve a combinação mais barata e a de melhor custo-benefício. Use só depois de buscar_voos da ida e da volta. Para comparar trechos sem somar, use comparar_trechos. Devolve as duas combinações com o total e o aviso de que são duas passagens só de ida.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código de onde a viagem começa"),
			destino: z.string().describe("Cidade ou código para onde a viagem vai"),
		}),
	},
);

function minutosDe(texto: string) {
	const achado = semAcento(texto).match(/^(\d{1,3})\s*h(?:oras?)?\s*(?:e\s*)?(\d{1,2})?/);
	if (!achado) throw new Error(`não entendi a duração "${texto}". Passe como veio, como 12h50.`);
	return Number(achado[1]) * 60 + Number(achado[2] ?? 0);
}

const compararDuracoes = tool(
	async ({ a, b }, config) => {
		// nos 10 mil, o analista passou "21h50" para um voo de 16h40 e a diferença errada passou pelo verificador:
		// as duas durações precisam ser de voos pesquisados
		const conhecidas = new Set(cadernoDe(config).voos.map((voo) => voo.duracao_min));
		for (const duracao of [a, b]) {
			if (conhecidas.size > 0 && !conhecidas.has(minutosDe(duracao))) throw new Error(`nenhum voo pesquisado dura ${duracao}. Chame filtrar_voos para ver as durações certas e passe as duas como aparecem na lista.`);
		}
		return `Diferença: ${horas(Math.abs(minutosDe(a) - minutosDe(b)))}`;
	},
	{
		name: "comparar_duracoes",
		description: "Diz quanto tempo um voo dura a mais que o outro. Passe as duas durações como aparecem na lista, como 12h50 e 10h20. Use só para tempo de voo; para diferença de preço, use calcular. Devolve a diferença em horas e minutos.",
		schema: z.object({ a: z.string(), b: z.string() }),
	},
);

// ---------- PREÇO DE UM MONITORAMENTO ----------
// o preço mais barato de um trecho em todos os aeroportos. Só é erro se todas as buscas falharem.
async function maisBaratoDoTrecho(origens: string[], destinos: string[], data: string, adultos: number, criancas: number, classe: string) {
	let melhor: Voo | null = null;
	let certas = 0;
	let ultimoErro: Error | null = null;
	for (const origem of origens) {
		for (const destino of destinos) {
			try {
				const voos = await servicos.buscarVoos(origem, destino, data, adultos, criancas, classe);
				certas++;
				for (const voo of voos) if (!melhor || voo.preco < melhor.preco) melhor = voo;
			} catch (erro: any) {
				ultimoErro = erro;
			}
		}
	}
	if (certas === 0 && ultimoErro) throw ultimoErro;
	return melhor;
}

type TrechosDoMonitoramento = Pick<Monitoramento, "origens" | "destinos" | "data" | "data_volta" | "adultos" | "criancas" | "classe">;

// null quer dizer que não há voos; o erro quer dizer que não deu para saber
export async function precoAtual(m: TrechosDoMonitoramento) {
	const origens = m.origens.split(",");
	const destinos = m.destinos.split(",");
	const ida = await maisBaratoDoTrecho(origens, destinos, m.data, m.adultos, m.criancas, m.classe);
	const volta = m.data_volta ? await maisBaratoDoTrecho(destinos, origens, m.data_volta, m.adultos, m.criancas, m.classe) : null;
	if (!ida || (m.data_volta && !volta)) return null;
	return { total: ida.preco + (volta?.preco ?? 0), ida, volta };
}

export function descreverMonitoramento(m: TrechosDoMonitoramento) {
	const volta = m.data_volta ? `, volta em ${m.data_volta}` : "";
	return `${m.origens}→${m.destinos} em ${m.data}${volta}, ${m.adultos + m.criancas} passageiro(s), ${m.classe}`;
}

// ---------- FERRAMENTAS DE MONITORAMENTO ----------
const LIMITE_DE_MONITORAMENTOS = 10;    // cada um vira buscas no Google várias vezes por dia

const criarMonitoramentoFerramenta = tool(
	async ({ origem, destino, data, data_volta, preco_alvo, adultos, criancas, classe }, config) => {
		const caderno = cadernoDe(config);
		if (listarMonitoramentos(caderno.conversa).length >= LIMITE_DE_MONITORAMENTOS) throw new Error(`o limite é de ${LIMITE_DE_MONITORAMENTOS} monitoramentos. Avise e peça para cancelar algum.`);

		const dia = conferirData(caderno, data);
		const diaDaVolta = data_volta ? conferirData(caderno, data_volta) : null;
		if (diaDaVolta && diaDaVolta < dia) throw new Error("a volta é antes da ida. Avise e pergunte as datas certas.");
		const trechos = {
			origens: conferirLugar(caderno, origem).join(","),
			destinos: conferirLugar(caderno, destino).join(","),
			data: dia,
			data_volta: diaDaVolta,
			adultos,
			criancas,
			classe: entenderClasse(classe),
		};
		if (trechos.origens.split(",").some((codigo) => trechos.destinos.split(",").includes(codigo))) throw new Error("a origem e o destino são o mesmo lugar. Avise e pergunte o destino certo.");

		// o mesmo pedido duas vezes não vira dois monitoramentos: seriam dois avisos iguais e o dobro de buscas no Google
		const igual = listarMonitoramentos(caderno.conversa).find((m) => (Object.keys(trechos) as (keyof typeof trechos)[]).every((campo) => m[campo] === trechos[campo]));
		if (igual) return `Já existe o monitoramento #${igual.id}: ${descreverMonitoramento(igual)}. Não criei outro.${igual.menor_preco ? ` Menor preço visto: R$ ${igual.menor_preco}.` : ""}`;

		// a primeira checagem acontece agora: confere se a rota existe e já mostra o preço de hoje
		const preco = await precoAtual(trechos);
		const alvo = preco_alvo || null;
		const jaEstaBom = preco !== null && alvo !== null && preco.total <= alvo;
		const id = criarMonitoramento({
			...trechos,
			conversa: caderno.conversa,
			preco_alvo: alvo,
			menor_preco: preco?.total ?? null,
			avisado_preco: jaEstaBom ? preco.total : null,    // o aviso é esta própria resposta
			checado_em: Date.now(),
		});

		const hoje = preco ? `Preço de agora: R$ ${preco.total}.` : "Agora não há voos nessa rota.";
		const regra = alvo !== null ? `Aviso quando ficar em R$ ${alvo} ou menos.` : "Aviso quando aparecer o menor preço até agora.";
		const comprar = preco ? `\nComprar: ${[preco.ida.link, preco.volta?.link].filter(Boolean).join(" e ")}` : "";
		return `Monitoramento #${id} criado: ${descreverMonitoramento(trechos)}. ${hoje} ${jaEstaBom ? "Já está no preço que o usuário quer." : regra} Confere a cada 2 horas.${comprar}`;
	},
	{
		name: "criar_monitoramento",
		description: "Passa a conferir o preço de um trecho a cada 2 horas e avisa no Slack quando baixar ou chegar ao preco_alvo. Use quando a pessoa pede para acompanhar, vigiar ou avisar quando o preço cair. Não mostra a lista de voos de agora: isso é buscar_voos, de outro agente. Devolve o número do monitoramento e o preço de hoje.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código do aeroporto"),
			destino: z.string().describe("Cidade ou código do aeroporto"),
			data: z.string().describe("A data de ida como veio no pedido"),
			data_volta: z.string().optional().describe("A data de volta como veio no pedido. Sem volta, deixe de fora."),
			preco_alvo: z.coerce.number().optional().describe("O valor total que o usuário quer pagar. Se não disser, deixe de fora."),
			...passageiros,
		}),
	},
);

const listarMonitoramentosFerramenta = tool(
	async (_args, config) => {
		const lista = listarMonitoramentos(cadernoDe(config).conversa);
		if (lista.length === 0) return "Nenhum monitoramento ativo.";
		return lista.map((m) => `#${m.id}: ${descreverMonitoramento(m)}${m.preco_alvo ? `, alvo R$ ${m.preco_alvo}` : ""}${m.menor_preco ? `, menor preço visto R$ ${m.menor_preco}` : ""}`).join("\n");
	},
	{
		name: "listar_monitoramentos",
		description: "Mostra os monitoramentos ativos desta conversa: número, trecho, datas, preço alvo e menor preço visto. Use quando a pessoa pergunta o que está sendo acompanhado, e sempre antes de cancelar_monitoramento. Devolve uma linha por monitoramento, ou avisa que não há nenhum.",
		schema: z.object({}),
	},
);

const cancelarMonitoramentoFerramenta = tool(
	async ({ numero }, config) => {
		if (!cancelarMonitoramento(cadernoDe(config).conversa, numero)) throw new Error(`não existe monitoramento ativo #${numero}. Use listar_monitoramentos.`);
		return `Monitoramento #${numero} cancelado.`;
	},
	{
		name: "cancelar_monitoramento",
		description: "Cancela um monitoramento pelo número que listar_monitoramentos mostrou. Use só depois de listar_monitoramentos; não aceita cidade nem data, só o número. Devolve a confirmação.",
		schema: z.object({ numero: z.coerce.number().int() }),
	},
);

// ---------- FERRAMENTAS DE PREFERÊNCIAS ----------
export const LIMITE_DE_PREFERENCIAS = 20;

const guardarPreferenciaFerramenta = tool(
	async ({ texto }, config) => {
		const { conversa } = cadernoDe(config);
		if (listarPreferencias(conversa).length >= LIMITE_DE_PREFERENCIAS) throw new Error("já há muitas preferências guardadas. Avise e peça para apagar alguma.");
		// um preço guardado aqui viraria "fato" nas próximas conversas
		if (/\d\s*reais|R\$/i.test(texto)) throw new Error("preferências não guardam preços. Avise que isso não foi guardado.");
		guardarPreferencia(conversa, texto.slice(0, 200));
		return `Guardado: ${texto.slice(0, 200)}`;
	},
	{
		name: "guardar_preferencia",
		description: "Guarda uma preferência duradoura da pessoa em uma frase curta: onde mora, companhia favorita, se prefere voo direto, janela ou corredor. Use quando a pessoa pede para lembrar ou conta algo sobre si que vale para viagens futuras. Para passaporte, nascimento, nacionalidade e vacina, use guardar_documentos. Nunca guarde preços nem voos. Devolve a confirmação.",
		schema: z.object({ texto: z.string().describe("A preferência em uma frase curta") }),
	},
);

const listarPreferenciasFerramenta = tool(
	async (_args, config) => {
		const lista = listarPreferencias(cadernoDe(config).conversa);
		return lista.map((preferencia) => `#${preferencia.id}: ${preferencia.texto}`).join("\n") || "Nenhuma preferência guardada.";
	},
	{
		name: "listar_preferencias",
		description: "Mostra as preferências guardadas, cada uma com o número. Use quando a pessoa pergunta o que o bot sabe sobre ela, e sempre antes de apagar_preferencia. Devolve uma linha por preferência, ou avisa que não há nenhuma.",
		schema: z.object({}),
	},
);

const apagarPreferenciaFerramenta = tool(
	async ({ numero }, config) => {
		if (!apagarPreferencia(cadernoDe(config).conversa, numero)) throw new Error(`não existe preferência #${numero}. Use listar_preferencias.`);
		return `Preferência #${numero} apagada.`;
	},
	{
		name: "apagar_preferencia",
		description: "Apaga uma preferência pelo número que listar_preferencias mostrou. Use só depois de listar_preferencias; só aceita o número. Devolve a confirmação.",
		schema: z.object({ numero: z.coerce.number().int() }),
	},
);

// ---------- HOSPEDAGEM ----------
// mesmo desenho da busca de voos: o modelo escolhe a cidade e as datas, o código confere e pesquisa.
// Os hotéis são reais (lidos do Google Hotels), mas a página só entrega o preço de UMA noite nas datas
// que o Google escolhe, não das datas pedidas. Quem avisa isso é o resumirHospedagens, dentro do texto
// que o modelo copia: o aviso mora junto do número, e não numa frase solta que o modelo pode largar.
const buscarHospedagemFerramenta = tool(
	async ({ cidade, entrada, saida, hospedes }, config) => {
		const caderno = cadernoDe(config);
		const diaDeEntrada = conferirData(caderno, entrada);
		const diaDeSaida = conferirData(caderno, saida);
		const problema = conferirPedidoDeHospedagem(cidade, diaDeEntrada, diaDeSaida, hospedes);
		if (problema) throw new Error(problema);
		const achadas = await servicos.buscarHospedagem(cidade, diaDeEntrada, diaDeSaida, hospedes);
		return resumirHospedagens(achadas);
	},
	{
		name: "buscar_hoteis",
		description: "Pesquisa hotéis reais em uma cidade para as datas de entrada e saída e o número de hóspedes. Use quando a pessoa fala em hotel, hospedagem, pousada ou onde ficar, e já disse a cidade e as datas. Não pesquisa voos: isso é buscar_voos. Devolve os hotéis com nome, nota e preço de UMA noite nas datas do Google, não das datas pedidas: o aviso vem junto do preço.",
		schema: z.object({
			cidade: z.string().describe("A cidade, como Lisboa"),
			entrada: z.string().describe("A data de entrada como veio no pedido, como 12/12"),
			saida: z.string().describe("A data de saída como veio no pedido, como 19/12"),
			hospedes: z.coerce.number().int().default(2).describe("Quantas pessoas no quarto, de 1 a 8. Se o pedido não disser, 2."),
		}),
	},
);

// ---------- O DOSSIÊ DA PESSOA ----------
// o nó das regras só confere visto, passaporte e vacina se souber estes dados; é esta ferramenta que
// os guarda. Data aqui não passa pelo entenderData: aquele resolve data FUTURA ("próxima sexta"), e
// data de nascimento é passado.
function dataDeVerdade(valor: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
	return new Date(valor + "T12:00:00Z").toISOString().slice(0, 10) === valor;
}

// o campo chama passaporte_vence, e não passaporte_validade: nos 10 mil, o glm-5.3 escreveu "passaporte_valididade"
// em 12 de 12 falhas, o zod descartou o campo desconhecido em silêncio e nada era guardado
const guardarDocumentos = tool(
	async ({ nacionalidade, passaporte_vence, nascimento, vacina_febre_amarela }, config) => {
		const { conversa } = cadernoDe(config);
		const campos: Partial<Dossie> = {};
		if (nacionalidade) campos.nacionalidade = nacionalidade.trim().toUpperCase().slice(0, 2);
		for (const [nome, valor] of Object.entries({ passaporte_validade: passaporte_vence, nascimento, vacina_febre_amarela })) {
			if (!valor) continue;
			if (!dataDeVerdade(valor)) throw new Error(`${nome} tem que vir como AAAA-MM-DD, e "${valor}" não é uma data assim. Pergunte ao usuário e tente de novo.`);
			campos[nome as "nascimento"] = valor;
		}
		if (Object.keys(campos).length === 0) throw new Error("não veio nenhum dado para guardar no dossiê. Os campos são nacionalidade, passaporte_vence, nascimento e vacina_febre_amarela.");
		guardarDossie(conversa, campos);
		return `Guardado no dossiê: ${Object.entries(campos).map(([nome, valor]) => `${nome} = ${valor}`).join(", ")}. As regras da viagem passam a usar isso.`;
	},
	{
		name: "guardar_documentos",
		description: "Guarda os documentos da pessoa: nacionalidade (sigla, como BR), validade do passaporte, data de nascimento e data da vacina de febre amarela, as datas como AAAA-MM-DD. Use quando a pessoa conta um desses dados. Para gostos e hábitos, use guardar_preferencia. Devolve a confirmação; as regras da viagem passam a conferir visto, passaporte e vacina com esses dados.",
		schema: z.object({
			nacionalidade: z.string().optional().describe("Sigla de dois caracteres, como BR"),
			passaporte_vence: z.string().optional().describe("Até quando o passaporte vale, como AAAA-MM-DD"),
			nascimento: z.string().optional().describe("Data de nascimento, como AAAA-MM-DD"),
			vacina_febre_amarela: z.string().optional().describe("Data da dose da vacina, como AAAA-MM-DD"),
		}),
	},
);

// ---------- AS FERRAMENTAS DO GUIA ----------
// as duas que olham para fora dos voos: o clima medido e a internet. O texto que volta delas é de fora
// e já chega limpo e marcado como dado (sources/web.ts, sources/weather.ts)
const verClimaFerramenta = tool(
	async ({ cidade }) => descreverClima(await servicos.verClima(cidade)),
	{
		name: "ver_clima",
		description: "Mostra a temperatura de agora e a previsão dos próximos 7 dias de uma cidade, com dados medidos. Use para temperatura, frio, calor, chuva ou previsão do tempo. Para o clima típico de um mês mais distante, use buscar_na_web. Devolve o lugar achado, a temperatura agora e a mínima, a máxima e a chance de chuva de cada dia.",
		schema: z.object({ cidade: z.string().describe("O nome da cidade em inglês, como New York, Lisbon ou Munich. Se houver outra cidade com o mesmo nome, ponha o país depois de vírgula: Paris, France") }),
	},
);

// visto e vacina são regra, e regra é código: a mesma tabela que o nó conferir usa (rules/rules.ts)
const regrasDeEntradaFerramenta = tool(
	async ({ pais }) => regrasDeEntrada(pais) ?? `"${pais}" não está na tabela de regras de entrada. Pesquise com buscar_na_web.`,
	{
		name: "regras_de_entrada",
		description: "Diz se um brasileiro precisa de visto para um país, por quanto tempo pode ficar e se o país exige a vacina de febre amarela, pela tabela do bot. Use antes de buscar_na_web sempre que a pergunta for visto ou vacina de um país. Não serve para passaporte de outro país. Devolve a regra e a fonte; se o país não estiver na tabela, diz para buscar na internet.",
		schema: z.object({ pais: z.string().describe("O nome do país por extenso, como Japão ou Estados Unidos") }),
	},
);

const buscarNaWebFerramenta = tool(
	async ({ pergunta }) => resumirAchados(pergunta, await servicos.pesquisarNaWeb(pergunta)),
	{
		name: "buscar_na_web",
		description: "Pesquisa na internet uma dúvida de viagem: visto e vacina que a tabela não tem, regra de passaporte, seguro, moeda, tomada, fuso, idioma, segurança, transporte do aeroporto, o que fazer, clima típico de uma época. Escreva uma pergunta curta e completa, com o país ou a cidade. Não use para preço de voo ou de hotel: isso é buscar_voos e buscar_hoteis. Devolve as páginas achadas, cada uma com título, link e um trecho do texto.",
		schema: z.object({ pergunta: z.string().describe("A pergunta da busca, curta e com o lugar, como: brasileiro precisa de visto para o Japão") }),
	},
);

// ---------- O REGISTRO ----------
// uma linha por ferramenta: de qual agente ela é, se está ligada, e quantas vezes pode ser chamada em um pedido.
// É o único lugar que diz isso: o agents.ts monta a lista de cada agente daqui, e o nó ferramentas (graph.ts)
// confere toda chamada aqui antes de rodar. Ideia do MCP Gateway da Uber, no tamanho deste projeto.
//
// Ferramenta nova entra com ligada: false e só liga depois que a prova passar.
// Os limites são escolha nossa: a busca de hotel não tinha limite nenhum, e um modelo em loop podia pedir
// 20 buscas no Google Hotels numa resposta só. Mude à mão se a prova mostrar que algum aperta.
export const REGISTRO = [
	{ ferramenta: buscarVoosFerramenta, agente: "pesquisador", ligada: true, maxPorPedido: CHAMADAS_DE_BUSCA_POR_PEDIDO },
	{ ferramenta: buscarMaisBaratoFerramenta, agente: "pesquisador", ligada: true, maxPorPedido: 3 },    // F74: os cenários calendario-* e os vizinhos de data passaram na prova de 09/11 (10 de 10)
	{ ferramenta: buscarHospedagemFerramenta, agente: "pesquisador", ligada: true, maxPorPedido: 3 },
	{ ferramenta: listarAeroportos, agente: "pesquisador", ligada: true, maxPorPedido: 4 },
	{ ferramenta: diaDaSemanaFerramenta, agente: "pesquisador", ligada: true, maxPorPedido: 4 },

	{ ferramenta: filtrarVoos, agente: "analista", ligada: true, maxPorPedido: 6 },
	{ ferramenta: compararTrechos, agente: "analista", ligada: true, maxPorPedido: 4 },
	{ ferramenta: somarIdaEVolta, agente: "analista", ligada: true, maxPorPedido: 4 },
	{ ferramenta: calcular, agente: "analista", ligada: true, maxPorPedido: 10 },
	{ ferramenta: compararDuracoes, agente: "analista", ligada: true, maxPorPedido: 6 },
	{ ferramenta: listarTrechos, agente: "analista", ligada: true, maxPorPedido: 3 },

	{ ferramenta: criarMonitoramentoFerramenta, agente: "monitor", ligada: true, maxPorPedido: 3 },
	{ ferramenta: listarMonitoramentosFerramenta, agente: "monitor", ligada: true, maxPorPedido: 3 },
	{ ferramenta: cancelarMonitoramentoFerramenta, agente: "monitor", ligada: true, maxPorPedido: 5 },

	{ ferramenta: guardarPreferenciaFerramenta, agente: "memoria", ligada: true, maxPorPedido: 5 },
	{ ferramenta: listarPreferenciasFerramenta, agente: "memoria", ligada: true, maxPorPedido: 3 },
	{ ferramenta: apagarPreferenciaFerramenta, agente: "memoria", ligada: true, maxPorPedido: 5 },
	{ ferramenta: guardarDocumentos, agente: "memoria", ligada: true, maxPorPedido: 3 },

	{ ferramenta: verClimaFerramenta, agente: "guia", ligada: true, maxPorPedido: 3 },
	{ ferramenta: regrasDeEntradaFerramenta, agente: "guia", ligada: true, maxPorPedido: 3 },
	{ ferramenta: buscarNaWebFerramenta, agente: "guia", ligada: true, maxPorPedido: 3 },
];

// todas, ligadas ou não: a prova chama qualquer uma pelo nome
export const todasAsFerramentas = REGISTRO.map((linha) => linha.ferramenta);

// o que um agente enxerga: só as dele, e só as ligadas
export function ferramentasDe(agente: string) {
	return REGISTRO.filter((linha) => linha.agente === agente && linha.ligada).map((linha) => linha.ferramenta);
}

// a porta por onde passa toda chamada: devolve a ferramenta, ou lança o motivo da recusa, que volta para o modelo
export function conferirNoRegistro(agente: string, nome: string, jaChamada: number) {
	const linha = REGISTRO.find((opcao) => opcao.ferramenta.name === nome);
	if (!linha || linha.agente !== agente) throw new Error(`a ferramenta ${nome} não é sua. As suas são: ${ferramentasDe(agente).map((ferramenta) => ferramenta.name).join(", ")}`);
	if (!linha.ligada) throw new Error(`a ferramenta ${nome} está desligada. Responda sem ela.`);
	if (jaChamada >= linha.maxPorPedido) throw new Error(`${nome} já foi chamada ${linha.maxPorPedido} vezes neste pedido, que é o limite. Responda com o que já tem.`);
	return linha.ferramenta;
}

// modelos fracos mandam null ou "" nos campos opcionais; para o código isso é o mesmo que não mandar
export function limparArgumentos(args: Record<string, any>) {
	return Object.fromEntries(Object.entries(args).filter(([_campo, valor]) => valor !== null && valor !== ""));
}
