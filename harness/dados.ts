// dados.ts - o que precisa durar além da conversa: os monitoramentos e as preferências de cada conversa
//
// Fica no arquivo dados.sqlite, ao lado do memoria.sqlite. O SQLite já vem dentro do Node.

import { DatabaseSync } from "node:sqlite";

export type Monitoramento = {
	id: number;
	conversa: string;
	origens: string;               // "GRU,CGH,VCP"
	destinos: string;              // "LIS"
	data: string;
	data_volta: string | null;     // sem volta, é só ida
	adultos: number;
	criancas: number;
	classe: string;
	preco_alvo: number | null;     // sem alvo, avisa quando achar o menor preço até agora
	menor_preco: number | null;
	avisado_preco: number | null;  // o último preço avisado: só avisa de novo se ficar ainda menor
	falhas: number;                // checagens seguidas que falharam
	checado_em: number;
	ativo: number;
};

// só abre o arquivo no primeiro uso: assim os testes e a prova conseguem usar uma memória temporária (DADOS=:memory:)
let aberto: DatabaseSync | null = null;

function banco() {
	if (!aberto) {
		aberto = new DatabaseSync(process.env.DADOS ?? import.meta.dirname + "/../dados.sqlite");
		aberto.exec(`
			CREATE TABLE IF NOT EXISTS monitoramentos (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversa TEXT NOT NULL,
				origens TEXT NOT NULL,
				destinos TEXT NOT NULL,
				data TEXT NOT NULL,
				data_volta TEXT,
				adultos INTEGER NOT NULL,
				criancas INTEGER NOT NULL,
				classe TEXT NOT NULL,
				preco_alvo REAL,
				menor_preco REAL,
				avisado_preco REAL,
				falhas INTEGER NOT NULL DEFAULT 0,
				checado_em INTEGER NOT NULL DEFAULT 0,
				ativo INTEGER NOT NULL DEFAULT 1
			);
			CREATE TABLE IF NOT EXISTS preferencias (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversa TEXT NOT NULL,
				texto TEXT NOT NULL
			);
		`);
	}
	return aberto;
}

// ---------- MONITORAMENTOS ----------
type NovoMonitoramento = Pick<Monitoramento, "conversa" | "origens" | "destinos" | "data" | "data_volta" | "adultos" | "criancas" | "classe" | "preco_alvo" | "menor_preco" | "avisado_preco" | "checado_em">;

export function criarMonitoramento(novo: NovoMonitoramento) {
	const resultado = banco()
		.prepare("INSERT INTO monitoramentos (conversa, origens, destinos, data, data_volta, adultos, criancas, classe, preco_alvo, menor_preco, avisado_preco, checado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(novo.conversa, novo.origens, novo.destinos, novo.data, novo.data_volta, novo.adultos, novo.criancas, novo.classe, novo.preco_alvo, novo.menor_preco, novo.avisado_preco, novo.checado_em);
	return Number(resultado.lastInsertRowid);
}

// sem conversa, devolve os de todas: é o que a rotina de checagem usa
export function listarMonitoramentos(conversa?: string) {
	const consulta = conversa === undefined
		? banco().prepare("SELECT * FROM monitoramentos WHERE ativo = 1 ORDER BY id").all()
		: banco().prepare("SELECT * FROM monitoramentos WHERE ativo = 1 AND conversa = ? ORDER BY id").all(conversa);
	return consulta as unknown as Monitoramento[];
}

// só cancela um monitoramento da própria conversa
export function cancelarMonitoramento(conversa: string, id: number) {
	return banco().prepare("UPDATE monitoramentos SET ativo = 0 WHERE id = ? AND conversa = ? AND ativo = 1").run(id, conversa).changes > 0;
}

export function atualizarMonitoramento(id: number, campos: Partial<Pick<Monitoramento, "menor_preco" | "avisado_preco" | "falhas" | "checado_em" | "ativo">>) {
	const nomes = Object.keys(campos);
	banco().prepare(`UPDATE monitoramentos SET ${nomes.map((nome) => nome + " = ?").join(", ")} WHERE id = ?`).run(...(Object.values(campos) as (number | null)[]), id);
}

// ---------- PREFERÊNCIAS ----------
export function guardarPreferencia(conversa: string, texto: string) {
	banco().prepare("INSERT INTO preferencias (conversa, texto) VALUES (?, ?)").run(conversa, texto);
}

export function listarPreferencias(conversa: string) {
	return banco().prepare("SELECT id, texto FROM preferencias WHERE conversa = ? ORDER BY id").all(conversa) as unknown as { id: number; texto: string }[];
}

export function apagarPreferencia(conversa: string, id: number) {
	return banco().prepare("DELETE FROM preferencias WHERE id = ? AND conversa = ?").run(id, conversa).changes > 0;
}
