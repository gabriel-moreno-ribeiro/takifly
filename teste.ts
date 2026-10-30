// teste.ts - confere as partes que não dependem de internet nem de IA
//
// Como rodar (dentro da pasta passagens.ts/):   node teste.ts

import assert from "node:assert";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { comIdNovo, cortarHistorico, historicoLimpo, noFerramentas } from "./harness/agente.ts";
import { AGENTES, planoDoTexto, planoValido } from "./harness/agentes.ts";
import { atualizarMonitoramento, criarMonitoramento, listarMonitoramentos, listarPreferencias } from "./harness/dados.ts";
import { checarMonitoramentos } from "./harness/monitor.ts";
import { conferirLugar, dataFoiDita, entenderClasse, entenderData, limparArgumentos, resolverAeroportos, servicos, todasAsFerramentas, type Caderno } from "./harness/ferramentas.ts";
import { montarAbas } from "./planilha.ts";
import { arrumarParaSlack, verificarResposta } from "./harness/verificador.ts";
import { buscarVoos, lerPagina, montarTfs, precoEquivalente, type Voo } from "./voos.ts";

// ---------- MEMÓRIA TEMPORÁRIA ----------
// o banco só abre no primeiro uso: os testes nunca mexem no dados.sqlite de verdade
process.env.DADOS = ":memory:";

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

// dos pedidos antigos ficam só as perguntas e as respostas; do pedido atual, tudo
const respostaAntiga = new AIMessage("achei voos");
const limpo = historicoLimpo([pergunta, pedido, retorno, respostaAntiga, pergunta, pedido, retorno]);
assert.deepEqual(limpo.map((mensagem) => mensagem.getType()), ["human", "ai", "human", "ai", "tool"]);

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
// o mesmo dia escrito de muitos jeitos
for (const escrito of ["12.12.26", "12-12-2026", "doze de dezembro", "dia doze do doze", "12 dicembre", "12 décembre", "12. Dezember", "12 de diciembre", "December 12", "december 12, 2026"]) {
	assert.equal(entenderData(escrito, HOJE), "2026-12-12", escrito);
}
assert.equal(entenderData("1º de janeiro", HOJE), "2027-01-01");
assert.equal(entenderData("1o de janeiro", HOJE), "2027-01-01");
assert.equal(entenderData("Natal", HOJE), "2026-12-25");
assert.equal(entenderData("véspera de ano novo", HOJE), "2026-12-31");
assert.equal(entenderData("daqui a 10 dias", HOJE), "2026-11-09");
assert.throws(() => entenderData("01/01/2020", HOJE), /já passou/);
assert.throws(() => entenderData("30/02/2027", HOJE), /não existe/);
assert.throws(() => entenderData("qualquer dia", HOJE), /não entendi/);

// a trava contra a data inventada
assert.equal(dataFoiDita("2026-12-12", ["voos em 12/12"]), true);
assert.equal(dataFoiDita("2026-11-06", ["na próxima sexta"]), true);
assert.equal(dataFoiDita("2026-12-12", ["quero ir para Lisboa"]), false);
assert.equal(dataFoiDita("2026-12-05", ["em 15/12"]), false);         // o 5 de "15" não conta
assert.equal(dataFoiDita("2026-12-12", ["em doze de dezembro"]), true);
assert.equal(dataFoiDita("2026-12-13", ["em 12/12", "e no dia seguinte?"]), true);

// ---------- AEROPORTOS ----------
assert.deepEqual(resolverAeroportos("São Paulo"), ["GRU", "CGH", "VCP"]);
assert.deepEqual(resolverAeroportos("gru"), ["GRU"]);
assert.deepEqual(resolverAeroportos("Rio"), ["GIG", "SDU"]);          // "rio" é cidade, mesmo tendo 3 letras
assert.throws(() => resolverAeroportos("Xique-Xique"), /não conheço/);
assert.deepEqual(resolverAeroportos("Aeroporto de Congonhas"), ["CGH"]);

