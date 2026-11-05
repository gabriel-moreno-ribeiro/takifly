// failures.ts - busca no Langfuse tudo o que deu errado e monta a lista do que melhorar no harness
//
// Lê três coisas: os cenários que falharam na prova, as respostas barradas pelo verificador (na prova e no Slack)
// e as ferramentas que terminaram em erro.
// Junta os erros parecidos, do mais frequente ao menos frequente, e salva em results/melhorias.md.
// Este arquivo não muda o bot: quem decide a correção é uma pessoa, e a prova (exam.ts) confere se ela funcionou.
//
// Como rodar (dentro da pasta passagens.ts/, a de cima):
//   node quality/failures.ts                              desde que o Langfuse foi ligado neste projeto
//   node quality/failures.ts 2026-11-01T00:00:00Z         desde essa data

import { mkdir, writeFile } from "node:fs/promises";

process.loadEnvFile(import.meta.dirname + "/../.env");

const LANGFUSE_LIGADO_EM = "2026-10-30T21:00:00Z";
const desde = process.argv[2] ?? LANGFUSE_LIGADO_EM;
const BASE = process.env.LANGFUSE_BASE_URL;
const CHAVE = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");

async function pedir(caminho: string) {
	const resposta = await fetch(BASE + caminho, { headers: { Authorization: "Basic " + CHAVE } });
	// o Langfuse limita os pedidos por minuto e diz quanto tempo esperar
	if (resposta.status === 429) {
		const { details } = await resposta.json();
		await new Promise((pronto) => setTimeout(pronto, (details?.retryAfterSeconds ?? 60) * 1000));
		return pedir(caminho);
	}
	if (!resposta.ok) throw new Error(`o Langfuse respondeu ${resposta.status}: ${(await resposta.text()).slice(0, 300)}`);
	return resposta.json();
}

// o Langfuse entrega aos poucos: cada resposta traz um "cursor" que aponta para a próxima parte
async function pedirTudo(caminho: string) {
	const itens: any[] = [];
	let cursor = "";
	do {
		const dados = await pedir(`${caminho}&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
		itens.push(...dados.data);
		cursor = dados.meta?.cursor ?? "";
	} while (cursor);
	return itens;
}

// ---------- OS CENÁRIOS QUE FALHARAM ----------
// a sessão se chama "prova <modelo> <cenário> <hora>". Se um cenário rodou de novo e passou, a falha antiga não conta.
function lerSessao(sessao: string) {
	const [, modelo, caso, hora] = sessao.split(" ");
	return { modelo, caso, hora: Number(hora) };
}

const notas = await pedirTudo(`/api/public/v3/scores?name=passou&dataType=BOOLEAN&fields=core,details,subject&fromTimestamp=${desde}`);
const ultimaNota = new Map<string, any>();
for (const nota of notas) {
	const sessao = nota.subject?.kind === "session" ? nota.subject.id : "";
	if (!sessao.startsWith("prova ")) continue;
	const { modelo, caso, hora } = lerSessao(sessao);
	const chave = `${modelo} ${caso}`;
	if (!ultimaNota.has(chave) || lerSessao(ultimaNota.get(chave).subject.id).hora < hora) ultimaNota.set(chave, nota);
}

const falhasPorCaso = new Map<string, { modelo: string; comentario: string; sessao: string }[]>();
for (const nota of ultimaNota.values()) {
	if (nota.value === true) continue;
	const { modelo, caso } = lerSessao(nota.subject.id);
	falhasPorCaso.set(caso, [...(falhasPorCaso.get(caso) ?? []), { modelo, comentario: nota.comment ?? "", sessao: nota.subject.id }]);
}

// ---------- AS FERRAMENTAS QUE DERAM ERRO ----------
const erros = await pedirTudo(`/api/public/v2/observations?level=ERROR&fields=core,basic&fromStartTime=${desde}`);
const errosParecidos = new Map<string, { vezes: number; exemplo: string; trace: string }>();
for (const erro of erros) {
	// tira os valores que mudam, para "não conheço X" e "não conheço Y" virarem o mesmo erro
	const mensagem = String(erro.statusMessage ?? "sem mensagem");
	const molde = `${erro.name}: ${mensagem.replace(/"[^"]*"/g, '"…"').replace(/\d[\d\-/:.]*/g, "#")}`.slice(0, 160);
	const atual = errosParecidos.get(molde);
	errosParecidos.set(molde, { vezes: (atual?.vezes ?? 0) + 1, exemplo: atual?.exemplo ?? mensagem, trace: atual?.trace ?? erro.traceId });
}

// ---------- AS RESPOSTAS BARRADAS ----------
function juntar(mapa: Map<string, number>, texto: string) {
	const molde = texto.replace(/R\$ [\d.,]+/g, "R$ #").replace(/\d+h\d*/g, "#h").slice(0, 160);
	mapa.set(molde, (mapa.get(molde) ?? 0) + 1);
}

const barradas = new Map<string, number>();
for (const nome of ["verificador_recusou", "emergencia"]) {
	const lista = await pedirTudo(`/api/public/v3/scores?name=${nome}&dataType=BOOLEAN&fields=core,details&fromTimestamp=${desde}`);
	for (const nota of lista) for (const problema of String(nota.comment ?? nome).split(" | ")) juntar(barradas, problema);
}

// ---------- ESCREVER A LISTA ----------
const projeto = (await pedir("/api/public/projects")).data[0].id;
const linkDaSessao = (sessao: string) => `${BASE}/project/${projeto}/sessions/${encodeURIComponent(sessao)}`;
const linkDoTrace = (trace: string) => `${BASE}/project/${projeto}/traces/${trace}`;

const casos = [...falhasPorCaso].toSorted((a, b) => b[1].length - a[1].length);
const partes = [`# O que melhorar no harness\n\nDesde ${desde}: ${ultimaNota.size} cenários medidos, ${casos.length} cenários com falha, ${erros.length} erros de ferramenta.\n\n## Cenários que falharam\n`];
for (const [caso, falhas] of casos) {
	partes.push(`### ${caso} (${falhas.length} ${falhas.length === 1 ? "modelo" : "modelos"})\n`);
	for (const falha of falhas) partes.push(`- [${falha.modelo}](${linkDaSessao(falha.sessao)}): ${falha.comentario.replaceAll("\n", " ").slice(0, 300)}`);
	partes.push("");
}
partes.push("## Respostas barradas pelo verificador\n");
for (const [molde, vezes] of [...barradas].toSorted((a, b) => b[1] - a[1])) partes.push(`- ${vezes}x ${molde}`);
partes.push("");
partes.push("## Erros de ferramenta\n");
for (const [molde, { vezes, trace }] of [...errosParecidos].toSorted((a, b) => b[1].vezes - a[1].vezes)) {
	partes.push(`- ${vezes}x [${molde}](${linkDoTrace(trace)})`);
}

await mkdir(import.meta.dirname + "/../results", { recursive: true });
await writeFile(import.meta.dirname + "/../results/melhorias.md", partes.join("\n") + "\n");
console.log(partes[0]);
console.log("Lista completa em results/melhorias.md");
