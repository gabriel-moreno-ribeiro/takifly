// ferramentas.ts - tudo o que o modelo pode pedir para o código fazer
//
// A ideia: cada decisão ou conta que dá para fazer com código sai da cabeça do modelo.
// Um modelo fraco erra data, soma e filtro; o código não erra. O modelo só escolhe QUAL ferramenta usar.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { descreverAeroporto, nomesDoAeroporto, resolverAeroportos, semAcento } from "./aeroportos.ts";
import { apagarPreferencia, cancelarMonitoramento, criarMonitoramento, type Dossie, guardarDossie, guardarPreferencia, listarMonitoramentos, listarPreferencias, type Monitoramento } from "./dados.ts";
import { buscarHospedagem, conferirPedido as conferirPedidoDeHospedagem, resumirHospedagens } from "./hospedagem.ts";
import { criarPlanilha, horas } from "../planilha.ts";
import { buscarVoos, precoEquivalente, type Voo } from "../voos.ts";

// ---------- SERVIÇOS DE FORA ----------
// o que sai do Mac fica neste objeto para a prova (avaliar.ts) poder trocar por versões de mentira
export const servicos = { buscarVoos, buscarHospedagem, criarPlanilha };

// ---------- O CADERNO ----------
// o que as ferramentas leem e escrevem enquanto o nó "ferramentas" roda; no fim, o nó copia para o Estado do grafo
export type Caderno = {
	voos: Voo[];                 // tudo o que foi pesquisado e ainda vale
	novos: Voo[];                // o que ainda não foi para uma planilha
	buscas: string[];            // as buscas feitas neste pedido
	textosDoUsuario: string[];   // o que a pessoa escreveu: serve para conferir se a data foi mesmo dita
	conversa: string;            // de quem são os monitoramentos e as preferências
};

function cadernoDe(config: any): Caderno {
	return config.configurable.caderno;
}

const LIMITE_DE_BUSCAS = 12;    // um modelo em loop não pode martelar o Google

// ---------- AEROPORTOS ----------
// quem conhece aeroporto é o aeroportos.ts: ele lê a tabela do mundo (OurAirports + Wikidata) e
// entende nome de cidade em seis idiomas, erro de digitação e nome repetido. Aqui só re-exporto,
// porque o resto do projeto e a prova pedem resolverAeroportos a este arquivo.
export { resolverAeroportos };

// ---------- DATAS ----------
export function hojeEmSaoPaulo() {
	return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });    // "sv-SE" escreve AAAA-MM-DD
}

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

