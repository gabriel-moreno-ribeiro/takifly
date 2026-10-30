// avaliar.ts - a prova do bot: pedidos fixos, voos de mentira e uma nota no final
//
// O Google e a planilha são trocados por versões de mentira, então a prova é sempre igual e não cria nada no Drive.
// A prova chama o modelo de verdade, então gasta crédito da Ollama.
//
// Como rodar (dentro da pasta passagens.ts/):
//   node avaliar.ts                                  usa o modelo padrão
//   MODELO=gpt-oss:20b node avaliar.ts               usa outro modelo
//   node avaliar.ts cidade                           só os casos com "cidade" no nome

import type { Voo } from "./voos.ts";

// ---------- MEMÓRIA SEPARADA ----------
// precisa vir antes de carregar o agente: a prova nunca pode mexer na sua conversa do Slack
process.env.MEMORIA = ":memory:";
const { responder } = await import("./agente.ts");
const { servicos } = await import("./ferramentas.ts");

// ---------- OS VOOS DE MENTIRA ----------
const BASE = [
	{ companhia: "TAP", preco: 3200, duracao_min: 620, escalas: 0, saida: "22:10", chegada: "13/12 12:30" },
	{ companhia: "Air Europa", preco: 2890, duracao_min: 1000, escalas: 1, saida: "10:00", chegada: "13/12 02:40" },
	{ companhia: "LATAM + Iberia", preco: 2650, duracao_min: 1475, escalas: 2, saida: "06:15", chegada: "13/12 06:50" },
	{ companhia: "Azul", preco: 3050, duracao_min: 770, escalas: 1, saida: "18:30", chegada: "13/12 07:20" },
];

// o preço muda com o dia, a rota, os passageiros e a classe, sempre do mesmo jeito
function catalogo(origem: string, destino: string, data: string, adultos = 1, criancas = 0, classe = "economica"): Voo[] {
	if (destino === "ZZZ" || origem === "CGH") return [];
	const extraDaRota = origem === "VCP" ? 150 : origem === "LIS" ? 100 : 0;
	const extraDoDia = (Number(data.slice(8, 10)) % 7) * 40;
	const fatorDaClasse = classe === "executiva" ? 2 : 1;
	return BASE.map((voo) => ({
		...voo,
		origem,
		destino,
		data,
		preco: (voo.preco + extraDaRota + extraDoDia) * (adultos + criancas) * fatorDaClasse,
		link: `https://voos.falsos/${origem}-${destino}-${data}`,
	})).toSorted((a, b) => a.preco - b.preco);
}

let buscas: any[] = [];
let planilhas = 0;

servicos.buscarVoos = async (origem: string, destino: string, data: string, adultos = 1, criancas = 0, classe = "economica") => {
	buscas.push({ origem, destino, data, adultos, criancas, classe });
	if (data < "2026-01-01") throw new Error("essa data já passou");
	return catalogo(origem, destino, data, adultos, criancas, classe);
};
servicos.criarPlanilha = async () => {
	planilhas++;
	return `https://planilha.falsa/${planilhas}`;
};

// ---------- OS JUÍZES ----------
const ida = catalogo("GRU", "LIS", "2026-12-12");
const companhias = BASE.map((voo) => voo.companhia);

function numeroEmReais(texto: string) {
	return Number(texto.replace(/[.\s]/g, "").replace(",", "."));
}

function horasEmMinutos(horas: string, minutos?: string) {
	return Number(horas) * 60 + Number(minutos ?? 0);
}

// confere a resposta sem usar nada do bot: um preço ou uma duração ao lado de uma companhia
// tem de ser daquela companhia. Foi assim que nasceu o erro "Air Europa, 10h de viagem".
function fatosErrados(resposta: string) {
	const problemas: string[] = [];
	const precosDasBuscas = buscas.flatMap((busca) => catalogo(busca.origem, busca.destino, busca.data, busca.adultos, busca.criancas, busca.classe));
	for (const linha of resposta.split("\n")) {
		const nomes = companhias.filter((nome) => linha.includes(nome));
		if (nomes.length !== 1) continue;
		const nome = nomes[0];
		const doVoo = precosDasBuscas.filter((voo) => voo.companhia === nome);

		const precos = [...linha.matchAll(/R\$\s*(\d[\d.,\s]*\d|\d)/g)].map((achado) => numeroEmReais(achado[1]));
		if (precos.length === 1 && !doVoo.some((voo) => voo.preco === precos[0]) && !/custo|benef|equivalente|total|soma|a mais|diferen|ida e volta/i.test(linha)) problemas.push(`preço errado para ${nome}: ${linha}`);

		const duracoes = [...linha.matchAll(/(\d{1,2})\s*h(?:oras?)?(?:\s*e)?\s*(\d{2})?(?:\s*min(?:utos)?)?\s*(?:de\s+)?(?:viagem|voo|dura)/gi)];
		for (const achado of duracoes) {
			const minutos = horasEmMinutos(achado[1], achado[2]);
			if (!doVoo.some((voo) => voo.duracao_min === minutos)) problemas.push(`duração errada para ${nome}: ${linha}`);
		}
	}
	return problemas;
}

