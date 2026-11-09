// airports.ts - de que cidade e de que país é este aeroporto, e que aeroporto é esta cidade
//
// A tabela antiga era escrita à mão e tinha uns 50 lugares: "quero ir para Nova Délhi" fazia o bot
// dizer que não conhecia o lugar e pedir o código de 3 letras. Agora a tabela vem do OurAirports
// (país, estado, município, tamanho) somada ao Wikidata (o nome da cidade em seis idiomas), e cobre
// o mundo todo: "Nova Délhi", "New Delhi" e "Nueva Delhi" caem todos em DEL.
//
// A tabela mora em airports-data.ts, num arquivo separado, porque ela é GERADA: o
// update-airports-data.ts sobrescreve aquele arquivo inteiro, e não pode levar embora o código daqui.

import { AEROPORTO, CODIGOS_DA_CIDADE } from "./airports-data.ts";

// ---------- A TABELA À MÃO ----------
// O dado cru acerta a cidade, mas não sabe como brasileiro fala. Esta tabela pequena vem antes dele e
// é curadoria, não correção de bug:
//   - VCP (Viracopos) fica em Campinas no OurAirports, mas quem viaja de São Paulo aceita Viracopos;
//   - "Londres" no dado cru vira LTN, LGW e LHR, e aqui só queremos os dois aeroportos que importam;
//   - como brasileiro escreve não é o que está no Wikidata: lá é "Nova Iorque" e "Nova Deli", e a pessoa
//     escreve "Nova York" e "Nova Délhi". Grafia que falta entra aqui, uma linha por grafia;
//   - "rio", "sp", "bh" não são nome de cidade nenhuma;
//   - apelido de aeroporto (Cumbica, Galeão, Heathrow) nenhuma das duas fontes tem.
const AJUSTES: Record<string, string[]> = {
	"sao paulo": ["GRU", "CGH", "VCP"], "rio de janeiro": ["GIG", "SDU"], "rio": ["GIG", "SDU"], "belo horizonte": ["CNF"], "brasilia": ["BSB"],
	"salvador": ["SSA"], "recife": ["REC"], "fortaleza": ["FOR"], "porto alegre": ["POA"], "curitiba": ["CWB"], "florianopolis": ["FLN"],
	"natal": ["NAT"], "manaus": ["MAO"], "belem": ["BEL"], "goiania": ["GYN"], "maceio": ["MCZ"], "joao pessoa": ["JPA"], "vitoria": ["VIX"],
	"foz do iguacu": ["IGU"], "campo grande": ["CGR"], "cuiaba": ["CGB"],
	"lisboa": ["LIS"], "porto": ["OPO"], "madri": ["MAD"], "madrid": ["MAD"], "barcelona": ["BCN"], "paris": ["CDG", "ORY"], "londres": ["LHR", "LGW"],
	"roma": ["FCO"], "milao": ["MXP"], "amsterda": ["AMS"], "frankfurt": ["FRA"], "berlim": ["BER"], "zurique": ["ZRH"], "dublin": ["DUB"],
	"nova york": ["JFK", "EWR"], "miami": ["MIA"], "orlando": ["MCO"], "boston": ["BOS"], "los angeles": ["LAX"], "san francisco": ["SFO"], "chicago": ["ORD"],
	"washington": ["IAD"], "toronto": ["YYZ"], "cidade do mexico": ["MEX"], "cancun": ["CUN"],
	"buenos aires": ["EZE", "AEP"], "santiago": ["SCL"], "montevideu": ["MVD"], "lima": ["LIM"], "bogota": ["BOG"],
	"toquio": ["HND", "NRT"], "dubai": ["DXB"], "joanesburgo": ["JNB"], "nova delhi": ["DEL"],

	// apelidos e nomes em outras línguas: modelo fraco não sabe que Cumbica é GRU
	"sp": ["GRU", "CGH", "VCP"], "guarulhos": ["GRU"], "cumbica": ["GRU"], "congonhas": ["CGH"], "viracopos": ["VCP"], "campinas": ["VCP"],
	"rj": ["GIG", "SDU"], "galeao": ["GIG"], "tom jobim": ["GIG"], "santos dumont": ["SDU"], "bh": ["CNF"], "confins": ["CNF"],
	"heathrow": ["LHR"], "gatwick": ["LGW"], "charles de gaulle": ["CDG"], "orly": ["ORY"], "barajas": ["MAD"], "fiumicino": ["FCO"],
	"lisbon": ["LIS"], "lisbonne": ["LIS"], "lisbona": ["LIS"], "lissabon": ["LIS"], "london": ["LHR", "LGW"], "rome": ["FCO"], "new york": ["JFK", "EWR"], "tokyo": ["HND", "NRT"],
};

