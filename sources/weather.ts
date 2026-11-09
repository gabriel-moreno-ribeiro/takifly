// weather.ts - o tempo agora e a previsão dos próximos 7 dias de uma cidade, pelo Open-Meteo
//
// Por que uma fonte só para o clima, se o bot já busca na internet: temperatura copiada de site vem velha ou
// de outro lugar. O Open-Meteo devolve o número medido e a previsão, sem chave e sem cadastro.
//
// ATENÇÃO À LICENÇA: o uso grátis é só NÃO COMERCIAL (open-meteo.com/en/terms), com até 10 mil chamadas
// por dia, e pede o crédito "Open-Meteo" (CC-BY 4.0), que vai junto da resposta. Se o Takifly virar
// produto pago, troque pelo plano pago deles, com chave.
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node sources/weather.ts Lisboa

import { textoDeFora } from "./hotels.ts";

export type Clima = {
	lugar: string;                 // "Lisboa, Portugal": o nome que o Open-Meteo achou, para a pessoa ver se é o lugar certo
	fuso: string;                  // "Europe/Lisbon": as horas da previsão são do lugar
	agora: { hora: string; temperatura: number; sensacao: number; tempo: string };
	dias: { data: string; maxima: number; minima: number; chanceDeChuva: number | null; tempo: string }[];
};

// os códigos de tempo da OMM (WMO), em português
const TEMPO: [number, string][] = [
	[0, "céu limpo"], [1, "quase sem nuvens"], [2, "parcialmente nublado"], [3, "nublado"],
	[45, "neblina"], [48, "neblina com geada"], [51, "garoa"], [56, "garoa congelante"], [61, "chuva"],
	[66, "chuva congelante"], [71, "neve"], [77, "grãos de neve"], [80, "pancadas de chuva"], [85, "pancadas de neve"], [95, "trovoada"],
];
export function descreverTempo(codigo: number) {
	return TEMPO.findLast(([desde]) => codigo >= desde)?.[1] ?? "tempo desconhecido";
}

async function lerJson(endereco: string) {
	const falhou = (motivo: string) => new Error(`o serviço de clima não respondeu agora (${motivo}). Diga que não conseguiu ver o tempo e peça para tentar de novo daqui a pouco.`);
	let resposta: Response;
	try {
		resposta = await fetch(endereco, { signal: AbortSignal.timeout(15_000) });
	} catch (erro: any) {
		throw falhou(erro.name === "TimeoutError" ? "demorou demais" : "sem conexão");
	}
	if (!resposta.ok) throw falhou(`erro ${resposta.status}`);
	return resposta.json().catch(() => { throw falhou("resposta ilegível"); }) as Promise<any>;
}

// "Lisboa, Portugal" não acha nada no Open-Meteo, e "Nova York" acha só uma cidade de 4 mil habitantes no
// Maranhão. Então: a cidade vai sem o país, vêm 5 resultados, ganha o do país pedido e, depois, o mais populoso
const PAIS_EM_INGLES = new Intl.DisplayNames(["en"], { type: "region" });
export function escolherLugar(resultados: any[], pais = "") {
	const nomesDoPais = (lugar: any) => [lugar.country ?? "", lugar.country_code ?? "", lugar.country_code ? PAIS_EM_INGLES.of(lugar.country_code) ?? "" : ""].map((nome) => semAcento(String(nome)));
	const doPais = pais ? resultados.filter((lugar) => nomesDoPais(lugar).some((nome) => nome && (nome === semAcento(pais) || nome.includes(semAcento(pais))))) : [];
	return [...(doPais.length > 0 ? doPais : resultados)].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
}
const semAcento = (texto: string) => texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

export async function verClima(pedido: string): Promise<Clima> {
	const [cidade, pais = ""] = pedido.split(",").map((parte) => parte.trim());
	const achados = await lerJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=5&language=pt`);
	const lugar = escolherLugar(achados.results ?? [], pais);
	if (!lugar) throw new Error(`não achei a cidade "${pedido}". Tente com o nome em inglês (New York, Munich) ou pergunte de novo.`);
	const campos = "current=temperature_2m,apparent_temperature,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code";
	const previsao = await lerJson(`https://api.open-meteo.com/v1/forecast?latitude=${lugar.latitude}&longitude=${lugar.longitude}&${campos}&timezone=auto&forecast_days=7`);
	return lerClima(lugar, previsao);
}

// as duas respostas do Open-Meteo viram um Clima. Separado da busca para o teste rodar sem internet
export function lerClima(lugar: any, previsao: any): Clima {
	const nome = [lugar.name, lugar.admin1 && lugar.admin1 !== lugar.name ? lugar.admin1 : "", lugar.country].filter(Boolean).map((parte) => textoDeFora(parte, 60)).join(", ");
	const dia = previsao.daily;
	// valor que falta (null) não vira 0 °C nem céu limpo: o dia sem dado sai da lista
	const temDado = (i: number) => dia.temperature_2m_max[i] != null && dia.temperature_2m_min[i] != null && dia.weather_code[i] != null;
	if (previsao.current?.temperature_2m == null) throw new Error("o serviço de clima não trouxe a temperatura de agora. Diga que não conseguiu ver o tempo e peça para tentar de novo.");
	return {
		lugar: nome,
		fuso: String(previsao.timezone ?? ""),
		agora: {
			hora: String(previsao.current.time).slice(11, 16),
			temperatura: Math.round(previsao.current.temperature_2m),
			sensacao: Math.round(previsao.current.apparent_temperature ?? previsao.current.temperature_2m),
			tempo: descreverTempo(previsao.current.weather_code),
		},
		dias: dia.time.map((data: string, i: number) => temDado(i) && ({
			data,
			maxima: Math.round(dia.temperature_2m_max[i]),
			minima: Math.round(dia.temperature_2m_min[i]),
			chanceDeChuva: dia.precipitation_probability_max?.[i] ?? null,
			tempo: descreverTempo(dia.weather_code[i]),
		})).filter(Boolean),
	};
}

// o que a ferramenta devolve ao modelo: temperaturas inteiras, e o verificador (brain/checker.ts) confere que a
// resposta usa exatamente estes números
export function descreverClima(clima: Clima) {
	const agora = `Agora (${clima.agora.hora}, hora local): ${clima.agora.temperatura} °C, sensação de ${clima.agora.sensacao} °C, ${clima.agora.tempo}.`;
	const dias = clima.dias.map((dia) => `${dia.data}: mínima ${dia.minima} °C, máxima ${dia.maxima} °C, ${dia.tempo}${dia.chanceDeChuva == null ? "" : `, chance de chuva ${dia.chanceDeChuva}%`}`);
	return [
		`Clima em ${clima.lugar} (dados: Open-Meteo). Se não for este o lugar que a pessoa quis, pergunte.`,
		agora,
		"Previsão dos próximos 7 dias (para depois disso não há previsão; o clima típico da época se busca na internet):",
		...dias,
	].join("\n");
}

if (import.meta.main) console.log(descreverClima(await verClima(process.argv[2] ?? "Lisboa")));
