// ferramentas.ts - tudo o que o modelo pode pedir para o código fazer
//
// A ideia: cada decisão ou conta que dá para fazer com código sai da cabeça do modelo.
// Um modelo fraco erra data, soma e filtro; o código não erra. O modelo só escolhe QUAL ferramenta usar.

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { criarPlanilha, horas } from "./planilha.ts";
import { buscarVoos, precoEquivalente, type Voo } from "./voos.ts";

// ---------- SERVIÇOS DE FORA ----------
// o que sai do Mac fica neste objeto para a prova (avaliar.ts) poder trocar por versões de mentira
export const servicos = { buscarVoos, criarPlanilha };

// ---------- O CADERNO ----------
// o que as ferramentas leem e escrevem enquanto o nó "ferramentas" roda; no fim, o nó copia para o Estado do grafo
export type Caderno = {
	voos: Voo[];                 // tudo o que foi pesquisado e ainda vale
	novos: Voo[];                // o que ainda não foi para uma planilha
	buscas: string[];            // as buscas feitas neste pedido
	textosDoUsuario: string[];   // o que a pessoa escreveu: serve para conferir se a data foi mesmo dita
};

function cadernoDe(config: any): Caderno {
	return config.configurable.caderno;
}

const LIMITE_DE_BUSCAS = 12;    // um modelo em loop não pode martelar o Google

// ---------- AEROPORTOS ----------
const AEROPORTOS: Record<string, string[]> = {
	"sao paulo": ["GRU", "CGH", "VCP"], "rio de janeiro": ["GIG", "SDU"], "rio": ["GIG", "SDU"], "belo horizonte": ["CNF"], "brasilia": ["BSB"],
	"salvador": ["SSA"], "recife": ["REC"], "fortaleza": ["FOR"], "porto alegre": ["POA"], "curitiba": ["CWB"], "florianopolis": ["FLN"],
	"natal": ["NAT"], "manaus": ["MAO"], "belem": ["BEL"], "goiania": ["GYN"], "maceio": ["MCZ"], "joao pessoa": ["JPA"], "vitoria": ["VIX"],
	"foz do iguacu": ["IGU"], "campo grande": ["CGR"], "cuiaba": ["CGB"],
	"lisboa": ["LIS"], "porto": ["OPO"], "madri": ["MAD"], "madrid": ["MAD"], "barcelona": ["BCN"], "paris": ["CDG", "ORY"], "londres": ["LHR", "LGW"],
	"roma": ["FCO"], "milao": ["MXP"], "amsterda": ["AMS"], "frankfurt": ["FRA"], "berlim": ["BER"], "zurique": ["ZRH"], "dublin": ["DUB"],
	"nova york": ["JFK", "EWR"], "miami": ["MIA"], "orlando": ["MCO"], "boston": ["BOS"], "los angeles": ["LAX"], "san francisco": ["SFO"], "chicago": ["ORD"],
	"washington": ["IAD"], "toronto": ["YYZ"], "cidade do mexico": ["MEX"], "cancun": ["CUN"],
	"buenos aires": ["EZE", "AEP"], "santiago": ["SCL"], "montevideu": ["MVD"], "lima": ["LIM"], "bogota": ["BOG"],
	"toquio": ["HND", "NRT"], "dubai": ["DXB"], "joanesburgo": ["JNB"],
};

function semAcento(texto: string) {
	return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

// aceita cidade ou código: "São Paulo" -> GRU, CGH e VCP. O modelo não precisa decorar aeroporto nenhum.
export function resolverAeroportos(texto: string) {
	const achados = AEROPORTOS[semAcento(texto)];
	if (achados) return achados;
	if (/^[A-Za-z]{3}$/.test(texto.trim())) return [texto.trim().toUpperCase()];
	throw new Error(`não conheço "${texto}". Passe o código de 3 letras do aeroporto; se não souber, pergunte. Não chute.`);
}

// ---------- DATAS ----------
export function hojeEmSaoPaulo() {
	return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });    // "sv-SE" escreve AAAA-MM-DD
}

