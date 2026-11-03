// atualizar-tabelas.ts - baixa as tabelas de visto e de febre amarela e grava harness/tabelas-viagem.ts
//
// Por que um script e não um fetch dentro da regra: conferirViagem roda dentro de um nó do grafo, é
// síncrono e não pode depender de internet. Então o dado vira arquivo, e o arquivo vai para o git.
//
// Para rodar (dentro da pasta passagens.ts/):   node harness/atualizar-tabelas.ts
//
// As duas fontes são da Wikipedia em inglês, que é CC BY-SA 4.0: por isso o arquivo gerado cita a
// página e o número da revisão de onde cada tabela saiu.

import { writeFileSync } from "node:fs";

const PAGINA_DO_VISTO = "Visa_requirements_for_Brazilian_citizens";
const PAGINA_DA_FEBRE_AMARELA = "Yellow_fever_vaccine";    // a tabela dessa página é a cópia do anexo da OMS, e cita o PDF da OMS

// ---------- BAIXAR ----------
// a API da Wikipedia devolve o texto-fonte da página (wikitexto) e o número da revisão que leu
async function baixarWikitexto(pagina: string) {
	const endereco = `https://en.wikipedia.org/w/api.php?action=parse&page=${pagina}&prop=wikitext|revid&format=json`;
	const resposta = await fetch(endereco, { headers: { "User-Agent": "passagens-bot/1.0" }, signal: AbortSignal.timeout(60_000) });
	if (!resposta.ok) throw new Error(`a Wikipedia respondeu com erro ${resposta.status} para a página ${pagina}`);
	const corpo = await resposta.json();
	const texto = corpo?.parse?.wikitext?.["*"];
	if (typeof texto !== "string" || texto.length < 10_000) throw new Error(`a página ${pagina} veio vazia ou muito curta`);
	return { texto, revisao: String(corpo.parse.revid), pagina };
}

// ---------- LER A TABELA ----------
// uma tabela de wikitexto separa as linhas com "|-" e as células com "|" no começo da linha. Só que
// dentro de uma célula também aparecem "|" (em {{flag|Japan}}, em <ref>...</ref>), e às vezes a célula
// ocupa várias linhas. Então o corte só vale quando não estamos dentro de nenhuma chave nem de nenhum ref.
function cortarCelulas(linha: string) {
	const celulas: string[] = [];
	let atual = "";
	let chaves = 0;
	let dentroDeRef = 0;
	for (let i = 0; i < linha.length; i++) {
		if (linha.startsWith("{{", i) || linha.startsWith("[[", i)) chaves++;
		if (linha.startsWith("}}", i) || linha.startsWith("]]", i)) chaves--;
		if (linha.startsWith("<ref", i) && !linha.startsWith("<ref", i + 4)) dentroDeRef++;
		if (linha.startsWith("</ref>", i) || linha.startsWith("/>", i)) dentroDeRef = Math.max(0, dentroDeRef - 1);
		// começo de célula: "|" depois de uma quebra de linha, fora de chaves e de ref
		if (linha[i] === "|" && (i === 0 || linha[i - 1] === "\n") && chaves <= 0 && dentroDeRef === 0) {
			celulas.push(atual);
			atual = "";
			continue;
		}
		atual += linha[i];
	}
	celulas.push(atual);
	return celulas.slice(1).map((celula) => celula.trim());    // a primeira fatia é o que vem antes da primeira célula
}

// pega o trecho da página entre dois marcos e devolve uma lista de células por linha da tabela
function lerTabela(texto: string, marcoDoComeco: string, marcoDoFim: string) {
	const comeco = texto.indexOf(marcoDoComeco);
	const fim = texto.indexOf(marcoDoFim, comeco);
	if (comeco === -1 || fim === -1) throw new Error(`não achei a tabela na página (procurei por "${marcoDoComeco}")`);
	return texto.slice(comeco, fim).split("\n|-").slice(1).map(cortarCelulas);
}

// tira <ref>, {{refn}} e links para sobrar só o texto que interessa
function semEnfeite(celula: string) {
	return celula
		.replace(/<ref[^>]*\/>/g, "")
		.replace(/<ref.*?<\/ref>/gs, "")
		.replace(/\{\{refn.*$/s, "")
		.replace(/\{\{rp\|[^}]*\}\}/g, "")
		.replace(/\{\{sort\|[^|}]*\|([^}]*)\}\}/g, "$1")
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.trim();
}

// o nome do país vem em {{flag|Japan}} ou {{flag|People's Republic of China|name=China}}
function nomeDoPais(celula: string) {
	const achado = /\{\{flag(?:icon)?\|([^}|]+)(?:\|name=([^}|]+))?[^}]*\}\}/.exec(celula);
	if (!achado) return "";
	return (achado[2] ?? achado[1]).trim();
}

