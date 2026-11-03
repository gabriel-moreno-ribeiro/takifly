// documento.ts - transforma um roteiro em um PDF de verdade, sem nenhuma biblioteca nova
//
// A IDEIA MAIS IMPORTANTE DESTE ARQUIVO: quem decide que o documento tem 12 páginas é o CÓDIGO,
// não o modelo. Uma seção = uma página (o CSS quebra a página antes de cada título). Então o
// modelo nunca escreve "15 páginas": ele escreve 12 textos curtos, um por seção, e o código
// empilha. É assim que um modelo barato entrega um documento que parece de modelo caro.
//
// E tem uma segunda divisão, que é a mesma do resto do projeto:
//   corpo  -> texto do modelo (ele explica, compara, recomenda)
//   tabela -> dados nossos, montados por código (preço, horário, nota: nunca passam pelo modelo)
//
// A impressora é o Google Chrome que já está instalado, no modo sem janela. Nada de puppeteer.
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node harness/documento.ts

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const executar = promisify(execFile);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------- O FORMATO ----------
// uma seção é uma página do documento
export type Secao = {
	titulo: string;                                            // vai como título da página
	corpo: string;                                             // o texto do modelo, em markdown simples
	tabela?: { cabecalho: string[]; linhas: string[][] };      // opcional: os dados exatos, montados por nós
};

export type Roteiro = {
	titulo: string;        // na capa, ex "Lisboa e Porto, 12 a 20 de dezembro"
	subtitulo: string;     // na capa, ex "2 adultos · 8 noites · a partir de R$ 11.240"
	secoes: Secao[];
};

// ---------- TEXTO DO MODELO -> HTML ----------
// Todo texto do modelo é escapado primeiro: se ele escrever "<script>", sai a palavra "<script>"
// no papel, e não um script rodando dentro do Chrome na hora de imprimir.
function escapar(texto: string) {
	return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// o markdown que a gente aceita do modelo é bem pequeno de propósito: negrito, lista e parágrafo.
// Menos formatação possível = menos jeito de o modelo estragar a página.
function markdownSimples(corpo: string) {
	const blocos: string[] = [];

	// um "parágrafo" é um pedaço separado por linha em branco
	for (const bruto of escapar(corpo.trim()).split(/\n\s*\n/)) {
		const linhas = bruto.split("\n").map((linha) => linha.trim()).filter(Boolean);
		if (linhas.length === 0) continue;

		const negrito = (texto: string) => texto.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<strong>$1</strong>");

		// se todas as linhas começam com "- ", o bloco é uma lista
		if (linhas.every((linha) => linha.startsWith("- "))) {
			const itens = linhas.map((linha) => `<li>${negrito(linha.slice(2))}</li>`).join("");
			blocos.push(`<ul>${itens}</ul>`);
		} else {
			blocos.push(`<p>${negrito(linhas.join(" "))}</p>`);
		}
	}

	return blocos.join("\n");
}

// ---------- DADOS NOSSOS -> HTML ----------
// a tabela também é escapada, mas por outro motivo: nome de hotel com "&" quebraria o HTML
function tabelaEmHtml(tabela: { cabecalho: string[]; linhas: string[][] }) {
	const cabecalho = tabela.cabecalho.map((celula) => `<th>${escapar(celula)}</th>`).join("");
	const linhas = tabela.linhas
		.map((linha) => `<tr>${linha.map((celula) => `<td>${escapar(celula)}</td>`).join("")}</tr>`)
		.join("\n");
	return `<table><thead><tr>${cabecalho}</tr></thead><tbody>\n${linhas}\n</tbody></table>`;
}

// ---------- O PAPEL ----------
// "page-break-before: always" é a linha que faz a contagem de páginas ser nossa, e não do modelo
const ESTILO = `
@page { size: A4; margin: 22mm 18mm; }
body { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.55; color: #1a1a1a; margin: 0; }
h1.capa { font-size: 30pt; line-height: 1.2; margin: 55mm 0 6mm; }
p.capa { font-size: 13pt; color: #555; margin: 0; }
section { page-break-before: always; }
h2 { font-size: 17pt; border-bottom: 1.5px solid #1a1a1a; padding-bottom: 4px; margin: 0 0 12px; }
p, li { text-align: justify; }
ul { padding-left: 18px; }
li { margin-bottom: 5px; }
table { border-collapse: collapse; width: 100%; font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; margin-top: 14px; }
th, td { border: 1px solid #c8c8c8; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
`;

// monta o HTML inteiro do documento: capa + uma <section> por seção
export function montarHtml(roteiro: Roteiro) {
	const paginas = roteiro.secoes
		.map((secao) => {
			const tabela = secao.tabela ? tabelaEmHtml(secao.tabela) : "";
			return `<section>\n<h2>${escapar(secao.titulo)}</h2>\n${markdownSimples(secao.corpo)}\n${tabela}\n</section>`;
		})
		.join("\n\n");

	return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>${escapar(roteiro.titulo)}</title><style>${ESTILO}</style></head>
<body>
<h1 class="capa">${escapar(roteiro.titulo)}</h1>
<p class="capa">${escapar(roteiro.subtitulo)}</p>

${paginas}
</body>
</html>`;
}

// ---------- A IMPRESSORA ----------
// quantas páginas saíram de verdade. Dentro de um PDF, cada página é um objeto "/Type /Page"
// (com "/Pages" no plural sendo o índice, por isso o "(?!s)" para não contar ele).
export function contarPaginas(pdf: Buffer) {
	return (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

// gera os dois arquivos e devolve quantas páginas ficaram. O .html fica no disco de propósito:
// é mais rápido abrir ele no navegador para ajustar o estilo do que reimprimir o PDF toda vez.
export async function gerarPdf(roteiro: Roteiro, caminhoDoPdf: string) {
	const caminhoDoHtml = caminhoDoPdf.replace(/\.pdf$/, "") + ".html";
	await writeFile(caminhoDoHtml, montarHtml(roteiro), "utf8");

	// --virtual-time-budget dá um tempinho para o Chrome montar a página antes de imprimir
	await executar(CHROME, [
		"--headless",
		"--disable-gpu",
		"--no-pdf-header-footer",
		"--virtual-time-budget=3000",
		`--print-to-pdf=${caminhoDoPdf}`,
		`file://${caminhoDoHtml}`,
	]);

	const paginas = contarPaginas(await readFile(caminhoDoPdf));
	return { pdf: caminhoDoPdf, html: caminhoDoHtml, paginas };
}

