// hotels.ts - pesquisa hotéis de verdade no Google Hotels, em TypeScript puro
//
// Não é uma API oficial: lemos a mesma página que o navegador recebe, igual o flights.ts faz com o
// Google Flights. Se o Google mudar a página, lerPagina dá um erro claro em vez de fingir que não
// há hotel.
//
// O QUE É REAL E O QUE NÃO VEM: o nome, a nota, o número de avaliações e as comodidades são de
// verdade, do hotel de verdade. O PREÇO DAS SUAS DATAS NÃO VEM. A página sem JavaScript sempre
// mostra o preço de uma noite nas datas que o próprio Google escolhe (hoje/amanhã), e ignora
// checkin, checkout e guests na URL — testamos os três e o parâmetro "ts" também. Então guardamos
// esse preço como diaria_referencia, junto das datas a que ele se refere, e NUNCA multiplicamos por
// noites: um total calculado em cima da diária de outra data seria um número inventado com cara de
// real. Para o preço das datas certas, a pessoa abre o link.
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node sources/hotels.ts Lisboa 2026-12-12 2026-12-19 2

import { hojeEmSaoPaulo } from "../brain/tools.ts";

// o formato de cada hospedagem
export type Hospedagem = {
	nome: string;
	cidade: string;             // o que o usuário pediu, ex "Lisboa"
	entrada: string;            // "AAAA-MM-DD", do pedido
	saida: string;              // do pedido
	noites: number;             // do pedido
	hospedes: number;           // do pedido
	nota: number | null;        // 0 a 5, a nota do Google. null quando o hotel ainda não tem nota
	avaliacoes: number | null;  // quantas avaliações formam essa nota
	comodidades: string[];      // as que o Google mostra no cartão, ex ["Café da manhã", "Wi-Fi gratuito"]
	cafe: boolean;              // café da manhã incluso (o Google escreve "($)" quando é pago à parte)
	diaria_referencia: number;  // em reais, UMA noite, nas datas abaixo — não nas datas do pedido
	datas_do_preco: string;     // as datas que o Google usou, ex "qua., 4 de nov. a qui., 5 de nov."
	link: string;               // a busca no Google Hotels, já com cidade, datas e hóspedes
};

// ---------- CUSTO-BENEFÍCIO ----------
// mesma ideia dos voos: o que incomoda vira dinheiro. Só que aqui a única grandeza em reais que
// temos de verdade é a diária de referência, então a comparação é por noite, não pela estadia.
// Estes números são uma ESCOLHA nossa, não uma verdade do mercado. Mude à mão se discordar.
const DESCONTO_DO_CAFE = 40;            // por noite, por hóspede: café que sai do bolso se não vier incluso
const CUSTO_POR_PONTO_DE_NOTA = 120;    // por ponto abaixo de NOTA_BOA: quarto ruim incomoda toda noite
const NOTA_BOA = 4.5;                   // na escala do Google, que vai até 5

// Nota 5 de 5 com uma avaliação não é nota: num pedido real, um hotel desconhecido com 1 avaliação
// ganhou o custo-benefício de todos os outros. Abaixo deste número, a nota não conta nem a favor nem
// contra, igual a um hotel sem nota nenhuma. O número é uma escolha nossa, mude à mão se discordar.
const AVALIACOES_PARA_CONFIAR = 30;

export function notaConfiavel(h: Hospedagem) {
	return h.nota !== null && (h.avaliacoes ?? 0) >= AVALIACOES_PARA_CONFIAR ? h.nota : null;
}

export function precoEquivalente(h: Hospedagem) {
	const cafe = h.cafe ? DESCONTO_DO_CAFE * h.hospedes : 0;
	// hotel sem nota confiável não é punido: não dá para cobrar por um incômodo que ninguém mediu ainda
	const nota = notaConfiavel(h);
	const incomodo = nota === null ? 0 : Math.max(0, NOTA_BOA - nota) * CUSTO_POR_PONTO_DE_NOTA;
	return Math.round(h.diaria_referencia - cafe + incomodo);
}

