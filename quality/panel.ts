// panel.ts - um painel no navegador para acompanhar a prova dos 10 mil cenários enquanto ela roda
//
// Lê os arquivos que a prova já escreve (results/<modelo>-10k.jsonl e o .estilo.jsonl ao lado) e mostra numa
// página que se atualiza sozinha a cada 5 segundos. Não mexe na prova: só lê.
//
// Como rodar (dentro da pasta passagens.ts/):   node quality/panel.ts      e abra http://localhost:4400
// Outro modelo:                                 MODELO=gemma4:31b node quality/panel.ts

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import { gerarCenarios } from "./scenarios-10k.ts";
import { rotuloDosModelos } from "../brain/models.ts";

const PORTA = 4400;
const MODELO = rotuloDosModelos();    // o mesmo nome que a prova grava
const PASTA = import.meta.dirname + "/../results";
const ARQUIVO = `${PASTA}/${MODELO.replaceAll(":", "-")}-10k.jsonl`;
const ESTILO = ARQUIVO.replace(/\.jsonl$/, ".estilo.jsonl");
const ANDAMENTO = `${PASTA}/10k-logs/andamento.txt`;

// quantos cenários cada família tem, na ordem em que foram gerados
const familiaDe = (caso: string) => caso.replace(/-\d+$/, "");
const TAMANHOS = [...Map.groupBy(gerarCenarios(), (cenario) => familiaDe(cenario.nome))].map(([familia, lista]) => [familia, lista.length] as const);
const TOTAL = TAMANHOS.reduce((soma, [, tamanho]) => soma + tamanho, 0);

// ---------- LER OS ARQUIVOS ----------
// a prova escreve enquanto o painel lê: a última linha pode estar pela metade, e aí ela fica para a próxima leitura
function lerLinhas(caminho: string): any[] {
	if (!existsSync(caminho)) return [];
	return readFileSync(caminho, "utf8").split("\n").flatMap((linha) => {
		try {
			return linha ? [JSON.parse(linha)] : [];
		} catch {
			return [];
		}
	});
}

function quantosRodando(padrao: string) {
	try {
		return execFileSync("pgrep", ["-f", padrao], { encoding: "utf8" }).trim().split("\n").length;
	} catch {
		return 0;    // o pgrep sai com erro quando não acha nada
	}
}

const media = (numeros: number[]) => (numeros.length ? numeros.reduce((soma, numero) => soma + numero, 0) / numeros.length : 0);
function percentil(numeros: number[], fracao: number) {
	const ordenados = numeros.toSorted((a, b) => a - b);
	return ordenados.length ? ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * fracao))] : 0;
}