// ---------- A PROVA ----------
// roda só quando você chama este arquivo direto. Monta 12 seções de mentira e confere que o PDF
// saiu com 10 a 15 páginas: é a garantia de que o tamanho do documento é decisão do código.
if (process.argv[1]?.endsWith("documento.ts")) {
	const secoes: Secao[] = [
		{
			titulo: "O resumo da viagem",
			corpo: "Vocês saem de **São Paulo** no dia 12 de dezembro e voltam no dia 20. São 8 noites, 2 adultos, e o total pesquisado fica em R$ 11.240.\n\nEste documento tem uma página para cada parte da viagem. O que está em tabela é dado de pesquisa, copiado sem nenhuma conta nossa.",
			tabela: {
				cabecalho: ["Item", "O que é", "Valor"],
				linhas: [
					["Voo ida", "GRU → LIS, TAP, direto, 10h25", "R$ 3.180"],
					["Voo volta", "LIS → GRU, TAP, direto, 10h50", "R$ 3.060"],
					["Hotel", "8 noites, Baixa, nota 4,5", "R$ 4.400"],
					["Seguro", "2 pessoas, 9 dias", "R$ 600"],
				],
			},
		},
		{ titulo: "Antes de comprar: as regras", corpo: "O passaporte precisa valer até **20 de junho de 2027**: seis meses depois da volta.\n\n- Portugal não pede visto para brasileiro em turismo de até 90 dias\n- Não há exigência de vacina de febre amarela\n- A conexão não existe nesta opção: os dois voos são diretos" },
		{ titulo: "Os voos", corpo: "A ida direta da TAP é a melhor relação entre preço e tempo. A opção mais barata do mês passa por Madri e custa R$ 420 menos, custando 5 horas a mais de viagem." },
		{ titulo: "Onde ficar", corpo: "A Baixa deixa vocês a pé de quase tudo. Alfama é mais bonita e tem ladeira de verdade: com mala, pesa." },
		{ titulo: "Dia 1 — chegada e Baixa", corpo: "O voo chega 10h25. Check-in às 15h, então deixem a mala no hotel e almocem no Time Out Market, a 10 minutos a pé." },
		{ titulo: "Dia 2 — Belém", corpo: "Mosteiro dos Jerónimos abre às 9h30 e a fila dobra depois das 11h. Vão no primeiro bonde." },
		{ titulo: "Dia 3 — Sintra", corpo: "Sintra é dia inteiro. Comprem o bilhete da Pena pela internet com hora marcada: sem hora marcada, a espera passa de uma hora." },
		{ titulo: "Dia 4 — Alfama e o fado", corpo: "Manhã no Castelo de São Jorge, tarde sem roteiro em Alfama, noite num fado de 20 lugares." },
		{ titulo: "Dia 5 — Cascais", corpo: "Trem de Cais do Sodré, 40 minutos à beira-mar. Vale mais que o Estoril." },
		{ titulo: "Dia 6 — Porto", corpo: "Trem rápido da Comboios de Portugal, 2h50. Comprem com antecedência: na hora, custa o dobro." },
		{ titulo: "Dia 7 e 8 — Porto e Douro", corpo: "Um dia na cidade, um dia no vale do Douro. O vale é melhor de carro alugado que de excursão." },
		{ titulo: "Quanto custa e como pagar", corpo: "O total pesquisado é R$ 11.240. Pagando em euro no débito, o IOF é menor que no crédito parcelado." },
	];

	const saida = import.meta.dirname + "/resultados/roteiro-exemplo.pdf";
	const feito = await gerarPdf({ titulo: "Lisboa e Porto", subtitulo: "12 a 20 de dezembro · 2 adultos · 8 noites", secoes }, saida);

	console.log(`PDF: ${feito.pdf}`);
	console.log(`HTML: ${feito.html}`);
	console.log(`Páginas: ${feito.paginas}`);

	if (feito.paginas < 10 || feito.paginas > 15) throw new Error(`a prova esperava de 10 a 15 páginas, e saíram ${feito.paginas}`);
	console.log("prova passou: o tamanho do documento é decisão do código, não do modelo.");
}
