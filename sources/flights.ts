// flights.ts - pesquisa voos de verdade no Google Flights, em TypeScript puro
//
// Não é uma API oficial: lemos a mesma página que o navegador recebe. Se o Google mudar a página,
// lerPagina dá um erro claro em vez de fingir que não há voos.
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node sources/flights.ts GRU LIS 2026-12-12
// O calendário de preços de um período:                  node sources/flights.ts calendario SSA FRA 2026-12-01 2027-01-31

// o formato de cada voo
export type Voo = {
	origem: string;
	destino: string;
	data: string;
	companhia: string;
	preco: number;
	duracao_min: number;
	escalas: number;
	saida: string;
	chegada: string;
	link: string;
};

// ---------- CUSTO-BENEFÍCIO ----------
// transforma tudo em dinheiro: além do preço, cada hora de viagem e cada escala "custam" alguma coisa
const CUSTO_POR_HORA = 30;
const CUSTO_POR_ESCALA = 200;

export function precoEquivalente(voo: Voo) {
	return Math.round(voo.preco + (voo.duracao_min / 60) * CUSTO_POR_HORA + voo.escalas * CUSTO_POR_ESCALA);
}

// a mesma regra em palavras, para a instrução do redator e para o verificador. Ela mora aqui, junto da
// conta, porque escrita em dois lugares um dia fica diferente: aí o verificador recusaria uma resposta certa.
export const REGRA_DO_CUSTO_BENEFICIO = `o preço somado a R$ ${CUSTO_POR_HORA} por hora de viagem e R$ ${CUSTO_POR_ESCALA} por escala`;

// ---------- MONTAR O PEDIDO ----------
// o Google recebe a busca no parâmetro "tfs": um formato binário chamado Protobuf, escrito em base64.
// Cada campo é: número do campo + tipo + (tamanho) + valor.
const CLASSES: Record<string, number> = { economica: 1, premium: 2, executiva: 3, primeira: 4 };

function varint(numero: number) {
	const bytes = [];
	while (numero > 127) {
		bytes.push((numero & 127) | 128);
		numero >>>= 7;
	}
	bytes.push(numero);
	return bytes;
}

function campoNumero(campo: number, valor: number) {
	return [...varint(campo << 3), ...varint(valor)];
}

function campoBytes(campo: number, valor: number[]) {
	return [...varint((campo << 3) | 2), ...varint(valor.length), ...valor];
}

function textoEmBytes(texto: string) {
	return [...Buffer.from(texto)];
}

export function montarTfs(origem: string, destino: string, data: string, adultos: number, criancas: number, classe: string) {
	const trecho = [
		...campoBytes(2, textoEmBytes(data)),
		...campoBytes(13, campoBytes(2, textoEmBytes(origem))),
		...campoBytes(14, campoBytes(2, textoEmBytes(destino))),
	];
	// para o Google, cada passageiro é um número: 1 = adulto, 2 = criança
	const passageiros = [...Array(adultos).fill(1), ...Array(criancas).fill(2)];
	const pedido = [
		...campoBytes(3, trecho),
		...campoBytes(8, passageiros),
		...campoNumero(9, CLASSES[classe]),
		...campoNumero(19, 2),    // 2 = só ida
	];
	return Buffer.from(pedido).toString("base64");
}

// ---------- LER A PÁGINA ----------
// o Google manda as datas e horas como listas: [2026, 12, 12] e [15, 5]. Horas zeradas podem faltar:
// [8] é 08:00 e [null, 31] é 00:31
function paraMinutos(dia: number[], hora: number[] | null) {
	return Date.UTC(dia[0], dia[1] - 1, dia[2], hora?.[0] ?? 0, hora?.[1] ?? 0) / 60_000;
}

function doisDigitos(numero: number) {
	return String(numero).padStart(2, "0");
}

function formatarHora(hora: number[] | null) {
	return doisDigitos(hora?.[0] ?? 0) + ":" + doisDigitos(hora?.[1] ?? 0);
}

