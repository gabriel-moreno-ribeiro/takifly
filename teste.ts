// teste.ts - confere as partes que não dependem de internet nem de IA
//
// Como rodar (dentro da pasta passagens.ts/):   node teste.ts

import assert from "node:assert";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { cortarHistorico } from "./agente.ts";
import { montarAbas } from "./planilha.ts";
import { buscarVoos, lerPagina, montarTfs, precoEquivalente, type Voo } from "./voos.ts";

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
	origem: "GRU", destino: "LIS", data: "2026-12-12", companhia: "Direta",
	preco: 3000, duracao_min: 600, escalas: 0, saida: "10:00", chegada: "12/12 20:00", link: "https://exemplo",
};
const barata = { ...voo, companhia: "Barata", preco: 2000, duracao_min: 3000, escalas: 2 };
const abas = montarAbas([voo, barata]);

assert.deepEqual(abas.map((aba) => aba.nome), ["Resumo", "GRU→LIS 12/12"]);
// o mais barato é a Barata, mas o melhor custo-benefício e o mais rápido são a Direta
assert.deepEqual(abas[0].linhas[0], ["GRU→LIS 12/12", 2, 2000, "Barata", "10:00", 3000, "Direta", 3000, "10h00"]);
assert.equal(abas[1].linhas[0][0], "Barata");    // a aba começa pela mais barata
assert.equal(abas[1].linhas[0][4], "50h00");

// ---------- CUSTO-BENEFÍCIO ----------
assert.equal(precoEquivalente(voo), 3000 + 10 * 30);
assert.equal(precoEquivalente(barata), 2000 + 50 * 30 + 2 * 200);

// ---------- O PEDIDO AO GOOGLE ----------
// este é o "tfs" que a biblioteca fast-flights gerava para o mesmo pedido
assert.equal(montarTfs("GRU", "REC", "2026-12-16", 1, 0, "economica"), "GhoSCjIwMjYtMTItMTZqBRIDR1JVcgUSA1JFQ0IBAUgBmAEC");

// ---------- LER A PÁGINA DO GOOGLE ----------
// monta uma página de mentira com o mesmo formato da verdadeira
function pagina(dados: string) {
	return `<script class="ds:1" nonce="x">AF_initDataCallback({key: 'ds:1', data:${dados}, sideChannel: {}});</script>`;
}
function trecho(saida: (number | null)[], chegada: number[], dia: number[], diaChegada: number[], minutos: number) {
	const dados: any[] = [];
	dados[8] = saida;
	dados[10] = chegada;
	dados[11] = minutos;
	dados[20] = dia;
	dados[21] = diaChegada;
	return dados;
}
const comEscala = [[null, ["LATAM", "Iberia"], [trecho([null, 31], [10], [2026, 12, 12], [2026, 12, 12], 100), trecho([12, 5], [20, 30], [2026, 12, 12], [2026, 12, 13], 200)]], [[null, 3000]]];
const semPreco = [[null, ["Gol"], [trecho([8], [9], [2026, 12, 12], [2026, 12, 12], 60)]], [[null, null]]];
const direto = [[null, ["Gol"], [trecho([8], [9], [2026, 12, 12], [2026, 12, 12], 60)]], [[null, 1000]]];
const lidos = lerPagina(pagina(JSON.stringify([null, null, null, [[comEscala, semPreco, direto]]])), "GRU", "LIS", "2026-12-12", "https://exemplo");

assert.equal(lidos.length, 2);                   // o voo sem preço ficou de fora
assert.equal(lidos[0].companhia, "Gol");         // do mais barato ao mais caro
assert.equal(lidos[1].companhia, "LATAM + Iberia");
assert.equal(lidos[1].saida, "00:31");           // [null, 31] é 00:31
assert.equal(lidos[1].chegada, "13/12 20:30");
assert.equal(lidos[1].escalas, 1);
assert.equal(lidos[1].duracao_min, 100 + 125 + 200);    // voo + espera de 10:00 às 12:05 + voo

// "não há voos" é diferente de "a página mudou"
assert.deepEqual(lerPagina(pagina("[]"), "GRU", "ZZZ", "2026-12-12", ""), []);
assert.deepEqual(lerPagina(pagina("[null, null, null, [null]]"), "GRU", "LIS", "2026-12-12", ""), []);
assert.deepEqual(lerPagina(`<script class="ds:1">AF_initDataCallback({key: 'ds:1', data:[3,null],errorHasStatus: true,});</script>`, "GRU", "LIS", "2020-01-01", ""), []);
assert.throws(() => lerPagina("<html>captcha</html>", "GRU", "LIS", "2026-12-12", ""), /sem os dados/);
assert.throws(() => lerPagina(pagina("[1, 2]"), "GRU", "LIS", "2026-12-12", ""), /formato novo/);

// ---------- VOOS: DADOS ERRADOS NEM CHEGAM AO GOOGLE ----------
await assert.rejects(buscarVoos("--help", "LIS", "2026-12-12"), /códigos de aeroporto/);
await assert.rejects(buscarVoos("GRU", "LIS", "12/12/2026"), /formato/);
await assert.rejects(buscarVoos("GRU", "LIS", "2026-02-30"), /formato/);
await assert.rejects(buscarVoos("GRU", "LIS", "2026-12-12", 0), /adulto/);
await assert.rejects(buscarVoos("GRU", "LIS", "2026-12-12", 8, 2), /adulto/);
await assert.rejects(buscarVoos("GRU", "LIS", "2026-12-12", 1, 0, "luxo"), /classe/);

console.log("Tudo certo!");