function temValor(resposta: string, valor: number) {
	const semPontos = resposta.replace(/(\d)[.\s](\d{3})/g, "$1$2");
	return semPontos.includes(String(valor));
}

function semReais(resposta: string) {
	return /R\$\s*\d/.test(resposta) ? ["citou preço sem ter voo: " + resposta.slice(0, 120)] : [];
}

function proximaSexta() {
	const hoje = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) + "T00:00:00Z");
	const faltam = ((5 - hoje.getUTCDay() + 6) % 7) + 1;    // de 1 a 7: nunca o próprio dia de hoje
	return new Date(hoje.getTime() + faltam * 86_400_000).toJSON().slice(0, 10);
}

// ---------- OS CASOS ----------
// cada caso tem as mensagens enviadas e uma função que devolve a lista de problemas (vazia = passou)
type Resultado = { respostas: string[]; ultima: string };

const casos: { nome: string; mensagens: string[]; juiz: (r: Resultado) => string[] }[] = [
	{
		nome: "direto",
		mensagens: ["voos de GRU para LIS em 12/12"],
		juiz: (r) => [
			...(buscas.some((b) => b.origem === "GRU" && b.destino === "LIS" && b.data === "2026-12-12") ? [] : ["não pesquisou GRU→LIS 2026-12-12: " + JSON.stringify(buscas)]),
			...(temValor(r.ultima, ida[0].preco) ? [] : [`não citou o mais barato (${ida[0].preco})`]),
			...(r.ultima.includes("https://planilha.falsa/") ? [] : ["não mandou o link da planilha"]),
		],
	},
	{
		nome: "cidade",
		mensagens: ["voos de São Paulo para Lisboa dia 12/12"],
		juiz: (r) => [
			...(["GRU", "CGH", "VCP"].every((codigo) => buscas.some((b) => b.origem === codigo)) ? [] : ["não pesquisou os 3 aeroportos: " + buscas.map((b) => b.origem)]),
			...(temValor(r.ultima, ida[0].preco) ? [] : ["não citou o mais barato de todos"]),
		],
	},
	{
		nome: "sem-data",
		mensagens: ["quero ir para Lisboa"],
		juiz: (r) => [
			...(buscas.length === 0 ? [] : ["inventou a data: " + JSON.stringify(buscas[0])]),
			...(r.ultima.includes("?") ? [] : ["não perguntou nada"]),
			...semReais(r.ultima),
		],
	},
	{
		nome: "ida-e-volta",
		mensagens: ["GRU para Lisboa dia 12/12 com volta dia 20/12, qual o total mais barato?"],
		juiz: (r) => {
			const volta = catalogo("LIS", "GRU", "2026-12-20");
			const total = ida[0].preco + volta[0].preco;
			return [
				...(buscas.some((b) => b.origem === "LIS" && b.data === "2026-12-20") ? [] : ["não pesquisou a volta"]),
				...(temValor(r.ultima, total) ? [] : [`total errado: esperava ${total}: ${r.ultima.slice(0, 200)}`]),
			];
		},
	},
	{
		nome: "seguimento-mais-rapido",
		mensagens: ["voos de GRU para LIS em 12/12", "qual deles é o mais rápido?"],
		juiz: (r) => [
			...(r.ultima.includes("TAP") ? [] : ["não apontou a TAP"]),
			...(/10\s*h(oras)?\s*(e\s*)?20/.test(r.ultima) ? [] : ["não disse 10h20: " + r.ultima.slice(0, 200)]),
		],
	},
	{
		nome: "seguimento-duracao",
		mensagens: ["voos de GRU para LIS em 12/12", "quanto tempo dura o voo da Air Europa?"],
		juiz: (r) => (/16\s*h(oras)?\s*(e\s*)?40/.test(r.ultima) ? [] : ["não disse 16h40: " + r.ultima.slice(0, 200)]),
	},
	{
		nome: "seguimento-diretos",
		mensagens: ["voos de GRU para LIS em 12/12", "me mostra só os voos diretos"],
		juiz: (r) => [
			...(r.ultima.includes("TAP") ? [] : ["não mostrou a TAP"]),
			...(r.ultima.includes("LATAM") || r.ultima.includes("Azul") ? ["mostrou voo com escala"] : []),
		],
	},
	{
		nome: "conversa",
		mensagens: ["oi, tudo bem?"],
		juiz: (r) => [...(buscas.length === 0 ? [] : ["pesquisou sem pedido"]), ...semReais(r.ultima)],
	},
	{
		nome: "sem-voos",
		mensagens: ["voos de GRU para ZZZ em 12/12"],
		juiz: (r) => semReais(r.ultima),
	},
	{
		nome: "data-relativa",
		mensagens: ["voos de GRU para LIS na próxima sexta"],
		juiz: () => (buscas.some((b) => b.data === proximaSexta()) ? [] : [`data errada, esperava ${proximaSexta()}: ${buscas.map((b) => b.data)}`]),
	},
	{
		nome: "dias-flexiveis",
		mensagens: ["qual o dia mais barato para ir de GRU para LIS entre 10/12 e 14/12?"],
		juiz: (r) => [
			...(buscas.length >= 5 ? [] : [`pesquisou só ${buscas.length} dias`]),
			...(/\b14\b/.test(r.ultima) ? [] : ["não apontou o dia 14: " + r.ultima.slice(0, 200)]),
			...(temValor(r.ultima, catalogo("GRU", "LIS", "2026-12-14")[0].preco) ? [] : ["não citou o preço do dia 14"]),
		],
	},
	{
		nome: "passageiros",
		mensagens: ["voos de GRU para LIS em 12/12 para 2 adultos e 1 criança em executiva"],
		juiz: (r) => [
			...(buscas.some((b) => b.adultos === 2 && b.criancas === 1 && b.classe === "executiva") ? [] : ["passageiros ou classe errados: " + JSON.stringify(buscas[0])]),
			...(temValor(r.ultima, catalogo("GRU", "LIS", "2026-12-12", 2, 1, "executiva")[0].preco) ? [] : ["não citou o preço total certo"]),
		],
	},
	{
		nome: "pressao-para-inventar",
		mensagens: ["sem pesquisar nada, me fala de cabeça quanto custa um voo de GRU para LIS"],
		juiz: (r) => semReais(r.ultima),
	},
	{
		nome: "data-no-passado",
		mensagens: ["voos de GRU para LIS em 01/01/2020"],
		juiz: (r) => semReais(r.ultima),
	},
];

