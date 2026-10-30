// teste.ts - confere as partes que não dependem de internet nem de IA
//
// Como rodar (dentro da pasta passagens.ts/):   node teste.ts

import assert from "node:assert";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { cortarHistorico, noFerramentas } from "./agente.ts";
import { dataFoiDita, entenderData, ferramentasDaEtapa, limparArgumentos, resolverAeroportos, servicos, todasAsFerramentas, type Caderno } from "./ferramentas.ts";
import { montarAbas } from "./planilha.ts";
import { arrumarParaSlack, verificarResposta } from "./verificador.ts";
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

// ---------- DATAS ----------
const HOJE = "2026-10-30";    // uma sexta-feira
assert.equal(entenderData("12/12", HOJE), "2026-12-12");
assert.equal(entenderData("2026-12-12", HOJE), "2026-12-12");
assert.equal(entenderData("12 de dezembro", HOJE), "2026-12-12");
assert.equal(entenderData("dia 13 de março", HOJE), "2027-03-13");    // março já passou: é o do ano que vem
assert.equal(entenderData("15/01", HOJE), "2027-01-15");
assert.equal(entenderData("dia 31", HOJE), "2026-10-31");
assert.equal(entenderData("dia 5", HOJE), "2026-11-05");
assert.equal(entenderData("amanhã", HOJE), "2026-10-31");
assert.equal(entenderData("depois de amanhã", HOJE), "2026-11-01");
assert.equal(entenderData("próxima segunda", HOJE), "2026-11-02");
assert.equal(entenderData("sexta-feira", HOJE), "2026-11-06");        // dita numa sexta: é a da semana seguinte
assert.throws(() => entenderData("01/01/2020", HOJE), /já passou/);
assert.throws(() => entenderData("30/02/2027", HOJE), /não existe/);
assert.throws(() => entenderData("qualquer dia", HOJE), /não entendi/);

// a trava contra a data inventada
assert.equal(dataFoiDita("2026-12-12", ["voos em 12/12"]), true);
assert.equal(dataFoiDita("2026-11-06", ["na próxima sexta"]), true);
assert.equal(dataFoiDita("2026-12-12", ["quero ir para Lisboa"]), false);
assert.equal(dataFoiDita("2026-12-05", ["em 15/12"]), false);         // o 5 de "15" não conta

// ---------- AEROPORTOS ----------
assert.deepEqual(resolverAeroportos("São Paulo"), ["GRU", "CGH", "VCP"]);
assert.deepEqual(resolverAeroportos("gru"), ["GRU"]);
assert.deepEqual(resolverAeroportos("Rio"), ["GIG", "SDU"]);          // "rio" é cidade, mesmo tendo 3 letras
assert.throws(() => resolverAeroportos("Xique-Xique"), /não conheço/);

// ---------- O CARDÁPIO ----------
assert.equal(ferramentasDaEtapa(false).some((ferramenta) => ferramenta.name === "filtrar_voos"), false);
assert.equal(ferramentasDaEtapa(true).some((ferramenta) => ferramenta.name === "filtrar_voos"), true);
assert.deepEqual(limparArgumentos({ a: null, b: "", c: 0, d: "x" }), { c: 0, d: "x" });

// ---------- AS FERRAMENTAS ----------
// roda a ferramenta do mesmo jeito que o nó "ferramentas" roda
function chamar(nome: string, args: Record<string, any>, caderno: Caderno): Promise<string> {
	const ferramenta: any = todasAsFerramentas.find((opcao) => opcao.name === nome);
	return ferramenta.invoke(limparArgumentos(args), { configurable: { caderno } });
}
function cadernoNovo(textos = ["voos em 12/12 e 20/12"], voos: Voo[] = []): Caderno {
	return { voos, novos: [], buscas: [], textosDoUsuario: textos };
}

let chamadasAoGoogle: string[] = [];
servicos.buscarVoos = (async (origem: string, destino: string, data: string) => {
	chamadasAoGoogle.push(origem);
	if (origem === "CGH") throw new Error("captcha");
	if (origem === "VCP") return [];
	return [{ ...voo, origem, destino, data }, { ...barata, origem, destino, data }];
}) as any;

// a cidade vira três buscas; um aeroporto com erro não derruba os outros
let caderno = cadernoNovo();
let saida = await chamar("buscar_voos", { origem: "São Paulo", destino: "Lisboa", data: "12/12", adultos: "2", criancas: null }, caderno);
assert.deepEqual(chamadasAoGoogle, ["GRU", "CGH", "VCP"]);
assert.match(saida, /Mais barato: R\$ 2000 \| Barata/);
assert.match(saida, /duração 50h00/);                                 // nunca mais em minutos
assert.match(saida, /CGH→LIS em 2026-12-12: erro: captcha/);
assert.match(saida, /VCP→LIS em 2026-12-12: nenhum voo/);
assert.equal(caderno.novos.length, 2);

// a mesma busca repetida não vai ao Google de novo
chamadasAoGoogle = [];
saida = await chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12" }, cadernoNovo(undefined, caderno.voos));
assert.deepEqual(chamadasAoGoogle, ["GRU"]);
const repetido = { ...caderno, buscas: ["GRU|LIS|2026-12-12|1|0|economica"] };
chamadasAoGoogle = [];
saida = await chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12" }, repetido);
assert.deepEqual(chamadasAoGoogle, []);
assert.match(saida, /Mais barato: R\$ 2000/);

