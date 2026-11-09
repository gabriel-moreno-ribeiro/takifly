// style-judge.ts - um modelo bom lê as respostas da prova e dá nota para a ESCRITA: clareza e tom
//
// Ele não confere fatos: preço, link e horário quem confere é o código (brain/checker.ts e os juízes do exam.ts).
// Aqui a pergunta é outra: a resposta está clara, curta e soa como uma pessoa, ou soa como um chatbot?
// As regras vêm do humanizer (github.com/blader/humanizer), escolhidas para mensagem curta de Slack.
//
// Roda FORA do caminho da mensagem: lê o que a prova já gravou em results/, então não atrasa nenhuma resposta do bot.
//
// Como rodar (dentro da pasta passagens.ts/):
//   node quality/style-judge.ts                               julga results/glm-5.3.jsonl
//   node quality/style-judge.ts results/glm-5.3-10k.jsonl     julga outro arquivo da prova
//   JUIZ=gpt-oss:120b node quality/style-judge.ts             usa outro modelo como juiz
//   PARTE=2/4 node quality/style-judge.ts                     só a 2ª de 4 partes (para rodar vários ao mesmo tempo)
//   node quality/style-judge.ts --teste                       confere o juiz com duas respostas conhecidas
//
// Grava ao lado do arquivo julgado, trocando .jsonl por .estilo.jsonl. Rodar de novo pula o que já foi julgado.

import { appendFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { rotuloDosModelos } from "../brain/models.ts";

process.loadEnvFile(import.meta.dirname + "/../.env");
const { anotar, enviarRastreio } = await import("../brain/tracing.ts");

// ---------- AS REGRAS ----------
// a chave é o que o juiz devolve; o texto é o que ele lê para decidir
export const REGRAS = {
	enrolacao: "enrola antes do fato: 'Claro!', 'Ótima pergunta', 'Tudo tranquilo por aqui:', abertura que não diz nada",
	fecho_de_efeito: "termina com frase de efeito ou oferta vazia: 'Espero ter ajudado', 'Se quiser, posso...', 'Qualquer coisa é só chamar'",
	repete_o_obvio: "explica de novo o que a pessoa já sabe, ou conta como chegou na resposta",
	pecas_de_dentro: "fala das peças internas do bot: ferramenta, recado, agente, verificador, sistema, plano. Monitoramento, alerta, pesquisa e planilha NÃO são peças de dentro: são coisas que a pessoa pede pelo nome",
	confusa: "frase longa ou confusa, que precisa ser lida duas vezes para entender",
	negrito_decorativo: "negrito numa frase inteira ou numa palavra que não é o número que decide",
	palavra_inflada: "palavra inflada ou de vendedor: 'crucial', 'incrível', 'imperdível', 'perfeito para você'",
	travessao: "usa travessão (—) para ligar frases",
	lista_forcada: "lista ou grupo de três que o conteúdo não pede",
	idioma_errado: "responde num idioma diferente do da última mensagem da pessoa",
	tom_de_robo: "soa como chatbot ou formulário, não como uma pessoa conversando",
};
type Regra = keyof typeof REGRAS;
const NOMES_DAS_REGRAS = Object.keys(REGRAS) as [Regra, ...Regra[]];

// ---------- O JUIZ ----------
// escolhido no --teste de 03/11: deu 2 para a resposta ruim e 5 para a boa. O kimi-k3 escrevia a nota em texto em vez de
// chamar dar_nota, o gpt-oss:120b não viu a "ferramenta" na resposta ruim e o mistral-large-4 reclamou da resposta boa.
const NOME_DO_JUIZ = process.env.JUIZ ?? "deepseek-v4-pro:0813";
// temperature 0: o mesmo texto tem que ganhar a mesma nota. Sem isso, a resposta boa do --teste ganhava 3 numa rodada e 5 na outra.
const juiz = new ChatOpenAI({
	model: NOME_DO_JUIZ,
	temperature: 0,
	apiKey: process.env.OLLAMA_API_KEY,
	configuration: { baseURL: "https://ollama.com/v1" },
	timeout: 120_000,
});

const Nota = z.object({
	nota: z.coerce.number().int().min(1).max(5).describe("1 a 5"),
	problemas: z.array(z.object({
		regra: z.enum(NOMES_DAS_REGRAS),
		trecho: z.string().describe("o trecho exato da resposta"),
	})).describe("lista vazia se não houver problema"),
});
export type Julgamento = z.infer<typeof Nota>;

// aqui fica a ferramenta, e não o withStructuredOutput do orquestrador: no teste de 03/11, com o withStructuredOutput a
// resposta boa do --teste ganhou 3 em 7 de 7 rodadas (o --teste falhou 2 de 4 vezes), e com a ferramenta, média 4.
const darNota = tool(async () => "ok", {
	name: "dar_nota",
	description: "Registra a nota da escrita e a lista de problemas encontrados.",
	schema: Nota,
});

const INSTRUCOES = `Você avalia a ESCRITA de uma resposta de um bot de passagens aéreas no Slack. Não confira fatos (preço, horário, link): outra parte faz isso. Julgue só se a resposta está clara, curta e soa como uma pessoa.

Notas:
5 = uma pessoa experiente escreveria assim
4 = boa, com um deslize pequeno
3 = dá para entender, mas tem cara de chatbot ou enrola
2 = confusa ou cheia de vícios
1 = difícil de entender

Códigos como :dog: e :mag: são emojis do Slack: na tela viram o desenho, não são problema.
Para cada problema, diga a regra e copie o trecho exato da resposta. Sem problema, devolva a lista vazia. Chame dar_nota.

Regras:
${Object.entries(REGRAS).map(([nome, texto]) => `- ${nome}: ${texto}`).join("\n")}`;

// a linha da planilha é o código que escreve (noPlanilha, no graph.ts), não o modelo: julgar ela mede o código.
// Na primeira rodada, metade dos "pecas_de_dentro" eram essa linha.
function soDoModelo(resposta: string) {
	return resposta.split("\n").filter((linha) => !/^:bar_chart: Planilha:|^Não consegui (criar|atualizar) a planilha/.test(linha.trim())).join("\n").trim();
}

export async function julgar(mensagens: string[], resposta: string): Promise<Julgamento> {
	const carta = [
		new SystemMessage(INSTRUCOES),
		new HumanMessage(`O que a pessoa escreveu:\n${mensagens.map((mensagem) => `- ${mensagem}`).join("\n")}\n\nA resposta do bot:\n${soDoModelo(resposta)}`),
	];
	const saida = await juiz.bindTools([darNota], { tool_choice: "required" }).invoke(carta);
	const chamada = saida.tool_calls?.find((opcao) => opcao.name === "dar_nota");
	if (!chamada) throw new Error(`o juiz não chamou dar_nota: ${saida.text.slice(0, 120)}`);
	return Nota.parse(chamada.args);
}

// ---------- O RESUMO ----------
type Linha = { caso: string; nota: number; problemas: { regra: Regra; trecho: string }[]; resposta: string };

export function resumir(linhas: Linha[]) {
	const media = linhas.reduce((soma, linha) => soma + linha.nota, 0) / linhas.length;
	const porNota = [5, 4, 3, 2, 1].map((nota) => `${nota}: ${linhas.filter((linha) => linha.nota === nota).length}`).join("  ");
	const porRegra = Map.groupBy(linhas.flatMap((linha) => linha.problemas), (problema) => problema.regra);
	const regras = [...porRegra].toSorted((a, b) => b[1].length - a[1].length).map(([regra, achados]) => `  ${String(achados.length).padStart(5)}  ${regra.padEnd(18)} ex.: "${achados[0].trecho.slice(0, 70)}"`);
	const piores = linhas.toSorted((a, b) => a.nota - b.nota).slice(0, 5).map((linha) => `  ${linha.nota}  ${linha.caso}: ${linha.resposta.replaceAll("\n", " ").slice(0, 90)}`);
	return [`Média da escrita: ${media.toFixed(2)} de 5, em ${linhas.length} respostas`, `Por nota   ${porNota}`, "", "Regras mais quebradas:", ...regras, "", "As 5 piores:", ...piores].join("\n");
}

// ---------- O TESTE DO PRÓPRIO JUIZ ----------
// a resposta ruim é a de verdade, do "oi" de 03/11; a boa é a do exemplo da regra 13 do redator
async function testar() {
	const ruim = "Oi! Tudo tranquilo por aqui: nenhuma pesquisa nas últimas 6 horas e nenhum monitoramento ativo. Sobre o tracker de POA → Manaus que você pediu: ele *não foi criado*, nenhuma ferramenta confirmou esse monitoramento. Pra funcionar, ele precisaria ser criado primeiro e só avisa com o bot ligado. Quer que eu crie agora com aqueles dados (ida 15/11, volta 03/12, alerta abaixo de R$ 2500)?";
	const boa = "Oi! Nada rodando agora: nenhum monitoramento ligado e nenhuma pesquisa nas últimas 6 horas. Quer que eu procure algum voo?";
	const notaRuim = await julgar(["oi"], ruim);
	const notaBoa = await julgar(["oi"], boa);
	console.log("ruim:", JSON.stringify(notaRuim));
	console.log("boa: ", JSON.stringify(notaBoa));
	assert.ok(notaRuim.nota < notaBoa.nota, "o juiz deu nota maior (ou igual) para a resposta ruim");
	assert.ok(notaRuim.problemas.some((problema) => problema.regra === "pecas_de_dentro"), "o juiz não viu a 'ferramenta' na resposta ruim");
	console.log(`O juiz ${NOME_DO_JUIZ} separou a boa da ruim.`);
}

// ---------- RODAR ----------
if (import.meta.main) {
	if (process.argv.includes("--teste")) {
		await testar();
		process.exit(0);
	}

	// o mesmo nome que a prova grava
	const ARQUIVO = process.argv[2] ?? `${import.meta.dirname}/../results/${rotuloDosModelos().replaceAll(":", "-")}.jsonl`;
	const SAIDA = ARQUIVO.replace(/\.jsonl$/, ".estilo.jsonl");
	const lerLinhas = async (caminho: string) => (await readFile(caminho, "utf8").catch(() => "")).split("\n").filter(Boolean).map((linha) => JSON.parse(linha));

	const julgados = await lerLinhas(SAIDA);
	// a mesma resposta não é julgada duas vezes; se a prova rodou de novo e a resposta mudou, julga a nova
	const jaFeitos = new Set(julgados.map((linha) => linha.caso + "\n" + linha.resposta));
	const [parte, partes] = (process.env.PARTE ?? "1/1").split("/").map(Number);
	const daProva = (await lerLinhas(ARQUIVO)).filter((linha, indice) => !linha.erro && linha.resposta && indice % partes === parte - 1);
	const faltam = daProva.filter((linha) => !jaFeitos.has(linha.caso + "\n" + linha.resposta));
	console.log(`${daProva.length} respostas no arquivo, ${faltam.length} para julgar, juiz ${NOME_DO_JUIZ}\n`);

	for (const linha of faltam) {
		let julgamento: Julgamento;
		try {
			julgamento = await julgar(linha.mensagens, linha.resposta);
		} catch (erro: any) {
			console.log(`ERRO ${linha.caso}: ${erro.message}`);
			continue;    // não grava: a próxima rodada tenta de novo
		}
		const nova = { caso: linha.caso, juiz: NOME_DO_JUIZ, ...julgamento, resposta: linha.resposta };
		julgados.push(nova);
		await appendFile(SAIDA, JSON.stringify(nova) + "\n");
		console.log(`${julgamento.nota}  ${linha.caso}${julgamento.problemas.length ? "  (" + julgamento.problemas.map((problema) => problema.regra).join(", ") + ")" : ""}`);
		// a nota aparece na sessão do Langfuse, ao lado da nota dos fatos
		if (linha.conversa) anotar(linha.conversa, "escrita_boa", julgamento.nota >= 4, julgamento.problemas.map((problema) => `${problema.regra}: ${problema.trecho}`).join(" | "));
	}

	if (julgados.length > 0) console.log("\n" + resumir(julgados));
	await enviarRastreio();
	process.exit(0);
}