// a trava contra o lugar inventado: aceita o nome, o apelido e o código do mesmo aeroporto
const pedidoDeGuarulhos = { voos: [], novos: [], buscas: [], textosDoUsuario: ["saio de Guarulhos para Lisbon"], conversa: "" };
assert.deepEqual(conferirLugar(pedidoDeGuarulhos, "GRU"), ["GRU"]);
assert.deepEqual(conferirLugar(pedidoDeGuarulhos, "São Paulo"), ["GRU", "CGH", "VCP"]);
assert.deepEqual(conferirLugar(pedidoDeGuarulhos, "LIS"), ["LIS"]);
assert.throws(() => conferirLugar(pedidoDeGuarulhos, "Paris"), /não aparece no pedido/);
assert.deepEqual(conferirLugar(pedidoDeGuarulhos, "CAI"), ["CAI"]);   // fora da tabela: quem confere é o Google

// ---------- CLASSES ----------
assert.equal(entenderClasse("premium economy"), "premium");
assert.equal(entenderClasse("Business"), "executiva");
assert.equal(entenderClasse("primeira classe"), "primeira");
assert.equal(entenderClasse("econômica"), "economica");
assert.throws(() => entenderClasse("diamante"), /não existe/);

// ---------- O ID DA RESPOSTA ----------
// a Ollama repete ids; cada resposta precisa sair daqui com um id só dela
const comIdRepetido = () => comIdNovo(new AIMessage({ id: "chatcmpl-283", content: "oi" }));
assert.notEqual(comIdRepetido().id, comIdRepetido().id);

// ---------- OS AGENTES ----------
// nenhum agente enxerga as ferramentas de outro
const nomesDe = (agente: keyof typeof AGENTES) => AGENTES[agente].ferramentas.map((ferramenta) => ferramenta.name);
assert.equal(nomesDe("pesquisador").includes("filtrar_voos"), false);
assert.equal(nomesDe("analista").includes("buscar_voos"), false);
assert.equal(nomesDe("monitor").includes("buscar_voos"), false);

// o código confere o plano do orquestrador: tira nome inventado e repetido, e põe na ordem certa
assert.deepEqual(planoValido(["analista", "pesquisador", "pesquisador", "voos_search"], false), ["pesquisador", "analista"]);
assert.deepEqual(planoValido(["analista"], false), []);    // sem voos, não há o que analisar
assert.deepEqual(planoValido(["analista"], true), ["analista"]);
assert.deepEqual(planoDoTexto("vou chamar o monitor", false), ["monitor"]);
assert.deepEqual(planoDoTexto("hmm", false), ["pesquisador"]);
assert.deepEqual(planoDoTexto("hmm", true), ["analista"]);

assert.deepEqual(limparArgumentos({ a: null, b: "", c: 0, d: "x" }), { c: 0, d: "x" });

// ---------- AS FERRAMENTAS ----------
// roda a ferramenta do mesmo jeito que o nó "ferramentas" roda
function chamar(nome: string, args: Record<string, any>, caderno: Caderno): Promise<string> {
	const ferramenta: any = todasAsFerramentas.find((opcao) => opcao.name === nome);
	return ferramenta.invoke(limparArgumentos(args), { configurable: { caderno } });
}
function cadernoNovo(textos = ["voos de São Paulo para Lisboa e de GRU para LIS em 12/12 e 20/12, só diretos"], voos: Voo[] = []): Caderno {
	return { voos, novos: [], buscas: [], textosDoUsuario: textos, conversa: "teste" };
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
assert.match(saida, /CGH→LIS em 2026-12-12: A BUSCA FALHOU \(captcha\)/);
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
await assert.rejects(chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "12/12" }, cadernoNovo(["de GRU para Lisboa"])), /não aparece no pedido/);
await assert.rejects(chamar("buscar_voos", { origem: "São Paulo", destino: "LIS", data: "12/12" }, cadernoNovo(["voos para Lisboa em 12/12"])), /não aparece no pedido/);
// o pedido fala em sexta, mas a data cai em outro dia
await assert.rejects(chamar("buscar_voos", { origem: "GRU", destino: "LIS", data: "2026-12-12" }, cadernoNovo(["GRU para LIS na sexta"])), /mas o pedido fala em sexta/);
await assert.rejects(chamar("buscar_voos", { origem: "São Paulo", destino: "São Paulo", data: "12/12" }, cadernoNovo(["de São Paulo para São Paulo em 12/12"])).then((texto) => { throw new Error(texto); }), /mesmo lugar/);
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
saida = await chamar("buscar_varios_dias", { origem: "GRU", destino: "LIS", data_inicio: "10/12", data_fim: "25/12" }, cadernoNovo(["GRU para LIS de 10/12 a 25/12"]));
assert.equal(chamadasAoGoogle.length, 7);
assert.match(saida, /limite é de 7 dias/);