// nome de várias cidades que o dado cru resolve para uma só: "sao jose" ia direto para San Jose (EUA), sem perguntar
const PERGUNTAR: Record<string, string[]> = { "sao jose": ["SJK", "SJP", "SJC", "SJO"] };

// a mesma limpeza que o tools.ts usa nas datas: "São Paulo" e " sao paulo " viram a mesma chave
export function semAcento(texto: string) {
	return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

// ---------- CONSULTAS SIMPLES ----------
// a sigla de 2 letras do país (ISO 3166-1 alfa-2: "BR", "PT", "US"), ou "" se não conheço o aeroporto.
// Aceita entrada suja, porque o código vem de um modelo de IA: " gru " e "Gru" valem GRU.
// Vazio quer dizer "não conheço este aeroporto", e quem chama decide o que fazer com isso.
export function paisDoAeroporto(iata: string): string {
	const regiao = AEROPORTO[String(iata ?? "").trim().toUpperCase()]?.[0];
	return regiao ? regiao.slice(0, 2) : "";
}

const TAMANHOS = ["de tamanho desconhecido", "pequeno", "médio", "grande"];

// "DEL (New Delhi, IN, aeroporto grande)": é isto que o modelo mostra para a pessoa escolher
export function descreverAeroporto(iata: string) {
	const dados = AEROPORTO[iata];
	if (!dados) return iata;
	return `${iata} (${dados[1] || "cidade não cadastrada"}, ${dados[0].slice(0, 2)}, aeroporto ${TAMANHOS[dados[2]]})`;
}

// todos os nomes que levam a estes aeroportos, em qualquer idioma. É com isso que a trava do
// conferirLugar sabe que "saio de Guarulhos" fala do mesmo GRU que "São Paulo".
export function nomesDoAeroporto(codigos: string[]) {
	const serve = (lista: string[]) => lista.some((iata) => codigos.includes(iata));
	const nomes = Object.keys(AJUSTES).filter((nome) => serve(AJUSTES[nome]));
	for (const nome in CODIGOS_DA_CIDADE) if (serve(CODIGOS_DA_CIDADE[nome])) nomes.push(nome);
	return nomes;
}

// ---------- ERRO DE DIGITAÇÃO ----------
// Distância de Levenshtein: quantas letras trocar, tirar ou pôr para uma palavra virar a outra.
// "lisbooa" -> "lisboa" é 1. Guardo só a linha anterior da tabela, que é tudo de que a conta precisa.
export function distancia(a: string, b: string) {
	let linha = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const nova = [i];
		for (let j = 1; j <= b.length; j++) {
			const custo = a[i - 1] === b[j - 1] ? 0 : 1;
			nova[j] = Math.min(linha[j] + 1, nova[j - 1] + 1, linha[j - 1] + custo);
		}
		linha = nova;
	}
	return linha[b.length];
}

// ---------- TRIGRAMAS ----------
// Levenshtein conta letra por letra, então ele não perdoa palavra a mais nem palavra fora de ordem:
// "delhi nova" e "aeroporto internacional de lisboa" ficam longe demais e são descartados. Trigrama
// olha os pedacinhos de 3 letras que os dois textos têm em comum, e aí ordem e palavra extra pesam
// pouco. Em compensação ele é ruim em nome curto (poucos pedaços). Por isso os dois convivem: um
// pega letra trocada, o outro pega texto embaralhado.
function trigramas(texto: string) {
	const cercado = `  ${texto.trim()} `;    // as bordas entram também, senão o começo da palavra não conta
	const pedacos = new Set<string>();
	for (let i = 0; i < cercado.length - 2; i++) pedacos.add(cercado.slice(i, i + 3));
	return pedacos;
}