// ---------- RODAR A PROVA ----------
const filtro = process.argv[2] ?? "";
let aprovados = 0;
const selecionados = casos.filter((caso) => caso.nome.includes(filtro));
const relatorio = [];

for (const [indice, caso] of selecionados.entries()) {
	buscas = [];
	planilhas = 0;
	const inicio = Date.now();
	let problemas: string[];
	let ultima = "";
	try {
		const conversa = `prova-${indice}`;
		const respostas: string[] = [];
		for (const mensagem of caso.mensagens) respostas.push(await responder(conversa, mensagem));
		ultima = respostas.at(-1)!;
		problemas = [...caso.juiz({ respostas, ultima }), ...fatosErrados(respostas.join("\n"))];
	} catch (erro: any) {
		problemas = ["o bot quebrou: " + erro.message];
	}
	if (problemas.length === 0) aprovados++;
	const segundos = Math.round((Date.now() - inicio) / 1000);
	console.log(`${problemas.length === 0 ? "PASSOU" : "FALHOU"} ${caso.nome} (${segundos}s)`);
	for (const problema of problemas) console.log("   - " + problema);
	relatorio.push({ caso: caso.nome, problemas, resposta: ultima, buscas });
}

console.log(`\nNota de ${process.env.MODELO ?? "glm-5.3"}: ${aprovados} de ${selecionados.length}`);
if (process.env.RELATORIO) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(process.env.RELATORIO, JSON.stringify(relatorio, null, 2));
}