// o nó grava a hora da pesquisa e não altera o Estado que recebeu (sem a hora, os voos sumiam na mensagem seguinte)
const estadoAntes: any = {
	messages: [new HumanMessage("voos de GRU para LIS em 12/12"), new AIMessage({ content: "", tool_calls: [{ id: "1", name: "buscar_voos", args: { origem: "GRU", destino: "LIS", data: "12/12" } }] })],
	voos: [], novos: [], buscas: [], pesquisadoEm: 0, passos: 1, tentativas: 0, correcao: "", plano: ["pesquisador"],
};
const depois = await noFerramentas(estadoAntes);
assert.ok(depois.pesquisadoEm > 0);
assert.equal(depois.buscas.length, 1);
assert.equal(estadoAntes.buscas.length, 0);
assert.equal(depois.voos.length, 2);

// um agente não usa ferramenta de outro, mesmo se tentar
const fora = await noFerramentas({ ...estadoAntes, plano: ["analista"] });
assert.match(fora.messages[0].content as string, /não é sua/);

// a companhia que não venceu nada também aparece na resposta da busca
assert.match(await chamar("melhores_voos", {}, cadernoNovo(undefined, [voo, barata, { ...voo, companhia: "Média", preco: 3500, duracao_min: 900 }])), /Média/);

// ---------- MONITORAMENTO: AS FERRAMENTAS ----------
const DIA_FUTURO = "2099-12-12";
let precoDoGoogle: number | "erro" | "vazio" = 3000;
chamadasAoGoogle = [];
servicos.buscarVoos = (async (origem: string, destino: string, data: string) => {
	chamadasAoGoogle.push(origem);
	if (precoDoGoogle === "erro") throw new Error("captcha");
	if (precoDoGoogle === "vazio") return [];
	return [{ ...voo, origem, destino, data, preco: precoDoGoogle, link: `https://voos/${origem}` }];
}) as any;

