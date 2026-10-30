// voos.ts - passo 13: pesquisar voos de verdade no Google Flights (ainda sem o modelo e sem o Slack)
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node voos.ts GRU LIS 2026-12-12

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile roda outro programa; promisify permite usar "await" para esperar ele terminar
const rodarPrograma = promisify(execFile);

// shortcut: usa o voos.py do projeto antigo (depende da pasta ../passagens); trocar se a pasta sair daí
const PASTA_DO_PYTHON = import.meta.dirname + "/../passagens";

export async function buscarVoos(origem: string, destino: string, data: string) {
	// ---------- CONFERIR OS DADOS ----------
	// quem vai escolher esses valores é o modelo de IA, então conferimos antes de usar
	if (!/^[A-Z]{3}$/.test(origem) || !/^[A-Z]{3}$/.test(destino)) {
		return "Erro: origem e destino precisam ser códigos de aeroporto, como GRU ou LIS.";
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
		return "Erro: a data precisa estar no formato AAAA-MM-DD, como 2026-12-12.";
	}

	// ---------- PESQUISAR ----------
	try {
		const resultado = await rodarPrograma("uv", ["run", "voos.py", origem, destino, data], {
			cwd: PASTA_DO_PYTHON,    // roda o programa dentro da pasta do projeto antigo
			timeout: 90_000,         // desiste depois de 90 segundos, para não ficar preso
		});
		return resultado.stdout.trim() || "Nenhum voo encontrado.";
	} catch (erro) {
		return "Erro ao pesquisar voos: " + erro;
	}
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node voos.ts ...", não quando outro arquivo importa este
if (import.meta.main) {
	const [origem, destino, data] = process.argv.slice(2);
	console.log(await buscarVoos(origem, destino, data));
}
