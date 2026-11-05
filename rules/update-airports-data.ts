// update-airports-data.ts - baixa a lista de aeroportos do mundo e gera airports-data.ts
//
// Roda na mão, de vez em quando, e NÃO durante a conversa com o bot: o CSV do OurAirports tem 12,7 MB
// e o país de um aeroporto não muda de mês para mês. Quem consulta é o airports.ts, que só lê a tabela
// já pronta — assim nenhum nó do grafo depende de internet.
//
// Duas fontes, as duas de graça e sem chave:
//   OurAirports -> código IATA, país, estado, município e tamanho do aeroporto (domínio público)
//   Wikidata    -> o nome da cidade em português, inglês, espanhol, francês, italiano e alemão (CC0)
// É o Wikidata que faz "Nova Délhi" virar DEL e "Londres" virar LHR: o OurAirports só escreve o nome
// da cidade em inglês, e a pessoa escreve em português.
//
// Para rodar (dentro da pasta passagens.ts/):   node rules/update-airports-data.ts

import { writeFileSync } from "node:fs";

const FONTE = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const WIKIDATA = "https://query.wikidata.org/sparql";
const DESTINO = new URL("./airports-data.ts", import.meta.url);

// P238 é o código IATA e P931 é "lugar servido por este aeroporto".
// Não use P131 ("fica dentro de"): ela devolve o distrito, e aí Heathrow vira "Hillingdon".
const CONSULTA = `SELECT ?iata ?nome WHERE {
	?a wdt:P238 ?iata ; wdt:P931 ?l .
	?l rdfs:label ?nome .
	FILTER(lang(?nome) IN ("pt","en","es","fr","it","de"))
}`;

// ---------- LER O CSV ----------
// Não dá para usar split(","): o CSV tem campos entre aspas com vírgula dentro, como
// "Rio de Janeiro, Galeão". Então lemos letra por letra e só tratamos a vírgula como separador
// quando estamos FORA das aspas. Duas aspas seguidas dentro de um campo ("") são uma aspa de verdade.
export function lerCsv(texto: string): string[][] {
	const linhas: string[][] = [];
	let campos: string[] = [];
	let campo = "";
	let dentroDeAspas = false;

	for (let i = 0; i < texto.length; i++) {
		const letra = texto[i];

		if (dentroDeAspas) {
			if (letra === '"' && texto[i + 1] === '"') {
				campo += '"';
				i++;    // pula a segunda aspa do par
			} else if (letra === '"') {
				dentroDeAspas = false;
			} else {
				campo += letra;
			}
			continue;
		}

		if (letra === '"') {
			dentroDeAspas = true;
		} else if (letra === ",") {
			campos.push(campo);
			campo = "";
		} else if (letra === "\n") {
			campos.push(campo.replace(/\r$/, ""));    // arquivo feito no Windows termina a linha com \r\n
			linhas.push(campos);
			campos = [];
			campo = "";
		} else {
			campo += letra;
		}
	}

	// a última linha do arquivo pode não ter \n no fim
	if (campo !== "" || campos.length > 0) {
		campos.push(campo);
		linhas.push(campos);
	}
	return linhas;
}

// ---------- ESCOLHER OS AEROPORTOS ----------
// o mesmo código IATA aparece em mais de um aeroporto do CSV (erro de cadastro, ou um heliporto
// que herdou a sigla da cidade). Regra: fica o aeroporto mais graúdo; empate, fica o primeiro do arquivo.
const TAMANHO: Record<string, number> = { large_airport: 3, medium_airport: 2, small_airport: 1 };

export type Aeroporto = { regiao: string; cidade: string; tamanho: number; lat: number; lon: number };