// ---------- CONFERIR O PEDIDO ----------
// quem escolhe esses valores é o modelo de IA, então conferimos antes de usar.
// Diferente do flights.ts, aqui devolvemos a mensagem em vez de lançar erro: o nó do grafo vai querer
// mostrar o problema para a pessoa, não quebrar.
function dataExiste(data: string) {
	return /^\d{4}-\d{2}-\d{2}$/.test(data) && new Date(data + "T00:00:00Z").toJSON()?.slice(0, 10) === data;
}

function noitesEntre(entrada: string, saida: string) {
	return (Date.parse(saida + "T00:00:00Z") - Date.parse(entrada + "T00:00:00Z")) / 86_400_000;
}

export function conferirPedido(cidade: string, entrada: string, saida: string, hospedes: number): string {
	if (!cidade?.trim()) return "preciso saber em que cidade é a hospedagem";
	if (!dataExiste(entrada)) return "a data de entrada precisa existir e estar no formato AAAA-MM-DD, como 2026-12-12";
	if (!dataExiste(saida)) return "a data de saída precisa existir e estar no formato AAAA-MM-DD, como 2026-12-19";
	// as datas são AAAA-MM-DD, então comparar como texto já compara em ordem
	if (entrada < hojeEmSaoPaulo()) return "a data de entrada já passou";
	if (saida <= entrada) return "a saída precisa ser depois da entrada";
	if (noitesEntre(entrada, saida) > 30) return "não pesquiso mais de 30 noites de uma vez";
	if (!Number.isInteger(hospedes) || hospedes < 1) return "o número de hóspedes precisa ser de 1 a 8";
	// nos 10 mil, o modelo trocava 12 pessoas por 8 e pesquisava assim: a mensagem precisa dizer o que fazer
	if (hospedes > 8) return "só pesquiso até 8 hóspedes por quarto. Não pesquise com um número menor: pergunte à pessoa como dividir o grupo em quartos";
	return "";
}

// ---------- MONTAR O PEDIDO ----------
// o Google Hotels não tem o "tfs" binário do Flights: a busca é texto na query. As datas e os
// hóspedes entram no link porque o navegador da pessoa (que tem JavaScript) os aplica; o nosso
// fetch recebe a página pronta e o servidor os ignora.
export function montarBusca(cidade: string, entrada: string, saida: string, hospedes: number) {
	return "https://www.google.com/travel/search?" + new URLSearchParams({
		q: "hotéis em " + cidade,
		hl: "pt-BR",
		curr: "BRL",
		checkin: entrada,
		checkout: saida,
		guests: String(hospedes),
	});
}

// ---------- LER A PÁGINA ----------
// o Google escreve o HTML com nomes de classe embaralhados (PVOOXe, BgYkof...). São eles que marcam
// onde cada coisa está, e são a parte frágil: quando o Google trocar esses nomes, lerPagina para de
// achar hotel e avisa.
const MARCA_DO_CARTAO = '<a class="PVOOXe"';

const ENTIDADES: Record<string, string> = {
	"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&middot;": "·",
};

function tirarHtml(bruto: string) {
	return bruto
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTIDADES[e.toLowerCase()] ?? " ");
}

