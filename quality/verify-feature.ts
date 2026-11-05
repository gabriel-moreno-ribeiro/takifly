// verify-feature.ts - roda a verificação de um item do feature_list.json e, só se ela passar, marca o item como passing
//
// Como rodar (dentro da pasta passagens.ts/):   node quality/verify-feature.ts H02

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const RAIZ = import.meta.dirname + "/..";
const ARQUIVO = RAIZ + "/feature_list.json";
const id = process.argv[2];

const lista = JSON.parse(readFileSync(ARQUIVO, "utf8"));
const item = lista.features.find((opcao: any) => opcao.id === id);
if (!item) {
	console.log(`Use: node quality/verify-feature.ts <id>. Não existe item "${id}" no feature_list.json.`);
	process.exit(1);
}
if (item.verification.startsWith("manual:")) {
	console.log(`${id} se confere à mão: ${item.verification.slice(7).trim()}\nQuem confere é a pessoa, que registra a evidência.`);
	process.exit(1);
}

// a prova pula o que já está gravado em results/: numa pasta vazia ela roda tudo de novo, no código de agora
const pasta = `${RAIZ}/results/verificar-${id}`;
rmSync(pasta, { recursive: true, force: true });

console.log(`Verificando ${id}: ${item.verification}\n`);
const rodada = spawnSync("bash", ["-o", "pipefail", "-c", item.verification], { cwd: RAIZ, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, RESULTADOS: pasta } });
process.stdout.write(rodada.stdout ?? "");

if (rodada.status !== 0) {
	console.log(`\n${id} NÃO passou (saída ${rodada.status}). O estado continua "${item.state}".`);
	process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" }).trim();
const sujo = git("status", "--short") ? " com mudanças sem commit" : "";
const ultimaLinha = (rodada.stdout ?? "").trim().split("\n").at(-1) ?? "";
const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

item.state = "passing";
item.evidence = `${hoje}, commit ${git("rev-parse", "--short", "HEAD")}${sujo}: ${ultimaLinha || "saída 0"}`;
lista.last_updated = hoje;
writeFileSync(ARQUIVO, JSON.stringify(lista, null, "\t") + "\n");
console.log(`\n${id} passou. Evidência gravada: ${item.evidence}`);
