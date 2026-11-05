// database.ts - o que precisa durar além da conversa: os monitoramentos e as preferências de cada conversa
//
// Fica no arquivo data/dados.sqlite, ao lado do data/memoria.sqlite. O SQLite já vem dentro do Node.

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
	planilha: string | null;       // o link da planilha viva deste monitoramento (uma por monitoramento)
};

// uma linha por checagem: é isto que vira linha na planilha viva.
// Guardamos só o que serve para ler a curva de preço; o resto do voo não ajuda a decidir nada.
export type PrecoDoHistorico = {
	monitoramento: number;
	checado_em: number;
	total: number;
	companhia_ida: string;
	preco_ida: number;
	link_ida: string;
	companhia_volta: string | null;    // só ida: fica em branco
	preco_volta: number | null;
	link_volta: string | null;
};

// só abre o arquivo no primeiro uso: assim os testes e a prova conseguem usar uma memória temporária (DADOS=:memory:)
let aberto: DatabaseSync | null = null;

function banco() {
	if (!aberto) {
		aberto = new DatabaseSync(process.env.DADOS ?? import.meta.dirname + "/../data/dados.sqlite");
		// o bot e o vigia escrevem no mesmo arquivo: WAL deixa um ler enquanto o outro escreve, e o busy_timeout
		// espera até 5 s em vez de falhar com "database is locked"
		aberto.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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
				ativo INTEGER NOT NULL DEFAULT 1,
				planilha TEXT
			);
			CREATE TABLE IF NOT EXISTS historico_precos (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				monitoramento INTEGER NOT NULL,
				checado_em INTEGER NOT NULL,
				total REAL NOT NULL,
				companhia_ida TEXT NOT NULL,
				preco_ida REAL NOT NULL,
				link_ida TEXT NOT NULL,
				companhia_volta TEXT,
				preco_volta REAL,
				link_volta TEXT
			);
			CREATE TABLE IF NOT EXISTS buscas_do_dia (
				dia TEXT PRIMARY KEY,
				quantas INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS dossie (
				conversa TEXT PRIMARY KEY,
				nacionalidade TEXT NOT NULL DEFAULT 'BR',
				passaporte_validade TEXT,
				nascimento TEXT,
				vacina_febre_amarela TEXT
			);
			CREATE TABLE IF NOT EXISTS preferencias (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conversa TEXT NOT NULL,
				texto TEXT NOT NULL
			);

			-- views: só para uma pessoa ler o arquivo (sqlite3, DB Browser). O código continua lendo as tabelas acima.
			-- checado_em é milissegundos desde 1970; aqui vira data e hora de São Paulo.
			CREATE VIEW IF NOT EXISTS ver_monitoramentos AS
			SELECT
				id,
				CASE ativo WHEN 1 THEN 'ativo' ELSE 'encerrado' END AS situacao,
				origens || ' → ' || destinos AS rota,
				data AS ida,
				COALESCE(data_volta, 'só ida') AS volta,
				adultos || ' adulto(s), ' || criancas || ' criança(s)' AS passageiros,
				classe,
				preco_alvo,
				menor_preco,
				avisado_preco AS ultimo_aviso,
				falhas AS falhas_seguidas,
				CASE checado_em WHEN 0 THEN 'nunca' ELSE datetime(checado_em / 1000, 'unixepoch', '-3 hours') END AS ultima_checagem,
				planilha,
				conversa
			FROM monitoramentos;

			CREATE VIEW IF NOT EXISTS ver_historico AS
			SELECT
				h.monitoramento,
				m.origens || ' → ' || m.destinos AS rota,
				datetime(h.checado_em / 1000, 'unixepoch', '-3 hours') AS quando,
				h.total,
				h.companhia_ida || ' (' || h.preco_ida || ')' AS ida,
				COALESCE(h.companhia_volta || ' (' || h.preco_volta || ')', '—') AS volta,
				h.link_ida,
				h.link_volta
			FROM historico_precos h
			JOIN monitoramentos m ON m.id = h.monitoramento
			ORDER BY h.monitoramento, h.id;
		`);

		// o dados.sqlite que já existe foi criado sem a coluna "planilha": o CREATE TABLE acima não mexe
		// numa tabela que já está lá, então a coluna que falta entra à mão.
		const colunas = aberto.prepare("PRAGMA table_info(monitoramentos)").all() as unknown as { name: string }[];
		if (!colunas.some((coluna) => coluna.name === "planilha")) aberto.exec("ALTER TABLE monitoramentos ADD COLUMN planilha TEXT");
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

export function atualizarMonitoramento(id: number, campos: Partial<Pick<Monitoramento, "menor_preco" | "avisado_preco" | "falhas" | "checado_em" | "ativo" | "planilha">>) {
	const nomes = Object.keys(campos);
	banco().prepare(`UPDATE monitoramentos SET ${nomes.map((nome) => nome + " = ?").join(", ")} WHERE id = ?`).run(...(Object.values(campos) as (number | string | null)[]), id);
}

// ---------- HISTÓRICO DE PREÇO ----------
// o monitoramento guarda só o menor preço; aqui fica a checagem de cada 2 horas, uma linha por vez
export function gravarPreco(linha: PrecoDoHistorico) {
	banco()
		.prepare("INSERT INTO historico_precos (monitoramento, checado_em, total, companhia_ida, preco_ida, link_ida, companhia_volta, preco_volta, link_volta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
		.run(linha.monitoramento, linha.checado_em, linha.total, linha.companhia_ida, linha.preco_ida, linha.link_ida, linha.companhia_volta, linha.preco_volta, linha.link_volta);
}

// em ordem de checagem (o id cresce junto com o tempo): é a ordem que a planilha mostra
export function listarHistorico(monitoramento: number) {
	return banco().prepare("SELECT * FROM historico_precos WHERE monitoramento = ? ORDER BY id").all(monitoramento) as unknown as (PrecoDoHistorico & { id: number })[];
}

// ---------- BUSCAS DO DIA ----------
// a conta do teto diário mora no banco, e não na memória, para sobreviver a um reinício do processo
export function buscasDoDia(dia: string) {
	const linha = banco().prepare("SELECT quantas FROM buscas_do_dia WHERE dia = ?").get(dia) as unknown as { quantas: number } | undefined;
	return linha?.quantas ?? 0;
}

export function somarBuscasDoDia(dia: string, quantas: number) {
	banco().prepare("INSERT INTO buscas_do_dia (dia, quantas) VALUES (?, ?) ON CONFLICT(dia) DO UPDATE SET quantas = quantas + ?").run(dia, quantas, quantas);
}

// ---------- DOSSIÊ ----------
// o que o nó das regras precisa saber da pessoa: uma linha por conversa, e todo campo pode faltar.
// Campo que falta não fica em silêncio: as regras devolvem "não deu para conferir".
// Isto fica separado das preferências porque preferência é texto livre, e aqui cada campo é uma data
// que entra numa subtração.
export type Dossie = {
	nacionalidade: string;
	passaporte_validade: string | null;
	nascimento: string | null;
	vacina_febre_amarela: string | null;
};

export function lerDossie(conversa: string) {
	const linha = banco().prepare("SELECT nacionalidade, passaporte_validade, nascimento, vacina_febre_amarela FROM dossie WHERE conversa = ?").get(conversa);
	return (linha ?? null) as unknown as Dossie | null;
}

// grava só os campos que vieram: quem conta a data de nascimento não precisa repetir o passaporte
export function guardarDossie(conversa: string, campos: Partial<Dossie>) {
	const nomes = Object.keys(campos);
	if (nomes.length === 0) return;
	banco().prepare("INSERT INTO dossie (conversa) VALUES (?) ON CONFLICT(conversa) DO NOTHING").run(conversa);
	banco().prepare(`UPDATE dossie SET ${nomes.map((nome) => nome + " = ?").join(", ")} WHERE conversa = ?`).run(...(Object.values(campos) as (string | null)[]), conversa);
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