export function somarDias(data: string, dias: number) {
	return new Date(new Date(data + "T00:00:00Z").getTime() + dias * 86_400_000).toJSON().slice(0, 10);
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
	else if ((data = dataComNomeDoMes(limpo, hoje))) data = data;
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
export function resumirTrecho(nome: string, voos: Voo[]) {
	const barato = voos.toSorted((a, b) => a.preco - b.preco)[0];
	const rapido = voos.toSorted((a, b) => a.duracao_min - b.duracao_min)[0];
	const melhor = voos.toSorted((a, b) => precoEquivalente(a) - precoEquivalente(b))[0];
	const caro = voos.toSorted((a, b) => b.preco - a.preco)[0];
	// a lista também vai junto: sem ela, o modelo diz que uma companhia "não apareceu" só porque não venceu nada
	const lista = voos.toSorted((a, b) => a.preco - b.preco).slice(0, 10).map(descreverVoo).join("\n");
	const resto = voos.length > 10 ? `\nHá mais ${voos.length - 10} voos: use filtrar_voos para ver.` : "";
	return `${nome} (${voos.length} voos)\nMais barato: ${descreverVoo(barato)}\nMais rápido: ${descreverVoo(rapido)}\nMelhor custo-benefício: ${descreverVoo(melhor)}\nMais caro: ${descreverVoo(caro)}\nComprar: ${barato.link}\nOs voos, do mais barato ao mais caro:\n${lista}${resto}`;
}

export function resumirVoos(voos: Voo[]) {
	return [...agruparPorTrecho(voos)].map(([nome, lista]) => resumirTrecho(nome, lista)).join("\n\n");
}

// ---------- PESQUISAR ----------
// devolve os voos, ou null se a mesma busca já foi feita neste pedido (um modelo fraco costuma repetir)
async function pesquisar(caderno: Caderno, origem: string, destino: string, data: string, adultos: number, criancas: number, classe: string) {
	const chave = [origem, destino, data, adultos, criancas, classe].join("|");
	if (caderno.buscas.includes(chave)) return null;
	if (caderno.buscas.length >= LIMITE_DE_BUSCAS) throw new Error(`limite de ${LIMITE_DE_BUSCAS} buscas por pedido. Responda com o que já tem.`);
	caderno.buscas.push(chave);

	const voos = await servicos.buscarVoos(origem, destino, data, adultos, criancas, classe);
	// se o mesmo trecho for pesquisado de novo, ficam só os preços mais recentes
	const outroTrecho = (voo: Voo) => voo.origem !== origem || voo.destino !== destino || voo.data !== data;
	caderno.voos = [...caderno.voos.filter(outroTrecho), ...voos];
	caderno.novos = [...caderno.novos.filter(outroTrecho), ...voos];
	return voos;
}

// um aeroporto com erro não derruba os outros: a resposta conta o que deu certo e o que falhou
async function pesquisarVarios(caderno: Caderno, origens: string[], destinos: string[], datas: string[], adultos: number, criancas: number, classe: string) {
	if (origens.some((origem) => destinos.includes(origem))) throw new Error("a origem e o destino são o mesmo lugar. Avise e pergunte o destino certo.");
	const achados: Voo[] = [];
	const avisos: string[] = [];
	for (const data of datas) {
		for (const origem of origens) {
			for (const destino of destinos) {
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
	const foiDito = caderno.textosDoUsuario.some((pedido) => formas.some((forma) => new RegExp(`\\b${forma}\\b`).test(semAcento(pedido))));
	if (!foiDito) throw new Error(`"${texto}" não aparece no pedido. Não escolha origem nem destino: pergunte.`);
	return codigos;
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

// ---------- FERRAMENTAS PARA ENTENDER E BUSCAR ----------
// a saída de emergência: quando o nome não resolveu sozinho, o modelo vê os candidatos com cidade,
// país e tamanho do aeroporto e pergunta à pessoa qual é. Resolver errado calado é o que não pode.
const buscarAeroportos = tool(
	async ({ cidade }) => `${cidade}: ${resolverAeroportos(cidade).map(descreverAeroporto).join(", ")}`,
	{
		name: "buscar_aeroportos",
		description: "Diz os códigos dos aeroportos de uma cidade, com cidade, país e tamanho de cada um. Aceita o nome em qualquer idioma. Não precisa usar antes de buscar_voos, que já aceita o nome da cidade.",
		schema: z.object({ cidade: z.string() }),
	},
);

const entenderDataFerramenta = tool(
	async ({ texto }) => {
		const data = entenderData(texto);
		return `${data} (${diaDaSemana(data)})`;
	},
	{
		name: "entender_data",
		description: "Transforma uma data escrita em palavras (12/12, amanhã, próxima sexta) na data exata e no dia da semana.",
		schema: z.object({ texto: z.string() }),
	},
);

const buscarVoosFerramenta = tool(
	async ({ origem, destino, data, adultos, criancas, classe }, config) => {
		const caderno = cadernoDe(config);
		const dia = conferirData(caderno, data);
		const { achados, avisos } = await pesquisarVarios(caderno, conferirLugar(caderno, origem), conferirLugar(caderno, destino), [dia], adultos, criancas, entenderClasse(classe));
		const trechos = [...agruparPorTrecho(achados)].map(([nome, voos]) => resumirTrecho(nome, voos));
		return [...trechos, ...avisos].join("\n\n") || "Nenhum voo encontrado.";
	},
	{
		name: "buscar_voos",
		description: "Pesquisa voos reais só de ida em um dia. Se a cidade tiver vários aeroportos, pesquisa todos. Use uma vez por trecho.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código do aeroporto, como São Paulo ou GRU"),
			destino: z.string().describe("Cidade ou código do aeroporto, como Lisboa ou LIS"),
			data: z.string().describe("A data como veio no pedido, como 12/12 ou próxima sexta"),
			...passageiros,
		}),
	},
);

const buscarVariosDias = tool(
	async ({ origem, destino, data_inicio, data_fim, adultos, criancas, classe }, config) => {
		const caderno = cadernoDe(config);
		const inicio = conferirData(caderno, data_inicio);
		const fim = conferirData(caderno, data_fim);
		const datas: string[] = [];
		for (let dia = inicio; dia <= fim && datas.length < 7; dia = somarDias(dia, 1)) datas.push(dia);

		const { achados, avisos } = await pesquisarVarios(caderno, conferirLugar(caderno, origem), conferirLugar(caderno, destino), datas, adultos, criancas, entenderClasse(classe));
		const maisBaratoDoDia = [...Map.groupBy(achados, (voo) => voo.data).values()].map((voos) => voos.toSorted((a, b) => a.preco - b.preco)[0]);
		const linhas = maisBaratoDoDia.toSorted((a, b) => a.preco - b.preco).map((voo) => `${voo.data} (${diaDaSemana(voo.data)}) ${voo.origem}→${voo.destino}: ${descreverVoo(voo)}`);
		const cortado = fim > datas.at(-1)! ? [`Só pesquisei até ${datas.at(-1)}: o limite é de 7 dias.`] : [];
		return [linhas.length ? "Do dia mais barato ao mais caro:" : "Nenhum voo encontrado.", ...linhas, ...avisos, ...cortado].join("\n");
	},
	{
		name: "buscar_varios_dias",
		description: "Só para um período de dias seguidos (até 7 dias): pesquisa cada dia e devolve do mais barato ao mais caro. Para dias soltos, chame buscar_voos uma vez para cada dia.",
		schema: z.object({
			origem: z.string().describe("Cidade ou código do aeroporto"),
			destino: z.string().describe("Cidade ou código do aeroporto"),
			data_inicio: z.string().describe("Primeiro dia, como 10/12"),
			data_fim: z.string().describe("Último dia, como 14/12"),
			...passageiros,
		}),
	},
);

const calcular = tool(
	async ({ operacao, valores }) => {
		const contas = {
			soma: (a: number, b: number) => a + b,
			subtracao: (a: number, b: number) => a - b,
			multiplicacao: (a: number, b: number) => a * b,
			divisao: (a: number, b: number) => a / b,
		};
		const resultado = valores.reduce(contas[operacao]);
		if (!Number.isFinite(resultado)) throw new Error("essa conta não tem resultado");
		return `Resultado: ${Math.round(resultado * 100) / 100}`;
	},
	{
		name: "calcular",
		description: "Faz uma conta. Use sempre em vez de calcular de cabeça, por exemplo o preço por pessoa.",
		schema: z.object({
			operacao: z.enum(["soma", "subtracao", "multiplicacao", "divisao"]),
			valores: z.array(z.coerce.number()).min(2),
		}),
	},
);

// ---------- FERRAMENTAS PARA ANALISAR O QUE JÁ FOI PESQUISADO ----------
const listarPesquisas = tool(
	async (_args, config) => {
		const trechos = agruparPorTrecho(cadernoDe(config).voos);
		return [...trechos].map(([nome, voos]) => `${nome}: ${voos.length} voos`).join("\n") || "Nada pesquisado ainda.";
	},
	{
		name: "listar_pesquisas",
		description: "Lista os trechos que já foram pesquisados e ainda estão na memória.",
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
		const noTrecho = trechoNaMemoria(filtro.origem, filtro.destino, filtro.data);
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
		description: "Filtra e ordena os voos já pesquisados, sem pesquisar de novo. Use para só diretos (escalas_maximas 0), o mais rápido (ordenar_por duracao), até certo preço, de uma companhia, ou por horário.",
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

const melhoresVoos = tool(
	async ({ origem, destino }, config) => {
		const voos = cadernoDe(config).voos.filter(trechoNaMemoria(origem, destino));
		if (voos.length === 0) return "Nenhum voo pesquisado nesse trecho.";
		const trechos = [...agruparPorTrecho(voos)].map(([nome, lista]) => resumirTrecho(nome, lista));
		const barato = voos.toSorted((a, b) => a.preco - b.preco)[0];
		return [`Mais barato de todos: ${nomeDoTrecho(barato)}: ${descreverVoo(barato)}`, ...trechos].join("\n\n");
	},
	{
		name: "melhores_voos",
		description: "Para cada trecho já pesquisado, diz o mais barato, o mais rápido e o de melhor custo-benefício, e também o mais barato de todos. Boa para comparar aeroportos ou datas.",
		schema: z.object({ origem: z.string().optional(), destino: z.string().optional() }),
	},
);

const combinarIdaEVolta = tool(
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
		return `Mais barato:\n${descrever(barata)}\nMelhor custo-benefício:\n${descrever(melhor)}\nSão duas passagens só de ida somadas: comprar as duas juntas pode custar outro valor.`;
	},
	{
		name: "combinar_ida_e_volta",
		description: "Depois de pesquisar a ida e a volta, soma os preços e devolve a combinação mais barata e a de melhor custo-benefício.",
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

const diferencaDeDuracao = tool(
	async ({ a, b }) => `Diferença: ${horas(Math.abs(minutosDe(a) - minutosDe(b)))}`,
	{
		name: "diferenca_de_duracao",
		description: "Diz quanto tempo uma viagem dura a mais que a outra. Passe as durações como vieram, como 12h50 e 10h20.",
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
		return `Monitoramento #${id} criado: ${descreverMonitoramento(trechos)}. ${hoje} ${jaEstaBom ? "Já está no preço que o usuário quer." : regra} Confere a cada 2 horas, enquanto o bot estiver ligado.${comprar}`;
	},
	{
		name: "criar_monitoramento",
		description: "Passa a conferir o preço de uma viagem de tempos em tempos e avisa no Slack quando baixar.",
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
		description: "Mostra os monitoramentos ativos e o número de cada um.",
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
		description: "Cancela um monitoramento pelo número dele.",
		schema: z.object({ numero: z.coerce.number().int() }),
	},
);

// ---------- FERRAMENTAS DE PREFERÊNCIAS ----------
const LIMITE_DE_PREFERENCIAS = 20;

const lembrarPreferencia = tool(
	async ({ texto }, config) => {
		const { conversa } = cadernoDe(config);
		if (listarPreferencias(conversa).length >= LIMITE_DE_PREFERENCIAS) throw new Error("já há muitas preferências guardadas. Avise e peça para apagar alguma.");
		// um preço guardado aqui viraria "fato" nas próximas conversas
		if (/\d\s*reais|R\$/i.test(texto)) throw new Error("preferências não guardam preços. Avise que isso não foi guardado.");
		guardarPreferencia(conversa, texto.slice(0, 200));
		return `Guardado: ${texto.slice(0, 200)}`;
	},
	{
		name: "lembrar_preferencia",
		description: "Guarda uma preferência do usuário, como onde mora ou que prefere voo direto.",
		schema: z.object({ texto: z.string().describe("A preferência em uma frase curta") }),
	},
);

const verPreferencias = tool(
	async (_args, config) => {
		const lista = listarPreferencias(cadernoDe(config).conversa);
		return lista.map((preferencia) => `#${preferencia.id}: ${preferencia.texto}`).join("\n") || "Nenhuma preferência guardada.";
	},
	{
		name: "ver_preferencias",
		description: "Mostra as preferências guardadas e o número de cada uma.",
		schema: z.object({}),
	},
);

const esquecerPreferencia = tool(
	async ({ numero }, config) => {
		if (!apagarPreferencia(cadernoDe(config).conversa, numero)) throw new Error(`não existe preferência #${numero}. Use ver_preferencias.`);
		return `Preferência #${numero} apagada.`;
	},
	{
		name: "esquecer_preferencia",
		description: "Apaga uma preferência pelo número dela.",
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
		const problema = conferirPedidoDeHospedagem(cidade, diaDeEntrada, diaDeSaida, hospedes ?? 2);
		if (problema) throw new Error(problema);
		const achadas = await servicos.buscarHospedagem(cidade, diaDeEntrada, diaDeSaida, hospedes ?? 2);
		return resumirHospedagens(achadas);
	},
	{
		name: "buscar_hospedagem",
		description: "Pesquisa hotéis reais numa cidade. O preço que vem é de uma noite nas datas do Google, não das datas pedidas. Use depois de saber as datas da viagem.",
		schema: z.object({
			cidade: z.string().describe("A cidade, como Lisboa"),
			entrada: z.string().describe("A data de entrada como veio no pedido, como 12/12"),
			saida: z.string().describe("A data de saída como veio no pedido, como 19/12"),
			hospedes: z.number().optional().describe("Quantas pessoas no quarto, de 1 a 8"),
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

const guardarDossieFerramenta = tool(
	async ({ nacionalidade, passaporte_validade, nascimento, vacina_febre_amarela }, config) => {
		const { conversa } = cadernoDe(config);
		const campos: Partial<Dossie> = {};
		if (nacionalidade) campos.nacionalidade = nacionalidade.trim().toUpperCase().slice(0, 2);
		for (const [nome, valor] of Object.entries({ passaporte_validade, nascimento, vacina_febre_amarela })) {
			if (!valor) continue;
			if (!dataDeVerdade(valor)) throw new Error(`${nome} tem que vir como AAAA-MM-DD, e "${valor}" não é uma data assim. Pergunte ao usuário e tente de novo.`);
			campos[nome as "nascimento"] = valor;
		}
		if (Object.keys(campos).length === 0) throw new Error("não veio nenhum dado para guardar no dossiê.");
		guardarDossie(conversa, campos);
		return `Guardado no dossiê: ${Object.entries(campos).map(([nome, valor]) => `${nome} = ${valor}`).join(", ")}. As regras da viagem passam a usar isso.`;
	},
	{
		name: "guardar_dossie",
		description: "Guarda os documentos do usuário: validade do passaporte, data de nascimento, data da vacina de febre amarela e nacionalidade. Serve para conferir visto, passaporte e vacina da viagem.",
		schema: z.object({
			nacionalidade: z.string().optional().describe("Sigla de dois caracteres, como BR"),
			passaporte_validade: z.string().optional().describe("Até quando o passaporte vale, como AAAA-MM-DD"),
			nascimento: z.string().optional().describe("Data de nascimento, como AAAA-MM-DD"),
			vacina_febre_amarela: z.string().optional().describe("Data da dose da vacina, como AAAA-MM-DD"),
		}),
	},
);

// ---------- O CARDÁPIO ----------
// cada grupo pertence a um agente só (agentes.ts): quanto menos opções, menos um modelo fraco se confunde
export const paraPesquisar = [buscarVoosFerramenta, buscarVariosDias, buscarHospedagemFerramenta, buscarAeroportos, entenderDataFerramenta];
export const paraAnalisar = [filtrarVoos, melhoresVoos, combinarIdaEVolta, calcular, diferencaDeDuracao, listarPesquisas];
export const paraMonitorar = [criarMonitoramentoFerramenta, listarMonitoramentosFerramenta, cancelarMonitoramentoFerramenta];
export const paraLembrar = [lembrarPreferencia, verPreferencias, esquecerPreferencia, guardarDossieFerramenta];
export const todasAsFerramentas = [...paraPesquisar, ...paraAnalisar, ...paraMonitorar, ...paraLembrar];

// modelos fracos mandam null ou "" nos campos opcionais; para o código isso é o mesmo que não mandar
export function limparArgumentos(args: Record<string, any>) {
	return Object.fromEntries(Object.entries(args).filter(([_campo, valor]) => valor !== null && valor !== ""));
}
