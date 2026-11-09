// brain/context.ts - o contexto de uma conversa: ver o que o bot lembra, compactar e excluir
//
// A memória do bot tem duas partes. A curta é o estado do grafo no checkpointer (as mensagens, o resumo do agente de
// contexto e os voos das últimas 6 horas). A longa é o dados.sqlite (preferências, dossiê, monitoramentos e planilhas).
//   retratoDaConversa: junta as duas sem chamar modelo nenhum. Serve ao Slack ("contexto") e ao painel ao vivo.
//   compactar: o modelo barato junta a conversa toda no resumo, guarda nas preferências o que dura e apaga as mensagens
//     antigas, deixando as últimas. Voos e o pedido em andamento continuam.
//   excluir: guarda o que dura e apaga a conversa do checkpointer, com os checkpoints antigos. Preferências, dossiê,
//     monitoramentos e planilhas ficam. O compactar não apaga os checkpoints antigos: ele só tira as mensagens da memória de agora.
// Quem chama (brain/channel.ts) garante que nenhum pedido do canal está rodando: dois escrevendo no mesmo
// checkpoint ao mesmo tempo, um apagaria o que o outro escreveu.
//
// Para ver de uma conversa do terminal:   DADOS=:memory: MEMORIA=:memory: node brain/context.ts <conversa>   (sem os dois, lê os bancos do bot)

import { type BaseMessage, HumanMessage, RemoveMessage, SystemMessage } from "@langchain/core/messages";

import { INSTRUCOES_DO_RESUMO, instrucoesDaMemoria, Lembrete } from "./agents.ts";
import { apagarConversa, cortarHistorico, fatosParaGuardar, grafo, modelos, podeLembrar, resumoLimpo } from "./graph.ts";
import { descreverMonitoramento } from "./tools.ts";
import { rastrear } from "./tracing.ts";
import { rotuloDosModelos } from "./models.ts";
import { guardarPreferencia, lerDossie, listarMonitoramentos, listarPlanilhas, listarPreferencias } from "../storage/database.ts";
import { nomeDaCidade, semAcento } from "../rules/airports.ts";

export const MANTER_AO_COMPACTAR = 10;      // quantas mensagens recentes ficam depois de compactar (o corte começa numa da pessoa)
const LINHAS_PARA_O_MODELO = 200;           // shortcut: conversa maior que isso manda só as 200 últimas linhas ao modelo; se o resumo ficar ruim, resumir em lotes
const ESQUECER = /\b(esquec|apag)/;
// fato que só pode ter um valor: com um "mora ..." guardado, o lote antigo não traz outro (a pessoa pode ter se mudado depois)
const FATO_DE_UM_VALOR = /^(mora|vive|e de|sai de)\b/;

const configDa = (conversa: string) => ({ configurable: { thread_id: conversa } });
const daPessoa = (mensagem: BaseMessage) => mensagem.getType() === "human";

// ---------- O RETRATO ----------
export async function retratoDaConversa(conversa: string) {
	const estado = await grafo.getState(configDa(conversa));
	const mensagens: BaseMessage[] = estado.values.messages ?? [];
	const naJanela = mensagens.length > 0 ? cortarHistorico(mensagens).length : 0;
	return {
		conversa,
		mensagens: mensagens.length,
		naJanela,
		foraDaJanela: mensagens.length - naJanela,
		resumo: String(estado.values.resumo ?? ""),
		voos: (estado.values.voos ?? []).length,
		pedidoPelaMetade: estado.next.length > 0,
		preferencias: listarPreferencias(conversa).map((preferencia) => preferencia.texto),
		dossie: lerDossie(conversa),
		monitoramentos: listarMonitoramentos(conversa).map((monitoramento) => `#${monitoramento.id}: ${descreverMonitoramento(monitoramento)}`),
		planilhas: listarPlanilhas(conversa).map((planilha) => ({ nome: planilha.par.split("|").map(nomeDaCidade).join("–"), link: planilha.link })),
	};
}

export type Retrato = Awaited<ReturnType<typeof retratoDaConversa>>;