export function escolherAeroportos(csv: string) {
	const linhas = lerCsv(csv);
	const cabecalho = linhas[0];
	const coluna = (nome: string) => {
		const onde = cabecalho.indexOf(nome);
		if (onde === -1) throw new Error(`o CSV do OurAirports veio sem a coluna "${nome}" (o formato dele mudou)`);
		return onde;
	};
	const iIata = coluna("iata_code");
	const iPais = coluna("iso_country");
	const iRegiao = coluna("iso_region");
	const iCidade = coluna("municipality");
	const iTipo = coluna("type");
	const iRegular = coluna("scheduled_service");
	const iLat = coluna("latitude_deg");
	const iLon = coluna("longitude_deg");

	// a ordem do arquivo é o desempate final, então guardo num Map (que mantém a ordem de inserção)
	const aeroportos = new Map<string, Aeroporto>();

	for (const linha of linhas.slice(1)) {
		const iata = linha[iIata]?.trim().toUpperCase() ?? "";
		const pais = linha[iPais]?.trim().toUpperCase() ?? "";
		const regiao = linha[iRegiao]?.trim().toUpperCase() ?? "";

		if (!/^[A-Z]{3}$/.test(iata)) continue;                 // pista sem código IATA não serve para buscar voo
		if (!/^[A-Z]{2}$/.test(pais)) continue;                 // iso_country é ISO 3166-1 alfa-2: "BR", "PT", "US"
		if (!regiao.startsWith(pais + "-")) continue;           // iso_region é "BR-SP", "US-MO": guardo ela e tiro o país dela
		if (linha[iRegular]?.trim() !== "yes") continue;        // só onde passa voo comercial de linha

		const lat = Number(linha[iLat]);
		const lon = Number(linha[iLon]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;    // sem coordenada não dá para saber se dois aeroportos são da mesma cidade

		const tamanho = TAMANHO[linha[iTipo]?.trim() ?? ""] ?? 0;
		const antigo = aeroportos.get(iata);
		if (antigo && tamanho <= antigo.tamanho) continue;
		// 2 casas decimais é um quilômetro, de sobra para saber se dois aeroportos servem a mesma cidade
		aeroportos.set(iata, { regiao, cidade: linha[iCidade]?.trim() ?? "", tamanho, lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
	}
	return aeroportos;
}

// ---------- BAIXAR OS NOMES DE CIDADE ----------
async function perguntarAoWikidata(consulta: string) {
	const resposta = await fetch(WIKIDATA + "?query=" + encodeURIComponent(consulta), {
		headers: { Accept: "application/sparql-results+json", "User-Agent": "takifly/1.0" },
		signal: AbortSignal.timeout(180_000),    // a consulta inteira leva uns 60 s; o Wikidata corta sozinho em 60 s de CPU
	});
	if (!resposta.ok) throw new Error(`o Wikidata respondeu com erro ${resposta.status}`);
	const json = await resposta.json();
	return json.results.bindings as { iata: { value: string }; nome: { value: string } }[];
}

// de uma vez só; se o servidor estourar o tempo, pede em pedaços de 10 mil linhas.
// shortcut: LIMIT/OFFSET sem ORDER BY pode repetir ou pular linha se o Wikidata mudar o plano no meio;
// para montar um dicionário isso é aceitável (repetido some no Set), e o caminho normal é o de uma vez só.
export async function baixarNomes() {
	try {
		return await perguntarAoWikidata(CONSULTA);
	} catch (erro) {
		console.log(`a consulta inteira falhou (${(erro as Error).message}); tentando em pedaços...`);
	}

	const tudo: { iata: { value: string }; nome: { value: string } }[] = [];
	for (let pulo = 0; ; pulo += 10_000) {
		const pedaco = await perguntarAoWikidata(`${CONSULTA} LIMIT 10000 OFFSET ${pulo}`);
		tudo.push(...pedaco);
		console.log(`  ${tudo.length} nomes...`);
		if (pedaco.length < 10_000) return tudo;
	}
}

// ---------- JUNTAR AS DUAS FONTES ----------
// O P931 traz lixo junto: BKK vem com "Banguecoque", mas também com "Região metropolitana de Banguecoque"
// e "Província de Samut Prakan". O corte é só contra nome de DIVISÃO ADMINISTRATIVA (região, província,
// condado...), e não contra cidade vizinha: "Samut Prakan" e "Guarulhos" ficam, porque voar para BKK e
// para GRU é de verdade como se chega nesses dois lugares.
const DIVISAO = /\b(regi|provinc|distrit|district|departement|département|departamento|condado|county|metropol|municip|governorate|prefecture|préfecture|oblast|kreis|bezirk)/i;

export function semAcento(texto: string) {
	return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

// quantos códigos no máximo por nome de cidade: o bot só pode fazer 12 buscas no Google por pedido,
// então "New York" não pode virar seis buscas (e três delas num heliporto).
const MAXIMO_POR_CIDADE = 3;

export function montarCidades(aeroportos: Map<string, Aeroporto>, nomes: { iata: { value: string }; nome: { value: string } }[]) {
	const porCidade = new Map<string, string[]>();
	const guardar = (nome: string, iata: string) => {
		const chave = semAcento(nome);
		if (!/^[a-z]/.test(chave)) return;    // nome que começa com número ou símbolo não é cidade
		const lista = porCidade.get(chave) ?? [];
		if (!lista.includes(iata)) lista.push(iata);
		porCidade.set(chave, lista);
	};

	// primeiro o município do OurAirports, depois os nomes do Wikidata
	for (const [iata, dados] of aeroportos) if (dados.cidade) guardar(dados.cidade, iata);
	for (const linha of nomes) {
		const iata = linha.iata.value.trim().toUpperCase();
		if (aeroportos.has(iata) && !DIVISAO.test(linha.nome.value)) guardar(linha.nome.value, iata);
	}

	// a ordem dos códigos de cada nome é quem o bot pesquisa primeiro: aeroporto maior na frente,
	// e empate fica na ordem do CSV (que é estável, então o arquivo gerado não muda de graça)
	const ordem = new Map([...aeroportos.keys()].map((iata, onde) => [iata, onde]));
	const cidades: Record<string, string[]> = {};
	for (const [chave, lista] of porCidade) {
		lista.sort((a, b) => aeroportos.get(b)!.tamanho - aeroportos.get(a)!.tamanho || ordem.get(a)! - ordem.get(b)!);
		cidades[chave] = lista.slice(0, MAXIMO_POR_CIDADE);
	}
	return cidades;
}

// ---------- GRAVAR ----------
export function escreverArquivo(aeroportos: Map<string, Aeroporto>, cidades: Record<string, string[]>) {
	const siglas = [...aeroportos.keys()].sort();
	const chaves = Object.keys(cidades).sort();
	const aspas = (texto: string) => JSON.stringify(texto);    // escapa aspas e acento de nome como "Val-d'Or"

	const texto = [
		"// airports-data.ts - ARQUIVO GERADO. Não edite na mão: rode node rules/update-airports-data.ts.",
		"//",
		"// Fontes: OurAirports (domínio público) e Wikidata (CC0)",
		`// Extraído em: ${new Date().toISOString().slice(0, 10)}`,
		"// Filtro: código IATA de 3 letras + scheduled_service=yes (voo comercial de linha)",
		`// Aeroportos: ${siglas.length}   Nomes de cidade: ${chaves.length}`,
		"",
		"// cada aeroporto: a região (ISO 3166-2, tipo \"BR-SP\" — o país são as duas primeiras letras),",
		"// o nome da cidade em inglês, o tamanho (3 grande, 2 médio, 1 pequeno) e onde ele fica no mapa",
		"export const AEROPORTO: Record<string, [regiao: string, cidade: string, tamanho: number, lat: number, lon: number]> = {",
		...siglas.map((iata) => {
			const dados = aeroportos.get(iata)!;
			return `\t${iata}: ["${dados.regiao}", ${aspas(dados.cidade)}, ${dados.tamanho}, ${dados.lat}, ${dados.lon}],`;
		}),
		"};",
		"",
		"// nome da cidade sem acento e em minúsculo -> códigos, do aeroporto maior para o menor.",
		"// O mesmo aeroporto aparece em várias linhas (um nome por idioma), e é isso que faz",
		"// \"Nova Deli\", \"New Delhi\" e \"Nueva Delhi\" caírem todos em DEL.",
		"export const CODIGOS_DA_CIDADE: Record<string, string[]> = {",
		...chaves.map((chave) => `\t${aspas(chave)}: [${cidades[chave].map((iata) => `"${iata}"`).join(", ")}],`),
		"};",
		"",
	].join("\n");

	writeFileSync(DESTINO, texto);
	return { aeroportos: siglas.length, cidades: chaves.length, bytes: Buffer.byteLength(texto) };
}

// ---------- RODAR ----------
// Nada é gravado antes das DUAS fontes chegarem inteiras: meio arquivo é pior que arquivo velho.
if (import.meta.main) {
	console.log("baixando " + FONTE + " (uns 12 MB, pode demorar)...");
	const resposta = await fetch(FONTE);
	if (!resposta.ok) throw new Error("o OurAirports respondeu com erro " + resposta.status);
	const aeroportos = escolherAeroportos(await resposta.text());

	console.log("perguntando os nomes de cidade ao Wikidata (uns 60 s)...");
	const nomes = await baixarNomes();

	const cidades = montarCidades(aeroportos, nomes);
	const conta = escreverArquivo(aeroportos, cidades);
	console.log(`${conta.aeroportos} aeroportos e ${conta.cidades} nomes de cidade gravados em airports-data.ts (${Math.round(conta.bytes / 1024)} KB)`);
}