// 0 = nada em comum, 1 = iguais. É a mesma conta do pg_trgm do Postgres: pedaços em comum dividido
// pelos pedaços de todos.
export function semelhanca(a: string, b: string) {
	const daqui = trigramas(a);
	const dali = trigramas(b);
	let juntos = 0;
	for (const pedaco of daqui) if (dali.has(pedaco)) juntos++;
	return juntos / (daqui.size + dali.size - juntos);
}

// calibrado à mão contra casos de verdade (ver tests.ts): abaixo disso começa a casar cidade errada
const SEMELHANCA_MINIMA = 0.45;

// Os dois passos aproximados procuram nas DUAS tabelas: a curada à mão e a gerada. Sem a curada,
// "delhi nova" não achava "nova delhi" e acabava sugerindo o aeroporto errado de Délhi.
const TODOS_OS_NOMES = [...Object.keys(AJUSTES), ...Object.keys(CODIGOS_DA_CIDADE)];

// todos os aeroportos daquele nome, não só o primeiro: "delhi" tem três, e o primeiro da lista não
// é o maior. Quem ordena por tamanho é o pedirConfirmacao.
function codigosDoNome(nome: string) {
	return AJUSTES[nome] ?? CODIGOS_DA_CIDADE[nome] ?? [];
}

// quanto erro de digitação eu perdoo: 1 letra a cada 4, arredondando para o mais perto. Até 3 letras, nenhum
// ("rio"/"rir" são outra coisa); 4 e 5 letras, 1 erro; 6 a 9, 2; 10 a 13, 3. Em palavra curta, 1 letra trocada já muda a cidade
export function limiteDeErro(palavra: string) {
	return palavra.length <= 3 ? 0 : Math.round(palavra.length / 4);
}

// nome parecido NUNCA vira busca: volta como candidato para o modelo confirmar com a pessoa.
// Aeroporto grande na frente, porque é quase sempre ele que a pessoa quis.
function pedirConfirmacao(texto: string, codigos: string[]): never {
	const ordenados = codigos.toSorted((a, b) => AEROPORTO[b][2] - AEROPORTO[a][2]);
	throw new Error(`não achei "${texto}". Pode ser ${ordenados.map(descreverAeroporto).join(" ou ")}. Pergunte à pessoa qual é antes de pesquisar; não escolha sozinho.`);
}

// ---------- NOME REPETIDO ----------
// Santiago, San José e Springfield existem em vários lugares do mundo. Quem decide se dois aeroportos
// são da mesma cidade é o mapa, e não o nome do município: EWR fica em Newark e VCP fica em Campinas,
// mas os dois são aeroporto de Nova York e de São Paulo. 1,5 grau é uns 165 km, a distância em que
// ainda vale pegar um táxi. Regra: o aeroporto maior ganha; se outro empatar no tamanho e estiver longe,
// é outra cidade com o mesmo nome e não dá para chutar — então pergunta.
function desempatar(texto: string, codigos: string[]) {
	const [, , tamanho, lat, lon] = AEROPORTO[codigos[0]];
	const perto = (iata: string) => Math.abs(AEROPORTO[iata][3] - lat) <= 1.5 && Math.abs(AEROPORTO[iata][4] - lon) <= 1.5;
	const longe = codigos.filter((iata) => !perto(iata) && AEROPORTO[iata][2] === tamanho);
	if (longe.length > 0) pedirConfirmacao(texto, [codigos[0], ...longe]);
	return codigos.filter(perto);
}