// o mesmo retrato, escrito para o Slack
export function retratoParaSlack(retrato: Retrato) {
	const lista = (itens: string[], vazio: string) => (itens.length > 0 ? itens.join("; ") : vazio);
	const dossie = retrato.dossie;
	const documentos = dossie
		? [`nacionalidade ${dossie.nacionalidade}`, dossie.passaporte_validade && `passaporte vale até ${dossie.passaporte_validade}`, dossie.nascimento && `nascimento ${dossie.nascimento}`, dossie.vacina_febre_amarela && `vacina de febre amarela ${dossie.vacina_febre_amarela}`].filter(Boolean) as string[]
		: [];
	return [
		"*O que eu lembro desta conversa*",
		`• Mensagens: ${retrato.naJanela} na memória de agora${retrato.foraDaJanela > 0 ? ` e ${retrato.foraDaJanela} mais antigas, que só entram pelo resumo` : ""}`,
		`• Resumo: ${retrato.resumo || "nenhum ainda"}`,
		`• Preferências: ${lista(retrato.preferencias, "nenhuma")}`,
		`• Documentos: ${lista(documentos, "nenhum")}`,
		`• Monitoramentos: ${lista(retrato.monitoramentos, "nenhum")}`,
		`• Voos pesquisados nas últimas 6 horas: ${retrato.voos}`,
		`• Planilhas: ${lista(retrato.planilhas.map((planilha) => `<${planilha.link}|${planilha.nome}>`), "nenhuma")}`,
		...(retrato.pedidoPelaMetade ? ["• Tem um pedido que parou no meio: a próxima mensagem termina ele."] : []),
		"",
		"Para limpar, mande `compactar contexto` (fico com um resumo e as últimas mensagens) ou `excluir contexto` (começo do zero, mas guardo preferências, documentos e monitoramentos).",
	].join("\n");
}

// ---------- O QUE DURA ----------
// a mesma regra do agente de memória (noLembrar e fatosParaGuardar, em brain/graph.ts), com todas as mensagens da pessoa
// que passariam por ele. O modelo lê todas juntas, mas cada fato é conferido contra UMA mensagem sozinha, como no nó:
// senão "moro em São Paulo" e "prefiro ir pra Lisboa" juntas deixariam passar "mora em Lisboa". E três travas:
//   - nada é trocado: o lote não sabe qual mensagem é a mais nova, e trocaria o "mora em São Paulo" de hoje pelo Recife de antes;
//   - fato de um valor só (mora, é de, sai de) não entra se já existe um guardado da mesma forma;
//   - o que a pessoa pediu para esquecer não volta: fato com palavra de uma mensagem de "esquece"/"apaga" fica de fora.
// O dossiê não muda aqui: documento só entra pelo especialista memoria, quando a pessoa conta (guardar_documentos).
async function guardarOQueDura(conversa: string, mensagens: BaseMessage[]) {
	const textos = mensagens.filter(daPessoa).map((mensagem) => mensagem.text);
	const candidatas = textos.filter(podeLembrar).slice(-LINHAS_PARA_O_MODELO);
	if (candidatas.length === 0) return [];
	// sem o "s" do plural, como no fatosParaGuardar: "voos" e "voo" são a mesma palavra
	const palavras = (texto: string) => (semAcento(texto).match(/[a-z]{4,}/g) ?? []).map((palavra) => palavra.replace(/s$/, ""));
	const esquecidas = new Set(textos.filter((texto) => ESQUECER.test(semAcento(texto))).flatMap(palavras));
	const guardadas = listarPreferencias(conversa);
	const memoria = modelos.especialista.withStructuredOutput(Lembrete, { name: "lembrar", method: "functionCalling" });
	const proposta = await memoria.invoke([new SystemMessage(instrucoesDaMemoria(guardadas.map((preferencia) => preferencia.texto))), new HumanMessage(candidatas.join("\n"))], { callbacks: rastrear(conversa, rotuloDosModelos()) });
	const novos: string[] = [];
	for (const fato of proposta.guardar) {
		const ja = [...guardadas.map((preferencia) => preferencia.texto), ...novos];
		const forma = semAcento(fato).match(FATO_DE_UM_VALOR)?.[0];
		if (forma && ja.some((texto) => semAcento(texto).startsWith(forma))) continue;
		if (palavras(fato).some((palavra) => esquecidas.has(palavra))) continue;
		const comoNoNo = (mensagem: string) => fatosParaGuardar({ guardar: [fato], trocar: [] }, [...guardadas, ...novos.map((texto) => ({ id: 0, texto }))], mensagem).novos;
		const aceito = candidatas.map(comoNoNo).find((lista) => lista.length > 0)?.[0];
		if (aceito) novos.push(aceito);
	}
	for (const fato of novos) guardarPreferencia(conversa, fato);
	return novos;
}

