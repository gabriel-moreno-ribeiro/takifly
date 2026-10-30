// teste.ts - confere as partes que não dependem de internet nem de IA
//
// Como rodar (dentro da pasta passagens.ts/):   node teste.ts

import assert from "node:assert";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { cortarHistorico } from "./agente.ts";
import { montarAbas } from "./planilha.ts";
import { buscarVoos, type Voo } from "./voos.ts";

// ---------- HISTÓRICO ----------
const pergunta = new HumanMessage("oi");
const pedido = new AIMessage({ content: "", tool_calls: [{ id: "1", name: "buscar_voos", args: {} }] });
const retorno = new ToolMessage({ tool_call_id: "1", content: "voos" });

// o corte nunca pode começar numa resposta de ferramenta
const cortado = cortarHistorico([pergunta, pedido, retorno, pergunta, pedido, retorno], 5);
assert.equal(cortado.length, 3);
assert.equal(cortado[0].getType(), "human");

// conversa curta fica inteira
assert.equal(cortarHistorico([pergunta, pedido, retorno], 40).length, 3);

// uma única rodada maior que o limite ainda começa na pergunta (e nunca fica vazia)
assert.equal(cortarHistorico([pergunta, pedido, retorno, pedido, retorno], 2).length, 5);

// ---------- PLANILHA ----------
const voo: Voo = {
	buscado_em: "2026-10-30T10:00:00", origem: "GRU", destino: "LIS", data: "2026-12-12", companhia: "Cara",
	preco: 3000, duracao_min: 600, escalas: 0, saida: "10:00", chegada: "12/12 20:00", link: "https://exemplo",
};
const abas = montarAbas([voo, { ...voo, companhia: "Barata", preco: 2000, duracao_min: 1050 }]);

assert.deepEqual(abas.map((aba) => aba.nome), ["Resumo", "GRU→LIS 12/12"]);
assert.deepEqual(abas[0].linhas[0], ["GRU→LIS 12/12", 2, 2000, "Barata", "10:00", 3000, "10h00"]);    // a mais barata e a mais rápida
assert.equal(abas[1].linhas[0][0], "Barata");                                                         // a aba começa pela mais barata
assert.equal(abas[1].linhas[0][3], "17h30");

// ---------- VOOS: DADOS ERRADOS NEM CHEGAM AO PYTHON ----------
await assert.rejects(buscarVoos("--help", "LIS", "2026-12-12"), /códigos de aeroporto/);
await assert.rejects(buscarVoos("GRU", "LIS", "12/12/2026"), /formato/);

console.log("Tudo certo!");
