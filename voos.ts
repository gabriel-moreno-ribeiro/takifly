// voos.ts - pesquisa voos de verdade no Google Flights e devolve uma lista organizada
//
// Para testar sozinho (dentro da pasta passagens.ts/):   node voos.ts GRU LIS 2026-12-12

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile roda outro programa; promisify permite usar "await" para esperar ele terminar
const rodarPrograma = promisify(execFile);

// shortcut: usa o voos.py do projeto antigo (depende da pasta ../passagens); trocar se a pasta sair daí
const PASTA_DO_PYTHON = import.meta.dirname + "/../passagens";

// este pedacinho de Python chama o buscar_voos do voos.py e escreve o resultado em JSON
const PROGRAMA_PYTHON = "import json, sys, voos; print(json.dumps(voos.buscar_voos(*sys.argv[1:])))";

// o formato de cada voo (são os mesmos campos que o voos.py devolve)
export type Voo = {
	buscado_em: string;
	origem: string;
	destino: string;
	data: string;
	companhia: string;
	preco: number;
	duracao_min: number;
	escalas: number;
	saida: string;
	chegada: string;
	link: string;
};

// devolve os voos do mais barato ao mais caro; se algo der errado, lança um erro com a explicação
export async function buscarVoos(origem: string, destino: string, data: string): Promise<Voo[]> {
	// ---------- CONFERIR OS DADOS ----------
	// quem escolhe esses valores é o modelo de IA, então conferimos antes de usar
	if (!/^[A-Z]{3}$/.test(origem) || !/^[A-Z]{3}$/.test(destino)) {
		throw new Error("origem e destino precisam ser códigos de aeroporto, como GRU ou LIS");
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
		throw new Error("a data precisa estar no formato AAAA-MM-DD, como 2026-12-12");
	}

	// ---------- PESQUISAR ----------
	try {
		const resultado = await rodarPrograma("uv", ["run", "python", "-c", PROGRAMA_PYTHON, origem, destino, data], {
			cwd: PASTA_DO_PYTHON,    // roda o programa dentro da pasta do projeto antigo
			timeout: 90_000,         // desiste depois de 90 segundos, para não ficar preso
		});
		return JSON.parse(resultado.stdout);
	} catch (erro: any) {
		// o Python escreve vários detalhes no erro; a causa fica na última linha
		const causa = erro.stderr?.trim().split("\n").at(-1) || erro.message;
		throw new Error("a pesquisa de voos falhou: " + causa);
	}
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node voos.ts ...", não quando outro arquivo importa este
if (import.meta.main) {
	const [origem, destino, data] = process.argv.slice(2);
	const voos = await buscarVoos(origem, destino, data);
	console.log(voos.length + " voos. O mais barato:", voos[0]);
}