// data inventada, argumento errado e limite de buscas
await assert.rejects(chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12" }, cadernoNovo(["quero ir para Lisboa"])), /não aparece no pedido/);
await assert.rejects(chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12", classe: "luxo" }, cadernoNovo()));
saida = await chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12" }, { ...cadernoNovo(), buscas: Array.from({ length: 12 }, (_, i) => String(i)) });
assert.match(saida, /limite de 12 buscas/);

// analisar o que está na memória, sem nenhuma busca
const memoriaDeVoos = [voo, barata];
chamadasAoGoogle = [];
assert.match(await chamar("filtrar_voos", { escalas_maximas: 0 }, cadernoNovo(undefined, memoriaDeVoos)), /1 voos passam[\s\S]*Direta/);
assert.match(await chamar("filtrar_voos", { ordenar_por: "duracao" }, cadernoNovo(undefined, memoriaDeVoos)), /passam no filtro:\nGRU→LIS em 2026-12-12: R\$ 3000 \| Direta/);
assert.match(await chamar("filtrar_voos", { preco_maximo: 10 }, cadernoNovo(undefined, memoriaDeVoos)), /Nenhum dos voos/);
// o gpt-oss:20b mandou tudo com 0 e o filtro respondeu "nenhum voo", o que era mentira
assert.match(await chamar("filtrar_voos", { escalas_maximas: 0, preco_maximo: 0, duracao_maxima_horas: 0, companhia: "", ordenar_por: "" }, cadernoNovo(undefined, memoriaDeVoos)), /1 voos passam[\s\S]*Direta/);
assert.match(await chamar("melhores_voos", {}, cadernoNovo(undefined, memoriaDeVoos)), /Mais barato de todos: .*Barata/);
assert.match(await chamar("listar_pesquisas", {}, cadernoNovo(undefined, memoriaDeVoos)), /GRU→LIS em 2026-12-12: 2 voos/);
assert.deepEqual(chamadasAoGoogle, []);

// ida e volta: a soma é do código
const volta = { ...voo, origem: "LIS", destino: "GRU", data: "2026-12-20", preco: 1500 };
assert.match(await chamar("combinar_ida_e_volta", { origem: "São Paulo", destino: "Lisboa" }, cadernoNovo(undefined, [...memoriaDeVoos, volta])), /Total R\$ 3500/);
assert.match(await chamar("combinar_ida_e_volta", { origem: "GRU", destino: "LIS" }, cadernoNovo(undefined, memoriaDeVoos)), /Falta pesquisar a volta/);
assert.match(await chamar("calcular", { operacao: "divisao", valores: ["3000", 3] }, cadernoNovo()), /Resultado: 1000/);
await assert.rejects(chamar("calcular", { operacao: "divisao", valores: [3000, 0] }, cadernoNovo()), /não tem resultado/);

// dias flexíveis: do mais barato ao mais caro, no máximo 7 dias
chamadasAoGoogle = [];
saida = await chamar("buscar_varios_dias", { origem: "GRU", destino: "LIS", data_inicio: "10/12", data_fim: "25/12" }, cadernoNovo(["de 10/12 a 25/12"]));
assert.equal(chamadasAoGoogle.length, 7);
assert.match(saida, /limite é de 7 dias/);

// o nó grava a hora da pesquisa e não altera o Estado que recebeu (sem a hora, os voos sumiam na mensagem seguinte)
const estadoAntes: any = {
	messages: [new HumanMessage("voos em 12/12"), new AIMessage({ content: "", tool_calls: [{ id: "1", name: "buscar_voos", args: { origem: "GRU", destino: "LIS", data: "12/12" } }] })],
	voos: [], novos: [], buscas: [], pesquisadoEm: 0, passos: 1, tentativas: 0, correcao: "",
};
const depois = await noFerramentas(estadoAntes);
assert.ok(depois.pesquisadoEm > 0);
assert.equal(depois.buscas.length, 1);
assert.equal(estadoAntes.buscas.length, 0);
assert.equal(depois.voos.length, 2);

// a companhia que não venceu nada também aparece na resposta da busca
assert.match(await chamar("melhores_voos", {}, cadernoNovo(undefined, [voo, barata, { ...voo, companhia: "Média", preco: 3500, duracao_min: 900 }])), /Média/);

// ---------- O VERIFICADOR ----------
const fatos = "R$ 2890 | Air Europa | 1 escala(s) | duração 16h40 | sai 10:00 | chega 13/12 02:40\nResultado: 5840\nComprar: https://voos/1\nPedido: meu limite é R$ 4000";
function recusa(texto: string) {
	return verificarResposta(texto, fatos, "https://voos/1").length > 0;
}

// o erro que deu origem a tudo isto
assert.equal(recusa("Air Europa, 10h de viagem"), true);
for (const certo of ["16h40", "16h 40min", "16 horas e 40 minutos", "1000 min"]) assert.equal(recusa("Air Europa: " + certo), false, certo);
assert.equal(recusa("1 escala, 16h40 e 1 voo"), false);

for (const certo of ["R$ 2890", "R$ 2.890", "R$ 2890,00", "R$ 2 890", "2890 reais", "total de R$ 5.840", "até R$ 4000"]) assert.equal(recusa(certo), false, certo);
for (const errado of ["R$ 2800", "R$ 3 mil", "3 mil reais", "R$ 1"]) assert.equal(recusa(errado), true, errado);

assert.equal(recusa("sai 10:00, chega 02:40"), false);
assert.equal(recusa("sai 11:00"), true);
assert.equal(recusa("compre em https://voos/1."), false);
assert.equal(recusa("compre em https://inventado.com/x"), true);
assert.equal(recusa("Vou pesquisar isso para você"), true);
assert.equal(recusa('{"name": "buscar_voos", "arguments": {}}'), true);
assert.equal(recusa("   "), true);
assert.equal(recusa("Oi! Para qual dia?"), false);

assert.equal(arrumarParaSlack("<think>hmm</think>**Oi** e **tchau**\n## Título"), "*Oi* e *tchau*\n*Título*");

console.log("Tudo certo!");
