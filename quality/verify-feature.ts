// verify-feature.ts - roda a verificação de um item do feature_list.json e, só se ela passar, marca o item como passing
//
// Como rodar (dentro da pasta passagens.ts/):   node quality/verify-feature.ts H02
// Item com a prova na verification gasta crédito e só roda com o ok da pessoa:   CREDITO=1 node quality/verify-feature.ts F13

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

// a prova gasta crédito da Ollama: só com o ok da pessoa, e antes de apagar o que ela já gravou
if (/node\s+(\S*\/)?quality\/(exam|style-judge|failures)\.ts/.test(item.verification) && process.env.CREDITO !== "1") {
	console.log(`${id} roda a prova e gasta crédito da Ollama. Peça o ok da pessoa e rode: CREDITO=1 node quality/verify-feature.ts ${id}`);
	process.exit(1);
}

// a prova pula o que já está gravado em results/: numa pasta vazia ela roda tudo de novo, no código de agora
const pasta = `${RAIZ}/results/verificar-${id}`;
rmSync(pasta, { recursive: true, force: true });

// nenhum item vira passing sem Tudo certo!; os testes vêm antes para não gastar crédito à toa e para a nota da prova ficar na última linha
// o que está entre aspas é citado, não rodado: o H12 só faz grep por "node quality/tests.ts"
const rodaOsTestes = /node\s+quality\/tests\.ts|npm\s+test|bash\s+init\.sh/.test(item.verification.replace(/'[^']*'|"[^"]*"/g, ""));
const comando = rodaOsTestes ? item.verification : `node quality/tests.ts && (${item.verification})`;
console.log(`Verificando ${id}: ${comando}\n`);
// REJULGAR herdado do terminal faria a prova rejulgar a pasta vazia e passar com 0 de 0
const rodada = spawnSync("bash", ["-o", "pipefail", "-c", comando], { cwd: RAIZ, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, RESULTADOS: pasta, REJULGAR: "" } });
process.stdout.write(rodada.stdout ?? "");

if (rodada.status !== 0) {
	console.log(`\n${id} NÃO passou (saída ${rodada.status}). O estado continua "${item.state}".`);
	process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" }).trim();
const mudados = git("status", "--short").split("\n").filter(Boolean).map((linha) => linha.replace(/^\s*\S+\s+/, ""));
const sujo = mudados.length ? ` com mudanças sem commit (${mudados.slice(0, 5).join(", ")}${mudados.length > 5 ? ` e mais ${mudados.length - 5}` : ""})` : "";
const linhas = (rodada.stdout ?? "").trim().split("\n");
const ultimaLinha = linhas.findLast((linha) => /Tudo certo!|\d+ de \d+/.test(linha)) ?? linhas.at(-1) ?? "";
const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

item.state = "passing";
item.evidence = `${hoje}, commit ${git("rev-parse", "--short", "HEAD")}${sujo}: ${ultimaLinha || "saída 0"}`;
lista.last_updated = hoje;
writeFileSync(ARQUIVO, JSON.stringify(lista, null, "\t") + "\n");
console.log(`\n${id} passou. Evidência gravada: ${item.evidence}`);