// O nome da companhia é o ÚNICO texto livre que entra aqui de fora: tudo o mais que lemos da página é
// número ou horário. Texto de fora vira ToolMessage, e o modelo obedece ao que lê numa ToolMessage; então
// o nome é limitado aqui, na entrada, e não depois. Sobram letras, números e a pontuação de nome de empresa.
export function nomeDeCompanhia(bruto: unknown) {
	const limpo = String(bruto ?? "").replace(/[^\p{L}\p{N} .\-&+']/gu, " ").replace(/\s+/g, " ").trim();
	return limpo.slice(0, 60) || "companhia não informada";
}

export function lerPagina(html: string, origem: string, destino: string, data: string, link: string): Voo[] {
	// os voos ficam num <script class="ds:1">, com um JSON depois de "data:"
	const marca = html.indexOf('class="ds:1"');
	if (marca === -1) throw new Error("a página do Google veio sem os dados dos voos (ela pode ter mudado)");
	const script = html.slice(html.indexOf(">", marca) + 1, html.indexOf("</script>", marca));
	const dados = script.slice(script.indexOf("data:") + 5, script.lastIndexOf(","));
	if (dados.endsWith("errorHasStatus: true")) return [];    // é assim que o Google diz "não achei voos"

	const voos: Voo[] = [];
	try {
		const pagina = JSON.parse(dados);
		if (pagina.length === 0) return [];    // rota que não existe: o Google manda uma lista vazia
		// Rota que existe mas não tem nenhum voo no dia (SSA→DEL, por exemplo): a posição dos voos vem
		// nula. Conferido na mão: nessa página não há um "R$" sequer, então é mesmo ausência de voo, e
		// não um formato que a gente deixou de entender. Antes disso aqui, o nó estourava "formato novo".
		// o "length > 4" importa: sem ele, uma página de formato desconhecido (curta) também viraria
		// "nenhum voo", e a gente perderia o aviso de que o Google mudou. Aqui a lista é longa e a
		// posição dos voos está explicitamente nula.
		if (pagina.length > 4 && pagina[3] === null) return [];

		for (const item of pagina[3][0] ?? []) {
			const preco = Number(item[1]?.[0]?.[1]);
			if (!Number.isFinite(preco) || preco <= 0) continue;    // às vezes o Google mostra um voo sem preço

			const trechos = item[0][2];
			const primeiro = trechos[0];
			const ultimo = trechos.at(-1);

			// tempo voando em cada trecho + tempo esperando em cada escala
			// (não dá para fazer chegada - saída, porque cada aeroporto está num fuso diferente)
			let duracao = 0;
			for (let i = 0; i < trechos.length; i++) {
				duracao += trechos[i][11];
				if (i > 0) duracao += paraMinutos(trechos[i][20], trechos[i][8]) - paraMinutos(trechos[i - 1][21], trechos[i - 1][10]);
			}

			if (!Number.isFinite(duracao) || duracao <= 0) continue;    // um campo de duração estranho daria NaN no custo-benefício

			voos.push({
				origem,
				destino,
				data,
				companhia: (item[0][1] ?? []).map(nomeDeCompanhia).join(" + ") || "companhia não informada",
				preco,
				duracao_min: duracao,
				escalas: trechos.length - 1,
				saida: formatarHora(primeiro[8]),
				chegada: doisDigitos(ultimo[21][2]) + "/" + doisDigitos(ultimo[21][1]) + " " + formatarHora(ultimo[10]),
				link,
			});
		}
	} catch (erro: any) {
		throw new Error("os dados da página do Google vieram num formato novo: " + erro.message);
	}
	return voos.sort((a, b) => a.preco - b.preco);
}

// ---------- PESQUISAR ----------
// devolve os voos do mais barato ao mais caro; se algo der errado, lança um erro com a explicação
// quem escolhe esses valores é o modelo de IA, então conferimos antes de usar
export function conferirPedido(origem: string, destino: string, data: string, adultos: number, criancas: number, classe: string) {
	if (!/^[A-Z]{3}$/.test(origem) || !/^[A-Z]{3}$/.test(destino)) {
		throw new Error("origem e destino precisam ser códigos de aeroporto, como GRU ou LIS");
	}
	// a data passa por dentro do Date e tem que voltar igual: assim 2026-02-30 é recusado
	if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || new Date(data + "T00:00:00Z").toJSON()?.slice(0, 10) !== data) {
		throw new Error("a data precisa existir e estar no formato AAAA-MM-DD, como 2026-12-12");
	}
	if (!Number.isInteger(adultos) || !Number.isInteger(criancas) || adultos < 1 || criancas < 0 || adultos + criancas > 9) {
		throw new Error("precisa ter ao menos 1 adulto e no máximo 9 passageiros");
	}
	if (!(classe in CLASSES)) {
		throw new Error("a classe precisa ser economica, premium, executiva ou primeira");
	}
}

export async function buscarVoos(origem: string, destino: string, data: string, adultos = 1, criancas = 0, classe = "economica"): Promise<Voo[]> {
	conferirPedido(origem, destino, data, adultos, criancas, classe);

	const parametros = new URLSearchParams({ tfs: montarTfs(origem, destino, data, adultos, criancas, classe), hl: "pt-BR", curr: "BRL" });
	const link = "https://www.google.com/travel/flights/search?" + parametros;

	// sem o "tfu", o Google manda só os "melhores voos" e deixa de fora os mais baratos
	const resposta = await fetch("https://www.google.com/travel/flights?" + parametros + "&tfu=EgQIABABIgA", {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
			"Accept-Language": "pt-BR,pt;q=0.9",
		},
		signal: AbortSignal.timeout(30_000),    // desiste depois de 30 segundos, para não ficar preso
	});
	if (!resposta.ok) throw new Error("o Google respondeu com erro " + resposta.status);

	return lerPagina(await resposta.text(), origem, destino, data, link);
}

