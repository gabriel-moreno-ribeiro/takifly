// scoreboard.ts - lê results/*.jsonl e mostra a nota de cada modelo, por grupo e por cenário
//
// Como rodar (dentro da pasta passagens.ts/, a de cima):
//   node quality/scoreboard.ts                              a rodada atual
//   node quality/scoreboard.ts results/rodada-1  uma rodada antiga

import { readdir, readFile } from "node:fs/promises";

const PASTA = process.argv[2] ?? import.meta.dirname + "/../results";

// se um cenário rodou mais de uma vez, vale a última
const notas = new Map<string, Map<string, any>>();
for (const arquivo of await readdir(PASTA)) {
	if (!arquivo.endsWith(".jsonl")) continue;
	const texto = await readFile(`${PASTA}/${arquivo}`, "utf8");
	for (const linha of texto.split("\n").filter(Boolean).map((l) => JSON.parse(l))) {
		if (!notas.has(linha.modelo)) notas.set(linha.modelo, new Map());
		notas.get(linha.modelo)!.set(linha.caso, linha);
	}
}

const modelos = [...notas.keys()].toSorted();
const casos = [...new Set(modelos.flatMap((modelo) => [...notas.get(modelo)!.keys()]))].toSorted();
const grupoDe = (caso: string) => caso.split("-")[0];
const grupos = [...new Set(casos.map(grupoDe))];

function nota(modelo: string, lista: string[]) {
	const linhas = lista.map((caso) => notas.get(modelo)!.get(caso)).filter(Boolean);
	return `${linhas.filter((linha) => linha.passou).length}/${linhas.length}`;
}

console.log("NOTA GERAL");
for (const modelo of modelos) {
	const linhas = [...notas.get(modelo)!.values()];
	const quebrados = linhas.filter((linha) => linha.erro).length;
	const segundos = linhas.reduce((soma, linha) => soma + linha.segundos, 0);
	console.log(`  ${modelo.padEnd(22)} ${nota(modelo, casos).padEnd(9)} quebrou: ${quebrados}   tempo por cenário: ${Math.round(segundos / linhas.length)}s`);
}

console.log("\nPOR GRUPO");
console.log("  " + "grupo".padEnd(14) + modelos.map((modelo) => modelo.slice(0, 12).padEnd(14)).join(""));
for (const grupo of grupos) {
	const lista = casos.filter((caso) => grupoDe(caso) === grupo);
	console.log("  " + grupo.padEnd(14) + modelos.map((modelo) => nota(modelo, lista).padEnd(14)).join(""));
}

console.log("\nOS CENÁRIOS QUE MAIS FALHARAM");
const falhas = casos
	.map((caso) => ({ caso, quem: modelos.filter((modelo) => notas.get(modelo)!.get(caso)?.passou === false) }))
	.filter((item) => item.quem.length > 0)
	.toSorted((a, b) => b.quem.length - a.quem.length);
for (const { caso, quem } of falhas) console.log(`  ${quem.length}  ${caso.padEnd(36)} ${quem.join(", ")}`);