// Nome, comodidades e as datas do preço são os ÚNICOS textos livres que entram aqui de fora. Texto
// de fora vira ToolMessage, e o modelo obedece ao que lê numa ToolMessage; então eles são limitados
// aqui, na entrada, e não depois. O "|" sai de propósito: é o separador das colunas da nossa linha.
export function textoDeFora(bruto: unknown, limite = 80) {
	const limpo = tirarHtml(String(bruto ?? ""))
		.replace(/[^\p{L}\p{N} .,\-&'+()$/:º–]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return limpo.slice(0, limite);
}

function numero(bruto: string | undefined) {
	// o Google escreve 1.291 para mil duzentos e noventa e um, e 4,9 para quatro e nove
	if (bruto === undefined) return null;
	const valor = Number(bruto.replace(/\./g, "").replace(",", "."));
	return Number.isFinite(valor) ? valor : null;
}

export function lerPagina(html: string, cidade: string, entrada: string, saida: string, hospedes: number, link: string): Hospedagem[] {
	if (!html.includes(MARCA_DO_CARTAO)) {
		throw new Error("a página do Google veio sem os cartões de hotel (ela pode ter mudado, ou pediu captcha)");
	}

	// as duas datas que o Google usou para o preço estão nos campos de check-in e check-out da página
	const campos = [...html.matchAll(/value="([^"]*)" placeholder="Fazer check-(?:in|out)"/g)].map((m) => textoDeFora(m[1], 24));
	const datasDoPreco = campos.length === 2 ? `${campos[0]} a ${campos[1]}` : "datas não informadas na página";

	const noites = noitesEntre(entrada, saida);
	const pedacos = html.split(MARCA_DO_CARTAO).slice(1);
	const lista: Hospedagem[] = [];

	for (const pedaco of pedacos) {
		const nome = /<h2 jscontroller="bqejFf"[^>]*>(.*?)<\/h2>/s.exec(pedaco)?.[1];
		const diaria = numero(/aria-label="Preços a partir de R\$\s*([\d.,]+),/.exec(pedaco)?.[1] ?? undefined);
		// hotel sem nome ou sem preço nenhum não serve para comparar nada
		if (!nome || diaria === null || diaria <= 0) continue;

		const avaliacao = /aria-label="([\d,]+) de 5 estrelas em ([\d.]+) avaliaç/.exec(pedaco);
		const comodidades = [...pedaco.matchAll(/class="LtjZ2d sSHqwe ogfYpf QYEgn">([^<]*)<\/span>/g)]
			.slice(0, 4).map((m) => textoDeFora(m[1], 40)).filter(Boolean);

		lista.push({
			nome: textoDeFora(nome) || "hotel sem nome",
			cidade, entrada, saida, noites, hospedes,
			nota: numero(avaliacao?.[1]),
			avaliacoes: numero(avaliacao?.[2]),
			comodidades,
			cafe: comodidades.some((c) => /^Café da manhã$/i.test(c)),
			diaria_referencia: diaria,
			datas_do_preco: datasDoPreco,
			link,
		});
	}
	// cartão existe mas nenhum virou hotel: o Google mudou o nome ou o preço de lugar. Sem este aviso
	// a falha seria silenciosa, e o resumo diria "não achei hospedagem" como se a cidade não tivesse hotel.
	if (lista.length === 0 && pedacos.length > 2) {
		throw new Error("achei os cartões de hotel do Google mas não o nome nem o preço dentro deles (a página mudou)");
	}
	return lista.toSorted((a, b) => precoEquivalente(a) - precoEquivalente(b));
}

// ---------- PESQUISAR ----------
export async function buscarHospedagem(cidade: string, entrada: string, saida: string, hospedes = 2): Promise<Hospedagem[]> {
	const problema = conferirPedido(cidade, entrada, saida, hospedes);
	if (problema) throw new Error(problema);

	const link = montarBusca(cidade, entrada, saida, hospedes);
	const resposta = await fetch(link, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
			"Accept-Language": "pt-BR,pt;q=0.9",
		},
		signal: AbortSignal.timeout(30_000),    // desiste depois de 30 segundos, para não ficar preso
	});
	if (!resposta.ok) throw new Error("o Google respondeu com erro " + resposta.status);

	return lerPagina(await resposta.text(), cidade, entrada, saida, hospedes, link);
}

// ---------- ESCREVER UMA HOSPEDAGEM ----------
// mesmo formato de linha do descreverVoo: tudo numa linha, separado por "|", já com o custo-benefício
// calculado pelo código, para o modelo nunca ter que fazer a conta
export function descreverHospedagem(h: Hospedagem) {
	// quem lê precisa ver que a nota é de poucas avaliações: é o aviso que evita confiar num 5 de 5 de uma pessoa
	const quantas = h.avaliacoes === 1 ? "1 avaliação" : `${h.avaliacoes} avaliações`;
	const poucas = notaConfiavel(h) === null && h.nota !== null ? ", poucas para confiar" : "";
	const nota = h.nota === null ? "sem nota ainda" : `nota ${h.nota} de 5 (${quantas}${poucas})`;
	const extras = h.comodidades.length ? h.comodidades.join(", ") : "comodidades não informadas";
	return `R$ ${h.diaria_referencia}/noite de referência | ${h.nome} | ${nota} | ${extras} | custo-benefício R$ ${precoEquivalente(h)}`;
}

// o resumo já vem pronto, com os vencedores escolhidos pelo código
export function resumirHospedagens(lista: Hospedagem[]) {
	if (lista.length === 0) return "não achei hospedagem para esse pedido";

	const porCustoBeneficio = lista.toSorted((a, b) => precoEquivalente(a) - precoEquivalente(b));
	// Recomendar exige nota em que dá para confiar. Sem este filtro, o mais barato ganha por ser barato:
	// num pedido real de Miami quem venceu foi um hotel de R$ 255 com nota 1 de 5 de uma única pessoa.
	// A lista inteira continua saindo logo abaixo, então nada é escondido: só não é recomendado.
	const confiaveis = porCustoBeneficio.filter((h) => notaConfiavel(h) !== null);
	const melhor = confiaveis[0];
	const nota = confiaveis.toSorted((a, b) => b.nota! - a.nota!)[0];
	const barata = lista.toSorted((a, b) => a.diaria_referencia - b.diaria_referencia)[0];
	const caro = lista.toSorted((a, b) => b.diaria_referencia - a.diaria_referencia)[0];
	const primeira = lista[0];
	const cabecalho = `${primeira.cidade}, ${primeira.entrada} a ${primeira.saida} (${primeira.noites} noites, ${primeira.hospedes} hóspedes) — ${lista.length} hotéis reais`;
	// sem isso o modelo anuncia a diária como se fosse o preço da viagem da pessoa
	const aviso = `O preço é de UMA noite em ${primeira.datas_do_preco}, não das datas pedidas. Não multiplique por noites: para o valor da estadia, mande a pessoa abrir o link.`;
	// a lista inteira também vai junto: sem ela, o modelo diz que um hotel "não apareceu" só porque não venceu nada
	const texto = porCustoBeneficio.map(descreverHospedagem).join("\n");
	// nenhum hotel com nota confiável: o texto diz isso em vez de recomendar no escuro
	const recomendacao = melhor
		? `Melhor custo-benefício: ${descreverHospedagem(melhor)}\nMelhor nota: ${descreverHospedagem(nota)}`
		: "Melhor custo-benefício: nenhum destes hotéis tem avaliações suficientes para eu recomendar. Diga isso ao usuário e mande ele olhar o link.";
	return `${cabecalho}\n${aviso}\n${recomendacao}\nDiária mais barata: ${descreverHospedagem(barata)}\nDiária mais cara: ${descreverHospedagem(caro)}\nVer preço das suas datas: ${primeira.link}\nOs hotéis, do melhor para o pior no custo-benefício:\n${texto}`;
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node sources/hotels.ts ...", não quando outro arquivo importa este
if (import.meta.main) {
	const [cidade, entrada, saida, hospedes] = process.argv.slice(2);
	console.log(resumirHospedagens(await buscarHospedagem(cidade, entrada, saida, Number(hospedes ?? 2))));
}