// ---------- NOME DO PAÍS -> CÓDIGO ISO -> NOME EM PORTUGUÊS ----------
// o Node já tem a lista de países dentro dele (é o que o navegador usa para traduzir nome de país), então
// não precisamos de tabela de tradução nem de dependência nova: varremos AA..ZZ e perguntamos o nome.
// Quando o código não existe, o Intl devolve o próprio código de volta - é assim que a gente descarta.
const emPortugues = new Intl.DisplayNames(["pt-BR"], { type: "region" });
const emIngles = new Intl.DisplayNames(["en"], { type: "region" });

// o Intl escreve "St. Kitts & Nevis" e "Côte d’Ivoire"; a Wikipedia escreve "Saint Kitts and Nevis"
// e "Côte d'Ivoire". Esta função deixa os dois do mesmo jeito antes de comparar.
function achatar(nome: string) {
	return nome.toLowerCase()
		.replace(/’/g, "'")
		.replace(/&/g, "and")
		.replace(/\bst\. /g, "saint ")
		.replace(/\bthe /g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const CODIGO_DO_NOME = new Map<string, string>();
for (let a = 65; a <= 90; a++) {
	for (let b = 65; b <= 90; b++) {
		const codigo = String.fromCharCode(a, b);
		const nome = emIngles.of(codigo);
		if (nome && nome !== codigo) CODIGO_DO_NOME.set(achatar(nome), codigo);
	}
}

// nomes que a Wikipedia escreve de um jeito e o Intl de outro. Lista curta e explícita de propósito:
// país que não casa fica de fora da tabela, e ficar de fora virou "confirme no consulado", nunca um chute.
const APELIDOS: Record<string, string> = {
	"cabo verde": "CV", "congo-brazzaville": "CG", "congo-kinshasa": "CD", "dr congo": "CD",
	"ivory coast": "CI", "east timor": "TL", "eswatini": "SZ", "gambia": "GM",
	"são tomé and príncipe": "ST", "sao tome and principe": "ST", "vatican city": "VA",
	"north macedonia": "MK", "myanmar": "MM", "burma": "MM", "palestine": "PS", "kosovo": "XK",
	"czech republic": "CZ", "netherlands": "NL", "bolivia": "BO", "bolívia": "BO", "russia": "RU",
	"syria": "SY", "turkey": "TR", "türkiye": "TR", "united states": "US", "ghana": "GH", "south korea": "KR",
	"micronesia": "FM", "federated states of micronesia": "FM", "trinidad & tobago": "TT",
	// dependências e territórios: o código próprio deles é o que o aeroportos.ts devolve
	"hong kong": "HK", "macau": "MO", "saint helena": "SH", "ascension island": "AC",
	"bonaire": "BQ", "sint eustatius": "BQ", "saba": "BQ", "sint maarten": "SX", "saint martin": "MF",
	"curaçao": "CW", "u.s. virgin islands": "VI", "british virgin islands": "VG",
	"french guiana": "GF", "guadeloupe": "GP", "martinique": "MQ", "réunion": "RE", "mayotte": "YT",
	"saint pierre and miquelon": "PM", "saint barthélemy": "BL", "wallis and futuna": "WF",
	"svalbard": "SJ", "pitcairn islands": "PN", "falkland islands": "FK", "turks and caicos islands": "TC",
	"cayman islands": "KY", "northern mariana islands": "MP", "puerto rico": "PR", "guam": "GU",
	"american samoa": "AS", "taiwan": "TW", "greenland": "GL", "faroe islands": "FO",
	"south georgia and south sandwich islands": "GS", "saint vincent and grenadines": "VC",
};

function codigoDoPais(nome: string) {
	const chave = achatar(nome);
	return APELIDOS[chave] ?? CODIGO_DO_NOME.get(chave) ?? "";
}

// ---------- TABELA DE VISTO ----------
// quatro exigências, na ordem em que a regra se preocupa com elas:
//   isento     = entra só com o passaporte (a nota diz quando ainda precisa de uma autorização eletrônica)
//   na-chegada = resolve no balcão da fronteira
//   evisa      = pede pela internet, mas precisa estar na mão antes de embarcar
//   antes      = visto no consulado antes de viajar
function classificarExigencia(bruto: string): { exige: string; nota?: string } {
	const texto = bruto.toLowerCase();
	if (texto.includes("freedom of movement")) return { exige: "isento" };
	if (texto.includes("visa not required")) return { exige: "isento" };
	if (texto.includes("on arrival") || texto.includes("voa")) return { exige: "na-chegada" };    // VOA = visa on arrival
	if (texto.includes("electronic travel auth")) return { exige: "isento", nota: "pede a autorização eletrônica (ETA) antes de embarcar, mesmo sem visto" };
	if (texto.includes("evisa") || texto.includes("e-visa") || texto.includes("online visa")) return { exige: "evisa" };
	if (texto.includes("visa required")) return { exige: "antes" };
	// território que pede autorização em vez de visto: para quem viaja é a mesma coisa, resolve antes de ir
	if (texto.includes("permit required") || texto.includes("permission required") || texto.includes("clearance")) return { exige: "antes" };
	return { exige: "" };    // formato novo: quem chama avisa e deixa o país de fora
}

// "90 days", "3 months", "6 weeks", "1 year", "14 days / 30 days" (fica com o primeiro)
const DIAS_DA_UNIDADE: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };

function diasPermitidos(celula: string) {
	const achado = /(\d+)\s*(day|days|week|weeks|month|months|year|years)\b/.exec(semEnfeite(celula));
	if (!achado) return undefined;
	return Number(achado[1]) * DIAS_DA_UNIDADE[achado[2]];
}

// A página tem três tabelas com o mesmo desenho (país | exigência | tempo ou notas): os países, os
// territórios reconhecidos pela metade e as dependências. As dependências importam porque o aeroportos.ts
// usa o código do território: Caiena é "GF" e San Juan é "PR", não "FR" e "US".
function montarVisto(fonte: { texto: string; revisao: string; pagina: string }) {
	const linhas = [
		...lerTabela(fonte.texto, '! style="width:18%;"| Country', "==Dependent, disputed"),
		...lerTabela(fonte.texto, '! style="width:18%;"| Territory', "===Dependent and autonomous territories==="),
		...lerTabela(fonte.texto, '! colspan="2" style="width:18%;"| Territory', "===Other territories==="),
	];
	const paises: Record<string, { nome: string; exige: string; dias?: number; nota?: string }> = {};
	const sobraram: string[] = [];

	for (const celulas of linhas) {
		if (celulas.length < 3) continue;
		const nome = nomeDoPais(celulas[0]);
		// o código ISO vem do próprio ref da linha ({{Timatic|...|destination=US}}); quando falta, pelo nome
		const codigo = /destination=([A-Z]{2})\b/.exec(celulas[1])?.[1] ?? codigoDoPais(nome);
		const { exige, nota } = classificarExigencia(semEnfeite(celulas[1]));
		if (!codigo || !exige) {
			sobraram.push(`${nome || celulas[0].slice(0, 40)} (${codigo || "sem código"}, ${semEnfeite(celulas[1]).slice(0, 40) || "sem exigência"})`);
			continue;
		}
		paises[codigo] = { nome: emPortugues.of(codigo) ?? nome, exige, dias: exige === "isento" ? diasPermitidos(celulas[2]) : undefined, nota };
	}
	return { paises, sobraram, linhas: linhas.length };
}

// ---------- TABELA DE FEBRE AMARELA ----------
// A tabela da Wikipedia é a cópia do anexo da OMS (janeiro de 2023) e tem três situações na coluna
// "vacinação exigida de quem vem de": "All countries", "Risk countries" e "No".
// O Brasil é país de risco na lista da OMS, então quem sai do Brasil cai nos dois primeiros casos.
// Por isso a nossa tabela é só a lista de quem exige - é exatamente o que a regra precisa saber.
function montarFebreAmarela(fonte: { texto: string; revisao: string; pagina: string }) {
	const linhas = lerTabela(fonte.texto, "Yellow fever vaccination requirements for international travel", "\n|}");
	const paises: Record<string, string> = {};
	const sobraram: string[] = [];

	for (const celulas of linhas) {
		if (celulas.length < 3) continue;
		const nome = nomeDoPais(celulas[0]);
		const exigencia = semEnfeite(celulas[2]).toLowerCase();
		const exige = exigencia.includes("all countries") || exigencia.includes("risk countries");
		if (!exige) continue;
		const codigo = codigoDoPais(nome);
		if (!codigo) {
			sobraram.push(nome || celulas[0].slice(0, 40));
			continue;
		}
		paises[codigo] = emPortugues.of(codigo) ?? nome;
	}
	return { paises, sobraram, linhas: linhas.length };
}

// ---------- GRAVAR ----------
function comoTexto(valor: unknown) {
	return JSON.stringify(valor);
}

function linhasDoVisto(paises: Record<string, { nome: string; exige: string; dias?: number; nota?: string }>) {
	return Object.keys(paises).sort().map((codigo) => {
		const pais = paises[codigo];
		const pedacos = [`nome: ${comoTexto(pais.nome)}`, `exige: ${comoTexto(pais.exige)}`];
		if (pais.dias !== undefined) pedacos.push(`dias: ${pais.dias}`);
		if (pais.nota) pedacos.push(`nota: ${comoTexto(pais.nota)}`);
		return `\t\t${codigo}: { ${pedacos.join(", ")} },`;
	}).join("\n");
}

function linhasDaFebreAmarela(paises: Record<string, string>) {
	return Object.keys(paises).sort().map((codigo) => `\t\t${codigo}: ${comoTexto(paises[codigo])},`).join("\n");
}

const hoje = new Date().toJSON().slice(0, 10);
const fonteDoVisto = await baixarWikitexto(PAGINA_DO_VISTO);
const fonteDaVacina = await baixarWikitexto(PAGINA_DA_FEBRE_AMARELA);
const visto = montarVisto(fonteDoVisto);
const vacina = montarFebreAmarela(fonteDaVacina);

// se a página mudar de formato, é melhor parar aqui do que gravar uma tabela pela metade
if (Object.keys(visto.paises).length < 150) throw new Error(`a tabela de visto saiu com só ${Object.keys(visto.paises).length} países: a página deve ter mudado de formato`);
if (Object.keys(vacina.paises).length < 80) throw new Error(`a tabela de febre amarela saiu com só ${Object.keys(vacina.paises).length} países: a página deve ter mudado de formato`);

const enderecoDoVisto = `https://en.wikipedia.org/wiki/Special:PermanentLink/${fonteDoVisto.revisao}`;
const enderecoDaVacina = `https://en.wikipedia.org/wiki/Special:PermanentLink/${fonteDaVacina.revisao}`;

const arquivo = `// tabelas-viagem.ts - ARQUIVO GERADO. Não edite à mão: rode "node harness/atualizar-tabelas.ts".
//
// Extraído em ${hoje} de duas páginas da Wikipedia em inglês, licença CC BY-SA 4.0:
//
//   visto          "${PAGINA_DO_VISTO.replaceAll("_", " ")}", revisão ${fonteDoVisto.revisao}
//                  ${enderecoDoVisto}
//   febre amarela  "${PAGINA_DA_FEBRE_AMARELA.replaceAll("_", " ")}", revisão ${fonteDaVacina.revisao}
//                  ${enderecoDaVacina}
//                  (a tabela dessa página é a cópia do anexo da OMS "Countries with risk of yellow fever
//                  transmission and countries requiring yellow fever vaccination", de janeiro de 2023)
//
// O nome de cada país em português vem do próprio Node (Intl.DisplayNames), não da Wikipedia.

// o que um passaporte brasileiro precisa em cada país, pelo código ISO de 2 letras.
//   isento      entra só com o passaporte; "dias" é o tempo que pode ficar
//   na-chegada  o visto se resolve no balcão da fronteira
//   evisa       pede pela internet, mas precisa estar na mão antes de embarcar
//   antes       visto no consulado antes de viajar
export const VISTO: {
	fonte: string;
	conferido_em: string;
	paises: Record<string, { nome: string; exige: "isento" | "na-chegada" | "evisa" | "antes"; dias?: number; nota?: string }>;
} = {
	fonte: ${comoTexto(`Wikipedia, "${PAGINA_DO_VISTO.replaceAll("_", " ")}", revisão ${fonteDoVisto.revisao} (CC BY-SA 4.0) - ${enderecoDoVisto}`)},
	conferido_em: ${comoTexto(hoje)},
	paises: {
${linhasDoVisto(visto.paises)}
	},
};

// países que exigem o certificado de febre amarela de quem chega do Brasil.
// O Brasil é país de risco na lista da OMS, então entra aqui tanto quem exige de todo mundo
// quanto quem exige só de quem vem de país de risco.
export const FEBRE_AMARELA: {
	fonte: string;
	publicado_em: string;
	conferido_em: string;
	paises: Record<string, string>;
} = {
	fonte: ${comoTexto(`OMS "Countries with risk of yellow fever transmission and countries requiring yellow fever vaccination" (janeiro de 2023), pela Wikipedia, "${PAGINA_DA_FEBRE_AMARELA.replaceAll("_", " ")}", revisão ${fonteDaVacina.revisao} (CC BY-SA 4.0) - ${enderecoDaVacina}`)},
	publicado_em: "janeiro de 2023",
	conferido_em: ${comoTexto(hoje)},
	paises: {
${linhasDaFebreAmarela(vacina.paises)}
	},
};
`;

const destino = new URL("./tabelas-viagem.ts", import.meta.url);
writeFileSync(destino, arquivo);

console.log(`visto:          ${Object.keys(visto.paises).length} países de ${visto.linhas} linhas (revisão ${fonteDoVisto.revisao})`);
if (visto.sobraram.length) console.log("  ficaram de fora: " + visto.sobraram.join(" | "));
console.log(`febre amarela:  ${Object.keys(vacina.paises).length} países de ${vacina.linhas} linhas (revisão ${fonteDaVacina.revisao})`);
if (vacina.sobraram.length) console.log("  ficaram de fora: " + vacina.sobraram.join(" | "));
console.log("gravei harness/tabelas-viagem.ts");