// ---------- O RESOLVEDOR ----------
// aceita cidade ou código: "São Paulo" -> GRU, CGH e VCP. O modelo não precisa decorar aeroporto nenhum.
export function resolverAeroportos(texto: string) {
	const limpo = semAcento(texto).replace(/^aeroporto (de |do |da |dos |das )?/, "");

	// 1. código de 3 letras, CONFERIDO na tabela. Antes o código era aceito às cegas, e aí o modelo
	// inventava uma sigla parecida ("MAD" em vez de "MAO") e o bot pesquisava a cidade errada calado.
	const sigla = limpo.toUpperCase();
	if (/^[A-Z]{3}$/.test(sigla) && Object.hasOwn(AEROPORTO, sigla)) return [sigla];

	// 2. nome exato, em qualquer um dos seis idiomas (a tabela à mão vem primeiro: é curadoria).
	// Object.hasOwn e não só a chave: o texto vem do modelo, e "constructor" existe em qualquer objeto.
	if (Object.hasOwn(PERGUNTAR, limpo)) pedirConfirmacao(texto, PERGUNTAR[limpo]);
	if (Object.hasOwn(AJUSTES, limpo)) return AJUSTES[limpo];
	if (Object.hasOwn(CODIGOS_DA_CIDADE, limpo)) return desempatar(texto, CODIGOS_DA_CIDADE[limpo]);

	// 2b. agora sem as palavras de enfeite: "aeroporto internacional de lisboa" -> "lisboa".
	// Só DEPOIS do nome exato falhar, porque existe cidade chamada "International Falls" nos Estados
	// Unidos, e ela precisa continuar resolvendo pelo nome inteiro.
	const alvo = limpo.replace(/\b(aeroporto|internacional|intl|airport|aeropuerto|aeroport|de|do|da)\b/g, " ").replace(/\s+/g, " ").trim() || limpo;
	if (alvo !== limpo) {
		if (Object.hasOwn(AJUSTES, alvo)) return AJUSTES[alvo];
		if (Object.hasOwn(CODIGOS_DA_CIDADE, alvo)) return desempatar(texto, CODIGOS_DA_CIDADE[alvo]);
	}

	// 3. começo do nome: "lond" vira "londres" se uma cidade só começa assim
	if (alvo.length >= 4) {
		const comecam = Object.keys(CODIGOS_DA_CIDADE).filter((nome) => nome.startsWith(alvo));
		const primeiros = [...new Set(comecam.map((nome) => CODIGOS_DA_CIDADE[nome][0]))];
		if (primeiros.length === 1) return desempatar(texto, CODIGOS_DA_CIDADE[comecam[0]]);
		if (primeiros.length > 1) pedirConfirmacao(texto, primeiros.slice(0, 5));
	}

	// 4. erro de digitação: "lisbooa" -> Lisboa. Fico só com os nomes de menor distância.
	const limite = limiteDeErro(alvo);
	let melhor = limite + 1;
	let parecidos: string[] = [];
	for (const nome of TODOS_OS_NOMES) {
		if (Math.abs(nome.length - alvo.length) > limite) continue;    // sem isto a conta roda 7 mil vezes de graça
		const perto = distancia(alvo, nome);
		if (perto > limite || perto > melhor) continue;
		if (perto < melhor) {
			melhor = perto;
			parecidos = [];
		}
		parecidos.push(nome);
	}
	if (parecidos.length > 0) pedirConfirmacao(texto, [...new Set(parecidos.flatMap(codigosDoNome))].slice(0, 5));

	// 5. texto embaralhado ou com palavra a mais: "delhi nova", "aeroporto internacional de lisboa".
	// Só roda quando o passo 4 não achou nada, porque aqui a conta passa pelos 7 mil nomes.
	let maiorSemelhanca = SEMELHANCA_MINIMA;
	let semelhantes: string[] = [];
	for (const nome of TODOS_OS_NOMES) {
		const nota = semelhanca(alvo, nome);
		if (nota < maiorSemelhanca) continue;
		if (nota > maiorSemelhanca) {
			maiorSemelhanca = nota;
			semelhantes = [];
		}
		semelhantes.push(nome);
	}
	if (semelhantes.length > 0) pedirConfirmacao(texto, [...new Set(semelhantes.flatMap(codigosDoNome))].slice(0, 5));

	// 6. nada casou: o erro honesto
	throw new Error(`não conheço "${texto}". Passe o código de 3 letras do aeroporto; se não souber, pergunte. Não chute.`);
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node rules/airports.ts GRU 'Nova Délhi'", não quando outro arquivo importa este
if (import.meta.main) {
	for (const pedido of process.argv.slice(2)) {
		try {
			console.log(pedido, "->", resolverAeroportos(pedido).map(descreverAeroporto).join(" | "));
		} catch (erro: any) {
			console.log(pedido, "->", erro.message);
		}
	}
}
