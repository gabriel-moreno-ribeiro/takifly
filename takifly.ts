// takifly.ts - liga o Takifly (o bot e o vigia) como serviços do Mac: liga uma vez e eles ficam ligados
//
// O macOS tem um "gerente de programas" chamado launchd. Aqui criamos dois serviços nele, um para o
// bot.ts e outro para o watcher.ts. A partir daí o launchd:
//   - liga os dois agora, e de novo toda vez que você entrar no Mac (depois de reiniciar, por exemplo)
//   - religa cada um sozinho se ele cair, em uns 10 segundos
//   - religa um sem mexer no outro: se o bot cair, o vigia continua de pé, e o contrário também
//
// Como usar (dentro da pasta passagens.ts/):
//   node takifly.ts start     liga os dois e deixa ligados, até você mandar parar
//   node takifly.ts stop      desliga os dois de vez (e eles não voltam ao reiniciar o Mac)
//   node takifly.ts status    mostra se estão rodando
//   node takifly.ts restart   reinicia os dois (use depois de mudar o código)
// O que cada um escreve vai para logs/bot.log e logs/watcher.log. Para acompanhar ao vivo: tail -f logs/bot.log
//
// Rode "start" de novo se a pasta do projeto mudar de lugar ou se você trocar a versão do Node:
// o serviço guarda os dois caminhos de hoje. Com o Mac dormindo nada roda; quando ele acorda, o vigia
// confere o que ficou atrasado.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const PASTA = import.meta.dirname;
const CONTA = `gui/${process.getuid!()}`;    // "os serviços da conta que está usando o Mac agora"

const SERVICOS = [
	{ nome: "com.takifly.bot", arquivo: "bot.ts", log: "logs/bot.log" },
	{ nome: "com.takifly.watcher", arquivo: "watcher.ts", log: "logs/watcher.log" },
];

type Servico = (typeof SERVICOS)[number];

const esperar = (ms: number) => new Promise((pronto) => setTimeout(pronto, ms));

function caminhoDoPlist(servico: Servico) {
	return `${homedir()}/Library/LaunchAgents/${servico.nome}.plist`;
}

// ---------- O ARQUIVO DO SERVIÇO ----------
// o nome da pasta tem "<>", e dentro de um XML isso precisa ser escrito de outro jeito
function xml(texto: string) {
	return texto.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// KeepAlive: religa se cair. ThrottleInterval: espera 10 segundos antes de religar, para um erro que
// derruba o programa na hora não virar um liga-desliga sem parar.
function montarPlist(servico: Servico) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${servico.nome}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(process.execPath)}</string>
		<string>${servico.arquivo}</string>
	</array>
	<key>WorkingDirectory</key><string>${xml(PASTA)}</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${xml(`${PASTA}/${servico.log}`)}</string>
	<key>StandardErrorPath</key><string>${xml(`${PASTA}/${servico.log}`)}</string>
</dict>
</plist>
`;
}

// ---------- FALAR COM O LAUNCHD ----------
// devolve true se o serviço estava ligado
function desligar(servico: Servico) {
	try {
		execFileSync("launchctl", ["bootout", `${CONTA}/${servico.nome}`], { stdio: "pipe" });
		return true;
	} catch {
		return false;    // não estava ligado: tudo bem
	}
}

function situacao(servico: Servico) {
	try {
		const texto = execFileSync("launchctl", ["print", `${CONTA}/${servico.nome}`], { encoding: "utf8", stdio: "pipe" });
		const pid = texto.match(/\bpid = (\d+)/)?.[1];
		return pid ? `rodando (processo ${pid})` : "instalado, mas parado agora (o launchd religa em instantes)";
	} catch {
		return "desligado";
	}
}

// um bot ou vigia ligado à mão, fora do launchd. Dois bots ao mesmo tempo dividiriam as mensagens do Slack.
// O padrão pega "node bot.ts" e ".../bin/node bot.ts", mas não o terminal que chamou o comando.
function ligadosAMao() {
	try {
		return execFileSync("pgrep", ["-fl", "(^|/)node (bot|watcher)\\.ts"], { encoding: "utf8" }).trim();
	} catch {
		return "";    // o pgrep sai com erro quando não acha nada
	}
}

// ---------- OS TRÊS COMANDOS ----------
async function start() {
	// o serviço roda o código da pasta de onde foi ligado: sem .env (worktree do Orca), o bot cairia e o launchd religaria sem parar
	if (!existsSync(`${PASTA}/.env`)) {
		console.log(`Não há .env em ${PASTA} (worktree do Orca?). Nada foi desligado. Ligue da pasta principal do projeto.`);
		process.exit(1);
	}
	let algumEstavaLigado = false;
	for (const servico of SERVICOS) if (desligar(servico)) algumEstavaLigado = true;
	if (algumEstavaLigado) await esperar(1000);    // o launchd leva um instante para soltar o serviço antigo

	const soltos = ligadosAMao();
	if (soltos) {
		console.log(`Tem bot ou vigia ligado fora do serviço. Desligue antes (kill + o número), senão roda em dobro:\n${soltos}`);
		process.exit(1);
	}

	mkdirSync(`${PASTA}/logs`, { recursive: true });
	for (const servico of SERVICOS) {
		writeFileSync(caminhoDoPlist(servico), montarPlist(servico));
		execFileSync("plutil", ["-lint", caminhoDoPlist(servico)], { stdio: "pipe" });    // se o arquivo saiu torto, para aqui
		execFileSync("launchctl", ["bootstrap", CONTA, caminhoDoPlist(servico)], { stdio: "pipe" });
	}
	await esperar(3000);
	status();
	console.log("\nLigados. Eles continuam ligados depois de fechar o terminal e depois de reiniciar o Mac.");
}

function stop() {
	for (const servico of SERVICOS) {
		desligar(servico);
		rmSync(caminhoDoPlist(servico), { force: true });    // sem o arquivo, ele não volta ao reiniciar o Mac
	}
	console.log("Bot e vigia desligados.");
}

// kickstart -k: o launchd mata e liga de novo, com o código novo. Não mexe na instalação.
async function restart() {
	for (const servico of SERVICOS) {
		try {
			execFileSync("launchctl", ["kickstart", "-k", `${CONTA}/${servico.nome}`], { stdio: "pipe" });
		} catch {
			console.log(`${servico.arquivo} não está instalado: rode "node takifly.ts start" primeiro.`);
		}
	}
	await esperar(3000);
	status();
}

function status() {
	for (const servico of SERVICOS) console.log(`${servico.arquivo.padEnd(11)} ${situacao(servico)}`);
}

// ---------- USO PELO TERMINAL ----------
const comando = process.argv[2];
if (comando === "start") await start();
else if (comando === "stop") stop();
else if (comando === "status") status();
else if (comando === "restart") await restart();
else {
	console.log("Use: node takifly.ts start | stop | status | restart");
	process.exit(1);
}