const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DIAS_DA_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const NOMES_DOS_DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function diaDaSemana(data: string) {
	return NOMES_DOS_DIAS[new Date(data + "T00:00:00Z").getUTCDay()];
}

function somarDias(data: string, dias: number) {
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

// "12/12", "12 de dezembro", "dia 13", "amanhã", "próxima sexta", "2026-12-12" -> AAAA-MM-DD
export function entenderData(texto: string, hoje = hojeEmSaoPaulo()) {
	const limpo = semAcento(texto);
	let achado;
	let data;

	if ((achado = limpo.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) data = montarData(Number(achado[1]), Number(achado[2]), Number(achado[3]));
	else if ((achado = limpo.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/))) data = montarData(Number(achado[3].padStart(4, "20")), Number(achado[2]), Number(achado[1]));
	else if ((achado = limpo.match(/\b(\d{1,2})\/(\d{1,2})\b/))) data = proximaOcorrencia(Number(achado[2]), Number(achado[1]), hoje);
	else if (limpo.includes("depois de amanha")) data = somarDias(hoje, 2);
	else if (limpo.includes("amanha")) data = somarDias(hoje, 1);
	else if (limpo.includes("hoje")) data = hoje;
	else if ((achado = limpo.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/)) && MESES.includes(achado[2])) {
		const mes = MESES.indexOf(achado[2]) + 1;
		data = achado[3] ? montarData(Number(achado[3]), mes, Number(achado[1])) : proximaOcorrencia(mes, Number(achado[1]), hoje);
	} else if ((achado = limpo.match(/\bdia\s+(\d{1,2})\b/))) {
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
		const limpo = semAcento(texto);
		const palavraDeTempo = /hoje|amanha|semana|segunda|terca|quarta|quinta|sexta|sabado|domingo/.test(limpo);
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
	// a lista também vai junto: sem ela, o modelo diz que uma companhia "não apareceu" só porque não venceu nada
	const lista = voos.toSorted((a, b) => a.preco - b.preco).slice(0, 10).map(descreverVoo).join("\n");
	const resto = voos.length > 10 ? `\nHá mais ${voos.length - 10} voos: use filtrar_voos para ver.` : "";
	return `${nome} (${voos.length} voos)\nMais barato: ${descreverVoo(barato)}\nMais rápido: ${descreverVoo(rapido)}\nMelhor custo-benefício: ${descreverVoo(melhor)}\nComprar: ${barato.link}\nOs voos, do mais barato ao mais caro:\n${lista}${resto}`;
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
					avisos.push(`${origem}→${destino} em ${data}: erro: ${erro.message}`);
				}
			}
		}
	}
	return { achados, avisos };
}

function conferirData(caderno: Caderno, texto: string) {
	const data = entenderData(texto);
	if (!dataFoiDita(data, caderno.textosDoUsuario)) throw new Error(`a data ${data} não aparece no pedido. Não escolha uma data: pergunte qual é o dia.`);
	return data;
}

// ---------- OS CAMPOS QUE SE REPETEM ----------
// z.coerce: se o modelo mandar "2" em vez de 2, o código conserta sozinho
const passageiros = {
	adultos: z.coerce.number().int().default(1).describe("Quantos adultos. Se o pedido não disser, 1."),
	criancas: z.coerce.number().int().default(0).describe("Quantas crianças de 2 a 11 anos. Se o pedido não disser, 0."),
	classe: z.enum(["economica", "premium", "executiva", "primeira"]).default("economica").describe("Se o pedido não disser, economica."),
};

function trechoNaMemoria(origem?: string, destino?: string, data?: string) {
	const origens = origem ? resolverAeroportos(origem) : null;
	const destinos = destino ? resolverAeroportos(destino) : null;
	const dia = data ? entenderData(data) : null;
	return (voo: Voo) => (!origens || origens.includes(voo.origem)) && (!destinos || destinos.includes(voo.destino)) && (!dia || voo.data === dia);
}