// ---------- O CALENDÁRIO DE PREÇOS ----------
// O Google Voos mostra num calendário o preço do voo mais barato de cada dia. O pedido que a página faz para
// desenhar esse calendário (GetCalendarGraph) devolve até uns 4 meses numa chamada só, enquanto a busca normal
// é um dia por chamada. Não tem documentação: o formato foi copiado de github.com/krisukox/google-flights-api
// e conferido em 09/11/2026 (SSA→FRA, dezembro e janeiro, só ida). O preço é o que o Google guardou de buscas
// anteriores, então é aproximado (R$ 1957 no calendário, R$ 2002 na busca de verdade do mesmo dia): serve para
// achar o dia, e o preço que vai para a resposta sai da busca de verdade daquele dia.
export type DiaDoCalendario = { data: string; preco: number };

export function montarPedidoDoCalendario(origem: string, destino: string, de: string, ate: string, adultos: number, criancas: number, classe: string) {
	const lugar = (iata: string) => `[\\"${iata}\\",0]`;    // 0 é aeroporto (5 seria cidade, com o código do Google)
	// 2 é só ida; depois vêm a classe, os passageiros [adultos, crianças, bebê no colo, bebê no assento] e o trecho
	const trecho = `[[[${lugar(origem)}]],[[${lugar(destino)}]],null,0,[],[],\\"${de}\\",null,[],[],[],null,null,[],3]`;
	const busca = `[null,null,2,null,[],${CLASSES[classe]},[${adultos},${criancas},0,0],null,null,null,null,null,null,[${trecho}],null,null,null,1,null,null,null,null,null,[]]`;
	return `[null,"[null,${busca},[\\"${de}\\",\\"${ate}\\"],null,null]"]`;
}

// a resposta vem em pedaços, um por linha, depois de uma linha de proteção ")]}'". O pedaço com dados começa
// com [["wrb.fr", e o terceiro campo dele é outro JSON, em texto, com a lista [data, volta, [[null, preço], ...], 1]
export function lerCalendario(texto: string): DiaDoCalendario[] {
	const pedacos = texto.split("\n").filter((linha) => linha.startsWith('[["wrb.fr"')).map((linha) => JSON.parse(linha)[0]?.[2]).filter(Boolean);
	if (pedacos.length === 0) throw new Error("o Google não devolveu o calendário (o formato pode ter mudado)");
	return pedacos.flatMap((pedaco) => JSON.parse(pedaco)[1] ?? [])
		.map((dia: any) => ({ data: dia?.[0], preco: dia?.[2]?.[0]?.[1] }))
		.filter((dia: DiaDoCalendario) => /^\d{4}-\d{2}-\d{2}$/.test(dia.data) && Number.isFinite(dia.preco) && dia.preco > 0);
}

// sinal: o pedido cancelado (brain/channel.ts) corta também a chamada que já saiu
export async function buscarCalendario(origem: string, destino: string, de: string, ate: string, adultos = 1, criancas = 0, classe = "economica", sinal?: AbortSignal): Promise<DiaDoCalendario[]> {
	conferirPedido(origem, destino, de, adultos, criancas, classe);
	conferirPedido(origem, destino, ate, adultos, criancas, classe);
	const resposta = await fetch("https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetCalendarGraph?hl=pt-BR&gl=BR&curr=BRL&rt=c", {
		method: "POST",
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			// idioma, país e moeda: sem isto o Google escolhe a moeda pelo endereço de quem pergunta
			"X-Goog-Ext-259736195-Jspb": '["pt-BR","BR","BRL",1,null,[180],null,[],1,[]]',
		},
		body: "f.req=" + encodeURIComponent(montarPedidoDoCalendario(origem, destino, de, ate, adultos, criancas, classe)),
		signal: sinal ? AbortSignal.any([sinal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});
	if (!resposta.ok) throw new Error("o Google respondeu com erro " + resposta.status);
	return lerCalendario(await resposta.text());
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node sources/flights.ts ...", não quando outro arquivo importa este.
// O calendário: node sources/flights.ts calendario SSA FRA 2026-12-01 2027-01-31
if (import.meta.main && process.argv[2] === "calendario") {
	const [, origem, destino, de, ate] = process.argv.slice(2);
	const dias = await buscarCalendario(origem, destino, de, ate);
	console.log(`${dias.length} dias. Os mais baratos: ` + dias.toSorted((a, b) => a.preco - b.preco).slice(0, 5).map((dia) => `${dia.data} R$ ${dia.preco}`).join(" | "));
} else if (import.meta.main) {
	const [origem, destino, data, adultos, criancas, classe] = process.argv.slice(2);
	const voos = await buscarVoos(origem, destino, data, Number(adultos ?? 1), Number(criancas ?? 0), classe);
	console.log(voos.length + " voos. Os mais baratos:");
	for (const voo of voos.slice(0, 5)) {
		console.log(`R$ ${voo.preco}  ${voo.companhia}  ${voo.escalas} escala(s)  ${voo.duracao_min} min  sai ${voo.saida}  chega ${voo.chegada}`);
	}
}