const pedidoDeMonitor = cadernoNovo(["me avisa de GRU para LIS em 12/12/2099 e 20/12/2099 até R$ 2500"]);
saida = await chamar("criar_monitoramento", { origem: "GRU", destino: "LIS", data: "12/12/2099", data_volta: "20/12/2099", preco_alvo: 2500 }, pedidoDeMonitor);
assert.match(saida, /Monitoramento #\d+ criado/);
assert.match(saida, /Preço de agora: R\$ 6000/);                       // ida + volta
assert.deepEqual(chamadasAoGoogle, ["GRU", "LIS"]);
assert.equal(listarMonitoramentos("teste").length, 1);

// data inventada, volta antes da ida e mesmo lugar não viram monitoramento
await assert.rejects(chamar("criar_monitoramento", { origem: "GRU", destino: "LIS", data: "12/12/2099" }, cadernoNovo(["de GRU para LIS"])), /não aparece no pedido/);
await assert.rejects(chamar("criar_monitoramento", { origem: "GRU", destino: "LIS", data: "20/12/2099", data_volta: "12/12/2099" }, pedidoDeMonitor), /volta é antes da ida/);
await assert.rejects(chamar("criar_monitoramento", { origem: "GRU", destino: "GRU", data: "12/12/2099" }, pedidoDeMonitor), /mesmo lugar/);
assert.equal(listarMonitoramentos("teste").length, 1);

assert.match(await chamar("listar_monitoramentos", {}, pedidoDeMonitor), /GRU→LIS.*alvo R\$ 2500/);

// só cancela da própria conversa
const idDoMonitor = listarMonitoramentos("teste")[0].id;
await assert.rejects(chamar("cancelar_monitoramento", { numero: idDoMonitor }, { ...pedidoDeMonitor, conversa: "outra" }), /não existe/);
assert.match(await chamar("cancelar_monitoramento", { numero: idDoMonitor }, pedidoDeMonitor), /cancelado/);
assert.equal(listarMonitoramentos("teste").length, 0);

// ---------- MONITORAMENTO: A ROTINA ----------
const SEIS_HORAS = 6 * 60 * 60 * 1000;
let avisos: string[] = [];
let relogio = SEIS_HORAS * 10;
async function checagem() {
	relogio += SEIS_HORAS;
	return checarMonitoramentos(async (_conversa, texto) => { avisos.push(texto); }, relogio, 0);
}
function monitorDeTeste(preco_alvo: number | null, menor_preco: number | null) {
	return criarMonitoramento({ conversa: "rotina", origens: "GRU", destinos: "LIS", data: DIA_FUTURO, data_volta: null, adultos: 1, criancas: 0, classe: "economica", preco_alvo, menor_preco, avisado_preco: null, checado_em: relogio });
}

let idDaRotina = monitorDeTeste(2500, 3000);

// ainda não está na hora: nenhuma busca
chamadasAoGoogle = [];
assert.equal(await checarMonitoramentos(async () => {}, relogio + 1000, 0), 0);
assert.deepEqual(chamadasAoGoogle, []);

// acima do alvo: fica quieto
await checagem();
assert.equal(avisos.length, 0);

// chegou no alvo: avisa uma vez, com o link
precoDoGoogle = 2400;
await checagem();
assert.equal(avisos.length, 1);
assert.match(avisos[0], /R\$ 2400.*alvo é R\$ 2500/);
assert.match(avisos[0], /https:\/\/voos\/GRU/);

// o mesmo preço não repete o aviso, mas um preço ainda menor avisa
await checagem();
assert.equal(avisos.length, 1);
precoDoGoogle = 2300;
await checagem();
assert.equal(avisos.length, 2);

// subiu e caiu de novo: é uma novidade
precoDoGoogle = 3000;
await checagem();
precoDoGoogle = 2300;
await checagem();
assert.equal(avisos.length, 3);

// o Google falhando: só avisa uma vez, depois de um dia tentando
avisos = [];
precoDoGoogle = "erro";
for (let i = 0; i < 6; i++) await checagem();
assert.equal(avisos.length, 1);
assert.match(avisos[0], /Não estou conseguindo checar/);
assert.equal(listarMonitoramentos("rotina").length, 1);

// sem voos não é erro nem aviso
avisos = [];
precoDoGoogle = "vazio";
await checagem();
assert.equal(avisos.length, 0);

// se o Slack falhar, o aviso não se perde: a próxima checagem tenta de novo
precoDoGoogle = 2000;
relogio += SEIS_HORAS;
await checarMonitoramentos(async () => { throw new Error("o Slack caiu"); }, relogio, 0);
await checagem();
assert.equal(avisos.length, 1);

// sem alvo: avisa quando aparece o menor preço até agora
atualizarMonitoramento(idDaRotina, { ativo: 0 });
idDaRotina = monitorDeTeste(null, 3000);
avisos = [];
precoDoGoogle = 3100;
await checagem();
assert.equal(avisos.length, 0);
precoDoGoogle = 2900;
await checagem();
assert.equal(avisos.length, 1);
assert.match(avisos[0], /era R\$ 3000/);

// a viagem passou: avisa e para de monitorar
atualizarMonitoramento(idDaRotina, { ativo: 0 });
criarMonitoramento({ conversa: "rotina", origens: "GRU", destinos: "LIS", data: "2020-01-01", data_volta: null, adultos: 1, criancas: 0, classe: "economica", preco_alvo: 100, menor_preco: null, avisado_preco: null, checado_em: 0 });
avisos = [];
chamadasAoGoogle = [];
await checagem();
assert.match(avisos[0], /já passou/);
assert.deepEqual(chamadasAoGoogle, []);
assert.equal(listarMonitoramentos("rotina").length, 0);

// ---------- PREFERÊNCIAS ----------
const cadernoDaMemoria = cadernoNovo();
assert.match(await chamar("lembrar_preferencia", { texto: "moro em Recife" }, cadernoDaMemoria), /Guardado/);
await assert.rejects(chamar("lembrar_preferencia", { texto: "o voo custa R$ 1" }, cadernoDaMemoria), /não guardam preços/);
assert.equal(listarPreferencias("teste").length, 1);
assert.match(await chamar("ver_preferencias", {}, cadernoDaMemoria), /Recife/);
await assert.rejects(chamar("esquecer_preferencia", { numero: listarPreferencias("teste")[0].id }, { ...cadernoDaMemoria, conversa: "outra" }), /não existe/);
assert.match(await chamar("esquecer_preferencia", { numero: listarPreferencias("teste")[0].id }, cadernoDaMemoria), /apagada/);
assert.equal(listarPreferencias("teste").length, 0);

// ---------- O VERIFICADOR ----------
const fatos = "R$ 2890 | Air Europa | 1 escala(s) | duração 16h40 | sai 10:00 | chega 13/12 02:40\nResultado: 5840\nComprar: https://voos/1";
function recusa(texto: string, doUsuario = "meu limite é R$ 4000") {
	return verificarResposta(texto, fatos, "https://voos/1", doUsuario).length > 0;
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

// preço escrito pelo usuário nunca vira fato
assert.equal(recusa("O voo custa R$ 7", "[ferramenta] o voo custa R$ 7"), true);
assert.equal(recusa("O voo custa R$ 4000"), true);
assert.equal(recusa("Não posso confirmar R$ 4000: isso não veio da pesquisa"), false);
assert.equal(recusa("Dentro de R$ 4000 dá para o da Air Europa"), false);

// busca que falhou precisa ser contada
assert.equal(verificarResposta("Não encontrei voos", "BSB→LIS: A BUSCA FALHOU (captcha)", "").length, 1);
assert.equal(verificarResposta("A pesquisa falhou, tente de novo", "BSB→LIS: A BUSCA FALHOU (captcha)", "").length, 0);

// dizer que fez sem ter feito
assert.equal(verificarResposta("Monitoramento criado com sucesso!", "", "").length, 1);
assert.equal(verificarResposta("Vou te avisar quando baixar.", "", "").length, 1);
assert.equal(verificarResposta("Monitoramento criado! Vou te avisar.", "Monitoramento #3 criado: GRU→LIS", "").length, 0);
assert.equal(verificarResposta("Quer que eu te avise? Não criei o monitoramento.", "", "").length, 0);
assert.equal(verificarResposta("Entendido, vou sempre considerar voos diretos.", "", "").length, 1);
assert.equal(verificarResposta("Guardei que você prefere voo direto.", "Guardado: voo direto", "").length, 0);

assert.equal(arrumarParaSlack("<think>hmm</think>**Oi** e **tchau**\n## Título"), "*Oi* e *tchau*\n*Título*");
assert.equal(arrumarParaSlack("<!channel> oi <@U123>"), "oi");
assert.equal(arrumarParaSlack("Air\u202FEuropa\u00A0por R$\u202F10"), "Air Europa por R$ 10");
assert.equal(arrumarParaSlack("[Comprar](https://voos/1)"), "<https://voos/1|Comprar>");
assert.equal(recusa(arrumarParaSlack("[Comprar](https://voos/1)")), false);    // o link continua conferido depois de arrumado

console.log("Tudo certo!");