// ---------- FERRAMENTAS PARA ENTENDER E BUSCAR ----------
const buscarAeroportos = tool(
	async ({ cidade }) => `${cidade}: ${resolverAeroportos(cidade).join(", ")}`,
	{
		name: "buscar_aeroportos",
		description: "Diz os códigos dos aeroportos de uma cidade. Não precisa usar antes de buscar_voos, que já aceita o nome da cidade.",
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
		const { achados, avisos } = await pesquisarVarios(caderno, resolverAeroportos(origem), resolverAeroportos(destino), [dia], adultos, criancas, classe);
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

		const { achados, avisos } = await pesquisarVarios(caderno, resolverAeroportos(origem), resolverAeroportos(destino), datas, adultos, criancas, classe);
		const maisBaratoDoDia = [...Map.groupBy(achados, (voo) => voo.data).values()].map((voos) => voos.toSorted((a, b) => a.preco - b.preco)[0]);
		const linhas = maisBaratoDoDia.toSorted((a, b) => a.preco - b.preco).map((voo) => `${voo.data} (${diaDaSemana(voo.data)}) ${voo.origem}→${voo.destino}: ${descreverVoo(voo)}`);
		const cortado = fim > datas.at(-1)! ? [`Só pesquisei até ${datas.at(-1)}: o limite é de 7 dias.`] : [];
		return [linhas.length ? "Do dia mais barato ao mais caro:" : "Nenhum voo encontrado.", ...linhas, ...avisos, ...cortado].join("\n");
	},
	{
		name: "buscar_varios_dias",
		description: "Para datas flexíveis: pesquisa cada dia de um período (até 7 dias) e devolve os dias do mais barato ao mais caro.",
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
		const noTrecho = trechoNaMemoria(filtro.origem, filtro.destino, filtro.data);
		const voos = cadernoDe(config).voos
			.filter(noTrecho)
			.filter((voo) => filtro.escalas_maximas === undefined || voo.escalas <= filtro.escalas_maximas)
			// modelo fraco preenche os campos que não usa com 0. Preço ou duração 0 não existem, então 0 quer dizer "sem limite".
			// Já escalas_maximas 0 é de verdade: quer dizer só voos diretos.
			.filter((voo) => !filtro.preco_maximo || voo.preco <= filtro.preco_maximo)
			.filter((voo) => !filtro.duracao_maxima_horas || voo.duracao_min <= filtro.duracao_maxima_horas * 60)
			.filter((voo) => !filtro.companhia || semAcento(voo.companhia).includes(semAcento(filtro.companhia)))
			.filter((voo) => !filtro.saida_depois_de || voo.saida >= filtro.saida_depois_de)
			.filter((voo) => !filtro.saida_antes_de || voo.saida <= filtro.saida_antes_de)
			.toSorted(ordens[filtro.ordenar_por]);
		if (voos.length === 0) return "Nenhum dos voos pesquisados passa nesse filtro.";
		const linhas = voos.slice(0, 10).map((voo) => `${nomeDoTrecho(voo)}: ${descreverVoo(voo)}`);
		return `${voos.length} voos passam no filtro:\n${linhas.join("\n")}\nComprar: ${voos[0].link}`;
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

// ---------- O CARDÁPIO ----------
// quanto menos opções, menos um modelo fraco se confunde: sem voos na memória, as de análise nem aparecem
const paraBuscar = [buscarVoosFerramenta, buscarVariosDias, buscarAeroportos, entenderDataFerramenta, calcular];
const paraAnalisar = [filtrarVoos, melhoresVoos, combinarIdaEVolta, listarPesquisas];
export const todasAsFerramentas = [...paraBuscar, ...paraAnalisar];

export function ferramentasDaEtapa(temVoos: boolean) {
	return temVoos ? todasAsFerramentas : paraBuscar;
}

// modelos fracos mandam null ou "" nos campos opcionais; para o código isso é o mesmo que não mandar
export function limparArgumentos(args: Record<string, any>) {
	return Object.fromEntries(Object.entries(args).filter(([_campo, valor]) => valor !== null && valor !== ""));
}