// o resumo de antes mais o que ele ainda não cobre, numa linha por mensagem, como faz o agente de contexto
async function resumirTudo(conversa: string, resumo: string, mensagens: BaseMessage[]) {
	const linhas = mensagens
		.filter((mensagem) => daPessoa(mensagem) || (mensagem.getType() === "ai" && !(mensagem as any).tool_calls?.length))
		.map((mensagem) => `${daPessoa(mensagem) ? "Pessoa" : "Bot"}: ${mensagem.text.slice(0, 500)}`)
		.slice(-LINHAS_PARA_O_MODELO);
	if (linhas.length === 0) return resumo;
	const resposta = await modelos.especialista.invoke([
		new SystemMessage(INSTRUCOES_DO_RESUMO),
		new HumanMessage(`Resumo de antes: ${resumo || "nenhum"}\n\nConversa que vai sair da memória:\n${linhas.join("\n")}`),
	], { callbacks: rastrear(conversa, rotuloDosModelos()) });
	return resumoLimpo(resposta.text);
}

const guardouTexto = (guardados: string[]) => (guardados.length > 0 ? ` Guardei para as próximas viagens: ${guardados.join("; ")}.` : "");

// ---------- COMPACTAR ----------
// devolve a frase para a pessoa. Se o modelo falhar, o erro sobe antes de apagar qualquer coisa
export async function compactar(conversa: string) {
	const config = configDa(conversa);
	const estado = await grafo.getState(config);
	// pedido que parou no meio: a próxima mensagem retoma ele, e apagar agora tiraria as mensagens dele
	if (estado.next.length > 0) return "Tem um pedido que parou no meio nesta conversa. Mande uma mensagem para eu terminar ele, e depois compacte.";
	const mensagens: BaseMessage[] = estado.values.messages ?? [];
	const ficam = mensagens.length > 0 ? cortarHistorico(mensagens, MANTER_AO_COMPACTAR) : [];
	const saem = mensagens.slice(0, mensagens.length - ficam.length);
	if (saem.length === 0 && mensagens.length > MANTER_AO_COMPACTAR) return `Só tem um pedido aqui, com ${mensagens.length} mensagens (as buscas contam), e as mensagens dele ficam: não há o que compactar.`;
	if (saem.length === 0) return `A conversa ainda é curta (${mensagens.length} mensagens): não há o que compactar.`;

	const resumo = await resumirTudo(conversa, String(estado.values.resumo ?? ""), mensagens.slice(Number(estado.values.resumoAte ?? 0)));
	const guardados = await guardarOQueDura(conversa, mensagens);
	// como "lembrar", o último nó: o grafo entende que o pedido terminou e nada fica para retomar.
	// resumoAte = o que ficou, porque o resumo novo já cobre essas mensagens também
	await grafo.updateState(config, { messages: saem.map((mensagem) => new RemoveMessage({ id: mensagem.id! })), resumo, resumoAte: ficam.length }, "lembrar");
	return `Pronto, compactei a conversa: saíram ${saem.length} mensagens antigas, que agora estão no resumo, e ficaram as últimas ${ficam.length}.${guardouTexto(guardados)} Os voos que eu já tinha achado continuam aqui.`;
}

// ---------- EXCLUIR ----------
export async function excluir(conversa: string) {
	const config = configDa(conversa);
	const estado = await grafo.getState(config);
	const mensagens: BaseMessage[] = estado.values.messages ?? [];
	if (mensagens.length === 0 && !estado.values.resumo) return "Esta conversa ainda não tem nada guardado para excluir.";
	// a pessoa pediu para apagar: se o modelo falhar ao guardar as preferências, apaga mesmo assim e conta
	let guardados: string[] = [];
	let falhou = "";
	try {
		guardados = await guardarOQueDura(conversa, mensagens);
	} catch (erro: any) {
		console.log(`[contexto] não guardei as preferências antes de excluir: ${erro.message}`);
		falhou = " Não consegui guardar preferências novas desta vez; as que já estavam guardadas continuam.";
	}
	// a conversa inteira sai do arquivo, com os checkpoints antigos: a próxima mensagem começa do zero, como um canal novo
	await apagarConversa(conversa);
	return `Pronto, apaguei esta conversa da minha memória: ${mensagens.length} mensagens, o resumo e os voos pesquisados.${guardouTexto(guardados)}${falhou} Preferências, documentos, monitoramentos e planilhas continuam.`;
}

// ---------- USO PELO TERMINAL ----------
if (import.meta.main) {
	console.log(retratoParaSlack(await retratoDaConversa(process.argv[2] ?? "terminal")));
}