// ---------- O RESUMO QUE A PÁGINA MOSTRA ----------
function resumir() {
	// a segunda passada roda de novo o que deu erro: vale o último resultado de cada cenário
	const ultimos = new Map(lerLinhas(ARQUIVO).map((linha) => [linha.caso, linha]));
	const casos = [...ultimos.values()];
	const feitos = casos.filter((caso) => !caso.erro);
	const erros = casos.filter((caso) => caso.erro);
	const falhas = feitos.filter((caso) => !caso.passou);

	// a conversa guarda a hora em que o cenário começou; somando a duração, sai a hora em que terminou
	const terminouEm = (caso: any) => Number(String(caso.conversa ?? "").split(" ").at(-1)) + caso.segundos * 1000;
	const agora = Date.now();
	// o ritmo dos últimos 10 minutos, dividido pelo tempo que eles cobrem de verdade: no começo da rodada são menos de 10
	const ultimosDezMinutos = feitos.map(terminouEm).filter((quando) => agora - quando < 10 * 60 * 1000);
	const minutosCobertos = ultimosDezMinutos.length ? Math.max(1, (agora - Math.min(...ultimosDezMinutos)) / 60_000) : 1;
	const porMinuto = ultimosDezMinutos.length / minutosCobertos;
	const recentes = feitos.toSorted((a, b) => terminouEm(b) - terminouEm(a));

	// o tipo de problema: o começo da frase, sem números ("não citou 3107.5" e "não citou 2890" são o mesmo tipo)
	const tipos = Map.groupBy(falhas.flatMap((caso) => caso.problemas as string[]), (problema) => problema.replace(/^\[dados\] /, "").split(/[:;{]/)[0].replace(/\d[\d.,]*/g, "N").trim().slice(0, 60));

	const segundos = feitos.map((caso) => caso.segundos);
	const julgados = [...new Map(lerLinhas(ESTILO).map((linha) => [linha.caso, linha])).values()];
	const regras = Map.groupBy(julgados.flatMap((linha) => linha.problemas), (problema: any) => problema.regra);

	return {
		modelo: MODELO,
		total: TOTAL,
		feitos: feitos.length,
		passou: feitos.length - falhas.length,
		falhou: falhas.length,
		erros: erros.length,
		porMinuto,
		minutosParaAcabar: porMinuto > 0 ? (TOTAL - feitos.length) / porMinuto : null,
		tempo: { media: media(segundos), mediana: percentil(segundos, 0.5), p90: percentil(segundos, 0.9) },
		rodando: { provas: quantosRodando("quality/exam.ts"), juizes: quantosRodando("quality/style-judge.ts") },
		andamento: existsSync(ANDAMENTO) ? readFileSync(ANDAMENTO, "utf8").trim().split("\n") : [],
		familias: TAMANHOS.map(([familia, tamanho]) => {
			const daFamilia = feitos.filter((caso) => familiaDe(caso.caso) === familia);
			return { familia, tamanho, feitos: daFamilia.length, passou: daFamilia.filter((caso) => caso.passou).length };
		}),
		recentes: recentes.slice(0, 14).map((caso) => ({ caso: caso.caso, passou: caso.passou, segundos: caso.segundos, mensagem: caso.mensagens.at(-1) })),
		falhas: falhas.toSorted((a, b) => terminouEm(b) - terminouEm(a)).slice(0, 40).map((caso) => ({ caso: caso.caso, segundos: caso.segundos, mensagens: caso.mensagens, problemas: caso.problemas, resposta: String(caso.resposta).slice(0, 600) })),
		tiposDeFalha: [...tipos].map(([tipo, lista]) => ({ tipo, quantos: lista.length })).toSorted((a, b) => b.quantos - a.quantos).slice(0, 8),
		ultimosErros: erros.slice(-4).map((caso) => ({ caso: caso.caso, erro: String(caso.erro).slice(0, 160) })),
		escrita: julgados.length === 0 ? null : {
			julgados: julgados.length,
			media: media(julgados.map((linha) => linha.nota)),
			porNota: [5, 4, 3, 2, 1].map((nota) => ({ nota, quantos: julgados.filter((linha) => linha.nota === nota).length })),
			regras: [...regras].map(([regra, lista]) => ({ regra, quantos: lista.length })).toSorted((a, b) => b.quantos - a.quantos).slice(0, 8),
		},
	};
}

// ---------- A PÁGINA ----------
const PAGINA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prova dos 10 mil</title>
<style>
/* uma coluna de cartões: o número grande em cima, o detalhe embaixo */
:root {
	--fundo: #f4f6f9; --cartao: #ffffff; --texto: #151a23; --fraco: #5d6878; --linha: #dde3ea;
	--bom: #0f7b55; --bom-claro: #ddf2e9; --ruim: #c0392b; --ruim-claro: #fbe4e1; --aviso: #a86400; --barra: #e7ecf2;
	--mono: ui-monospace, "SF Mono", Menlo, monospace; --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
	:root { --fundo: #0f1218; --cartao: #171c24; --texto: #e6e9ee; --fraco: #98a2b0; --linha: #2a313c;
		--bom: #3fcf98; --bom-claro: #12302a; --ruim: #ff7b6e; --ruim-claro: #3a1d1a; --aviso: #ffb547; --barra: #222a35; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--fundo); color: var(--texto); font: 15px/1.5 var(--sans); padding: 24px max(16px, 3vw) 48px; }
main { max-width: 1180px; margin: 0 auto; display: grid; gap: 18px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; }
h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--fraco); font-weight: 600; }
.cartao { background: var(--cartao); border: 1px solid var(--linha); border-radius: 10px; padding: 16px 18px; min-width: 0; }
.vivo { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fraco); }
.ponto { width: 9px; height: 9px; border-radius: 50%; background: var(--fraco); }
.ponto.ligado { background: var(--bom); animation: pulsar 1.6s infinite; }
@keyframes pulsar { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .ponto.ligado { animation: none; } }
.barra { height: 14px; background: var(--barra); border-radius: 7px; overflow: hidden; display: flex; }
.barra i { display: block; height: 100%; }
.barra .ok { background: var(--bom); } .barra .no { background: var(--ruim); } .barra .er { background: var(--aviso); }
.grande { font-size: 34px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.numeros { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 14px; }
.numero b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.numero span { font-size: 12.5px; color: var(--fraco); }
.colunas { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
td, th { padding: 6px 4px; border-bottom: 1px solid var(--linha); text-align: left; vertical-align: middle; }
th { font-size: 11.5px; color: var(--fraco); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
tr:last-child td { border-bottom: 0; }
td.mini { width: 38%; }
td.mini .barra { height: 8px; }
.direita { text-align: right; }
.feed li, .tipos li { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--linha); font-size: 13.5px; min-width: 0; }
.feed li:last-child, .tipos li:last-child { border-bottom: 0; }
ul { list-style: none; margin: 0; padding: 0; }
.marca { font: 600 11px var(--mono); padding: 2px 6px; border-radius: 4px; flex: none; }
.marca.ok { background: var(--bom-claro); color: var(--bom); } .marca.no { background: var(--ruim-claro); color: var(--ruim); }
.caso { font-family: var(--mono); font-size: 12.5px; flex: none; }
.msg { color: var(--fraco); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.seg { font-family: var(--mono); font-size: 12px; color: var(--fraco); flex: none; }
details { border-bottom: 1px solid var(--linha); padding: 8px 0; }
details:last-child { border-bottom: 0; }
summary { cursor: pointer; display: flex; gap: 10px; align-items: baseline; min-width: 0; }
summary .msg { white-space: nowrap; }
.detalhe { margin: 8px 0 2px; display: grid; gap: 6px; font-size: 13px; }
.detalhe .problema { color: var(--ruim); }
.detalhe pre { margin: 0; white-space: pre-wrap; font: 12.5px/1.45 var(--mono); background: var(--fundo); padding: 8px 10px; border-radius: 6px; overflow-wrap: anywhere; }
.vazio { color: var(--fraco); font-size: 13.5px; }
.tipos b { font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; color: var(--ruim); }
.andamento { font: 12.5px var(--mono); color: var(--fraco); }
</style>
</head>
<body>
<main>
	<header>
		<h1>Prova dos 10 mil <span id="modelo" class="vivo"></span></h1>
		<span class="vivo"><i id="ponto" class="ponto"></i><span id="rodando">carregando…</span></span>
	</header>

	<section class="cartao">
		<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
			<div class="grande" id="progresso">–</div>
			<div class="vivo" id="previsao"></div>
		</div>
		<div class="barra" style="margin-top:10px" id="barra"></div>
		<div class="numeros" id="numeros"></div>
	</section>

	<div class="colunas">
		<section class="cartao"><h2>Por família</h2><table><thead><tr><th>Família</th><th class="direita">Feitos</th><th class="direita">Passou</th><th></th></tr></thead><tbody id="familias"></tbody></table></section>
		<section class="cartao"><h2>Acabaram agora</h2><ul class="feed" id="recentes"></ul></section>
	</div>

	<div class="colunas">
		<section class="cartao"><h2>Tipos de falha</h2><ul class="tipos" id="tipos"></ul></section>
		<section class="cartao"><h2>Escrita (juiz)</h2><div id="escrita"></div></section>
	</div>

	<section class="cartao"><h2>Falhas mais recentes (clique para ver)</h2><div id="falhas"></div></section>
	<section class="cartao"><h2>Andamento</h2><div class="andamento" id="andamento"></div></section>
</main>
<script>
// os textos vêm das conversas da prova: nada entra na página como HTML
const esc = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (parte, todo) => (todo ? (100 * parte / todo).toFixed(1) : "0.0") + "%";
const abertas = new Set();    // as falhas que você abriu continuam abertas depois da atualização

function tempo(minutos) {
	if (minutos === null) return "calculando…";
	const horas = Math.floor(minutos / 60), resto = Math.round(minutos % 60);
	return horas > 0 ? horas + " h " + resto + " min" : resto + " min";
}

function desenhar(d) {
	document.getElementById("modelo").textContent = d.modelo;
	const ativo = d.rodando.provas > 0 || d.rodando.juizes > 0;
	document.getElementById("ponto").className = "ponto" + (ativo ? " ligado" : "");
	document.getElementById("rodando").textContent = d.rodando.provas > 0 ? d.rodando.provas + " provas rodando" : d.rodando.juizes > 0 ? d.rodando.juizes + " juízes de escrita rodando" : "nada rodando";

	document.getElementById("progresso").textContent = d.feitos.toLocaleString("pt-BR") + " de " + d.total.toLocaleString("pt-BR");
	document.getElementById("previsao").textContent = d.feitos >= d.total ? "terminou" : d.porMinuto > 0 ? "acaba em " + tempo(d.minutosParaAcabar) + " (" + d.porMinuto.toFixed(1) + " por minuto)" : "esperando o primeiro resultado";
	document.getElementById("barra").innerHTML = '<i class="ok" style="width:' + pct(d.passou, d.total) + '"></i><i class="no" style="width:' + pct(d.falhou, d.total) + '"></i><i class="er" style="width:' + pct(d.erros, d.total) + '"></i>';
	const numeros = [
		[d.passou.toLocaleString("pt-BR"), "passaram (" + pct(d.passou, d.feitos) + ")"],
		[d.falhou.toLocaleString("pt-BR"), "falharam"],
		[d.erros.toLocaleString("pt-BR"), "pararam por erro (rodam de novo)"],
		[Math.round(d.tempo.media) + " s", "tempo médio por cenário"],
		[d.tempo.mediana + " s · " + d.tempo.p90 + " s", "mediana · 9 em cada 10 abaixo de"],
	];
	document.getElementById("numeros").innerHTML = numeros.map(([valor, rotulo]) => '<div class="numero"><b>' + esc(valor) + '</b><span>' + esc(rotulo) + '</span></div>').join("");

	document.getElementById("familias").innerHTML = d.familias.map((f) => {
		const falhou = f.feitos - f.passou;
		return '<tr><td class="caso">' + esc(f.familia) + '</td><td class="direita">' + f.feitos + '/' + f.tamanho + '</td><td class="direita">' + (f.feitos ? pct(f.passou, f.feitos) : "–") +
			'</td><td class="mini"><div class="barra"><i class="ok" style="width:' + pct(f.passou, f.tamanho) + '"></i><i class="no" style="width:' + pct(falhou, f.tamanho) + '"></i></div></td></tr>';
	}).join("");

	document.getElementById("recentes").innerHTML = d.recentes.length ? d.recentes.map((r) => '<li><span class="marca ' + (r.passou ? "ok" : "no") + '">' + (r.passou ? "PASSOU" : "FALHOU") + '</span><span class="caso">' + esc(r.caso) + '</span><span class="msg">' + esc(r.mensagem) + '</span><span class="seg">' + r.segundos + 's</span></li>').join("") : '<li class="vazio">nada ainda</li>';

	document.getElementById("tipos").innerHTML = d.tiposDeFalha.length ? d.tiposDeFalha.map((t) => '<li><b>' + t.quantos + '</b><span>' + esc(t.tipo) + '</span></li>').join("") : '<li class="vazio">nenhuma falha até agora</li>';

	const e = d.escrita;
	document.getElementById("escrita").innerHTML = !e ? '<p class="vazio">O juiz de escrita roda quando as provas terminarem.</p>' :
		'<div class="grande">' + e.media.toFixed(2) + ' <span class="vivo">de 5, em ' + e.julgados + ' respostas</span></div>' +
		'<div class="barra" style="margin:10px 0 14px">' + e.porNota.map((n, i) => '<i style="width:' + pct(n.quantos, e.julgados) + ';background:' + ["var(--bom)", "#5fb98f", "var(--aviso)", "#e07a5f", "var(--ruim)"][i] + '" title="nota ' + n.nota + ': ' + n.quantos + '"></i>').join("") + '</div>' +
		'<ul class="tipos">' + e.regras.map((r) => '<li><b>' + r.quantos + '</b><span>' + esc(r.regra) + '</span></li>').join("") + '</ul>';

	document.getElementById("falhas").innerHTML = d.falhas.length ? d.falhas.map((f) =>
		'<details data-caso="' + esc(f.caso) + '"' + (abertas.has(f.caso) ? " open" : "") + '><summary><span class="marca no">FALHOU</span><span class="caso">' + esc(f.caso) + '</span><span class="msg">' + esc(f.mensagens.join("  ⟶  ")) + '</span><span class="seg">' + f.segundos + 's</span></summary>' +
		'<div class="detalhe">' + f.problemas.map((p) => '<div class="problema">• ' + esc(p) + '</div>').join("") + '<pre>' + esc(f.resposta) + '</pre></div></details>'
	).join("") : '<p class="vazio">nenhuma falha até agora</p>';
	for (const item of document.querySelectorAll("#falhas details")) item.addEventListener("toggle", () => item.open ? abertas.add(item.dataset.caso) : abertas.delete(item.dataset.caso));

	const erros = d.ultimosErros.map((x) => "erro em " + x.caso + ": " + x.erro);
	document.getElementById("andamento").innerHTML = [...d.andamento, ...erros].map(esc).join("<br>") || "—";
}

async function atualizar() {
	try {
		desenhar(await (await fetch("/dados")).json());
	} catch {
		document.getElementById("rodando").textContent = "o painel perdeu a conexão: o node quality/panel.ts ainda está rodando?";
		document.getElementById("ponto").className = "ponto";
	}
}
atualizar();
setInterval(atualizar, 5000);
</script>
</body>
</html>`;

// ---------- O SERVIDOR ----------
// só escuta no próprio Mac (127.0.0.1): ninguém na rede vê o painel
createServer((pedido, resposta) => {
	if (pedido.url === "/dados") {
		resposta.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		resposta.end(JSON.stringify(resumir()));
		return;
	}
	resposta.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	resposta.end(PAGINA);
}).listen(PORTA, "127.0.0.1", () => console.log(`Painel em http://localhost:${PORTA}  (Ctrl+C para fechar)`));
