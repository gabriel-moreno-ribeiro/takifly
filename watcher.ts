// watcher.ts - o vigia de preços, rodando sozinho, fora do bot
//
// O bot e o vigia são dois programas. Se o bot cair (Slack, modelo, um bug no grafo), o vigia continua
// checando preço e avisando. Os dois só conversam pelo dados.sqlite: o bot grava o monitoramento, o vigia lê.
//
// Como rodar (dentro da pasta passagens.ts/, num terminal separado do bot):   node watcher.ts
// Para checar uma vez só, sem Slack:                                          node brain/price-watch.ts
// Para ligar bot e vigia de uma vez e deixar ligados:                         node takifly.ts start

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { ligarMonitor } from "./brain/price-watch.ts";

// ---------- UM VIGIA SÓ ----------
// dois vigias ao mesmo tempo mandariam o mesmo aviso duas vezes. O arquivo data/watcher.pid guarda quem está vigiando.
// shortcut: se o Mac reaproveitar o número de um vigia morto para outro programa, este vigia se recusa a ligar; apague o data/watcher.pid e rode de novo.
// caminho a partir deste arquivo, e não da pasta de onde rodou: rodado de outra pasta, a trava ficaria em outro lugar e não veria o vigia de verdade
const ARQUIVO_DO_VIGIA = import.meta.dirname + "/data/watcher.pid";

if (existsSync(ARQUIVO_DO_VIGIA)) {
	const outro = Number(readFileSync(ARQUIVO_DO_VIGIA, "utf8"));
	let estaVivo = true;
	try {
		process.kill(outro, 0);    // o sinal 0 não mata nada: só pergunta se o processo existe
	} catch {
		estaVivo = false;
	}
	if (estaVivo) {
		console.log(`Já tem um vigia ligado (processo ${outro}). Não liguei outro.`);
		process.exit(1);
	}
}
writeFileSync(ARQUIVO_DO_VIGIA, String(process.pid));
process.on("exit", () => rmSync(ARQUIVO_DO_VIGIA, { force: true }));
process.on("SIGINT", () => process.exit(0));     // Ctrl+C
process.on("SIGTERM", () => process.exit(0));    // kill

// ---------- CHAVES ----------
process.loadEnvFile(import.meta.dirname + "/.env");

// ---------- AVISAR NO SLACK ----------
// o vigia só manda mensagem, não escuta nada: não precisa da biblioteca do Slack, um fetch basta (igual o email.ts).
// O Slack responde 200 mesmo quando falha, com ok: false. Por isso o erro é lançado aqui: o nó avisar só grava
// "já avisei" se esta função terminar sem erro, e assim a próxima checagem tenta de novo.
async function avisarNoSlack(conversa: string, texto: string) {
	const resposta = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ channel: conversa, text: texto, unfurl_links: false, unfurl_media: false }),    // sem o cartão de prévia do Google embaixo do link
	});
	const corpo = await resposta.json();
	if (!corpo.ok) throw new Error(`o Slack não aceitou o aviso: ${corpo.error}`);
}

// ---------- LIGAR ----------
ligarMonitor(avisarNoSlack);
console.log("Vigia de preços do Takifly ligado. O Taki fica de guarda. Ctrl+C para desligar.");
