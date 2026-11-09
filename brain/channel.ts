// brain/channel.ts - o que o bot faz com as mensagens de cada canal, sem saber que é o Slack
//
// O bot.ts só liga isto ao Slack (dizer, editar e apagar mensagem, e os botões). Aqui mora a ordem das coisas:
//   - mensagens seguidas esperam 2 s de silêncio e viram um pedido só; com um pedido rodando, um juiz decide se a
//     mensagem nova refaz o pedido, espera na fila ou não pede nada (veja OS CANAIS, abaixo);
//   - um trabalho por vez em cada canal (um pedido para o grafo, ou compactar e excluir o contexto): dois ao mesmo
//     tempo escreveriam no mesmo checkpoint e um apagaria o que o outro escreveu;
//   - "contexto", "compactar contexto" e "excluir contexto", exatos, viram a ação e não vão para o grafo.
// Este arquivo não lê o .env: o quality/tests.ts importa ele com uma saída falsa no lugar do Slack.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { Decisao, INSTRUCOES_DO_JUIZ } from "./agents.ts";
import { explicarErro } from "./checker.ts";
import { compactar, excluir, retratoDaConversa, retratoParaSlack } from "./context.ts";
import { listarConversas, modelos, responder as responderDeVerdade } from "./graph.ts";
import { anotarNoPainel } from "./live.ts";
import { rotuloDosModelos } from "./models.ts";
import { anotar, rastrear } from "./tracing.ts";
import { semAcento } from "../rules/airports.ts";

// ---------- A SAÍDA ----------
// dizer devolve o id da mensagem (o "ts" do Slack), para editar e apagar o aviso de progresso depois
export type Mensagem = { text: string; blocks?: unknown[] };
export type Saida = {
	dizer(canal: string, mensagem: Mensagem): Promise<string | undefined>;
	editar(canal: string, id: string, texto: string): Promise<unknown>;
	apagar(canal: string, id: string): Promise<unknown>;
};

export const PEGUEI = ":taki: Peguei. Termino o pedido anterior e já vejo esse.";
export const FAREJANDO = ":taki: O Taki está farejando...";

// ---------- OS COMANDOS DE CONTEXTO ----------
// comparação exata, sem acento, caixa e pontuação no fim: "Contexto!" vale, "quero limpar o contexto da viagem" não
const COMANDOS = { "contexto": "ver", "compactar contexto": "compactar", "excluir contexto": "excluir" } as const;
export type Comando = (typeof COMANDOS)[keyof typeof COMANDOS];

export function comandoDeContexto(texto: string): Comando | null {
	const limpo = semAcento(texto).replace(/[.!?\s]+$/, "").replace(/\s+/g, " ");
	return Object.hasOwn(COMANDOS, limpo) ? COMANDOS[limpo as keyof typeof COMANDOS] : null;
}

// a resposta do "contexto" vem com dois botões. O Excluir pede confirmação no próprio Slack.
// Os botões só funcionam com "Interactivity" ligada no app do Slack; os textos exatos funcionam sempre.
export function blocosDoContexto(texto: string) {
	const botao = (acao: string, rotulo: string) => ({ type: "button", action_id: `contexto_${acao}`, value: acao, text: { type: "plain_text", text: rotulo } });
	return [
		...emSecoes(texto),
		{
			type: "actions",
			elements: [
				botao("compactar", "Compactar"),
				{
					...botao("excluir", "Excluir"),
					style: "danger",
					confirm: {
						title: { type: "plain_text", text: "Excluir a conversa?" },
						text: { type: "plain_text", text: "Apago as mensagens, o resumo e os voos desta conversa. Preferências, documentos, monitoramentos e planilhas ficam." },
						confirm: { type: "plain_text", text: "Excluir" },
						deny: { type: "plain_text", text: "Cancelar" },
						style: "danger",
					},
				},
			],
		},
	];
}

// ---------- A LINHA NO FIM ----------
// cada mensagem do bot termina numa linha (o bloco "divider" do Slack): sem ela, mensagens seguidas do bot
// ficam empilhadas e não se vê onde uma acaba. O texto vai em seções de até 2900 letras (o Slack recusa mais
// de 3000 numa seção), quebradas numa linha, e continua em "text" para a notificação.
export function emSecoes(texto: string) {
	const secoes: { type: "section"; text: { type: "mrkdwn"; text: string } }[] = [];
	let resto = texto;
	while (resto) {
		const quebra = resto.length <= 2900 ? resto.length : resto.lastIndexOf("\n", 2900) > 0 ? resto.lastIndexOf("\n", 2900) : 2900;
		secoes.push({ type: "section", text: { type: "mrkdwn", text: resto.slice(0, quebra) } });
		resto = resto.slice(quebra).replace(/^\n/, "");
	}
	return secoes;
}

export function comLinha(texto: string, blocos: unknown[] = emSecoes(texto)): Mensagem {
	return { text: texto, blocks: [...blocos, { type: "divider" }] };
}

// ---------- OS CANAIS ----------
// Várias mensagens seguidas viram um pedido só. Cada mensagem zera um cronômetro de ESPERA_POR_MAIS; quando ele vence,
// as mensagens juntas (uma por linha) são o lote. Se nenhum pedido do canal está rodando, o lote vira um pedido.
// Se um está, o juiz (o modelo barato, com prazo curto) lê o pedido e o lote e escolhe:
//   refazer: o lote muda ou completa o pedido. O pedido é cancelado de verdade (AbortSignal até o grafo.stream, e o
//     responder desfaz ele no checkpointer) e um novo começa com as mensagens dele e as do lote;
//   fila: outro assunto. O pedido termina e o lote vem depois, com o "Peguei";
//   ignorar_espera: "ok", "valeu". Nada muda.
// Juiz que quebra ou demora vale fila: é o que o bot fazia antes, e nunca perde mensagem.
export const ESPERA_POR_MAIS = 2_000;    // quanto silêncio fecha um lote de mensagens (era 5 s até 09/11: a pessoa achou lento)
export const PRAZO_DO_JUIZ = 8_000;      // depois disso, sem decisão do juiz, vale fila
export const REFAZENDO = ":taki: Vi que você mudou o pedido. Refaço com a mensagem nova junto.";

// fase: na fila, rodando (dá para cancelar), respondendo (a resposta já saiu do grafo: tarde para refazer) ou feito
type Pedido = { tipo: "pedido"; textos: string[]; controle: AbortController; fase: "fila" | "rodando" | "respondendo" | "feito" };
type Tarefa = Pedido | { tipo: "comando"; comando: "compactar" | "excluir"; terminou: (texto: string) => void };

type EstadoDoCanal = {
	fila: Tarefa[];
	trabalhando: boolean;
	trabalho: Promise<void>;
	atual: Pedido | null;                    // o pedido que está rodando agora
	chegando: string[];                      // as mensagens do lote que ainda está esperando o cronômetro
	pararCronometro: (() => void) | null;
	decidindo: Promise<void>;                // um lote decide de cada vez: dois juízes ao mesmo tempo poderiam cancelar o mesmo pedido
};

// o relógio que o teste troca: assim ele não espera de verdade
export type Relogio = { depois(ms: number, fazer: () => void): () => void };
const relogioDeVerdade: Relogio = {
	depois(ms, fazer) {
		const cronometro = setTimeout(fazer, ms);
		return () => clearTimeout(cronometro);
	},
};

type Opcoes = { responder?: typeof responderDeVerdade; relogio?: Relogio };

const novoPedido = (textos: string[]): Pedido => ({ tipo: "pedido", textos, controle: new AbortController(), fase: "fila" });

export function criarCanais(saida: Saida, opcoes: Opcoes = {}) {
	const responder = opcoes.responder ?? responderDeVerdade;
	const relogio = opcoes.relogio ?? relogioDeVerdade;
	const canais = new Map<string, EstadoDoCanal>();

	const doCanal = (canal: string) => {
		if (!canais.has(canal)) canais.set(canal, { fila: [], trabalhando: false, trabalho: Promise.resolve(), atual: null, chegando: [], pararCronometro: null, decidindo: Promise.resolve() });
		return canais.get(canal)!;
	};
	// se o Slack recusar os blocos, a mensagem vai só em texto: a linha é enfeite, a pessoa não pode ficar sem a resposta
	const comLinhaOuTexto = (canal: string, text: string, blocos?: unknown[]) => saida.dizer(canal, comLinha(text, blocos)).catch((erro) => {
		console.log(`[canal] o Slack recusou os blocos (${erro?.message}): mando só o texto`);
		return saida.dizer(canal, { text });
	});
	const dizer = (canal: string, text: string) => comLinhaOuTexto(canal, text).catch(console.log);

	// trabalhando vira falso no mesmo instante em que a fila fica vazia: assim uma tarefa que chega logo depois nunca fica parada
	function enfileirar(canal: string, tarefa: Tarefa, naFrente = false) {
		const estado = doCanal(canal);
		if (naFrente) estado.fila.unshift(tarefa);
		else estado.fila.push(tarefa);
		if (estado.trabalhando) return;
		estado.trabalhando = true;
		estado.trabalho = (async () => {
			while (estado.fila.length > 0) await fazer(canal, estado.fila.shift()!).catch((erro) => console.log(`[canal] o trabalho quebrou: ${erro?.message}`));
			estado.trabalhando = false;
		})();
	}

	// o pedido rodando é cancelado: o responder desfaz ele no checkpointer, e o fazer() não manda a resposta velha
	function cancelar(canal: string, motivo: string) {
		const atual = doCanal(canal).atual;
		if (!atual || atual.fase !== "rodando" || atual.controle.signal.aborted) return;
		atual.controle.abort();
		anotarNoPainel(canal, "cancelado", `pedido cancelado: ${motivo}`);
	}

	async function fazer(canal: string, tarefa: Tarefa) {
		if (tarefa.tipo === "comando") return tarefa.terminou(await fazerComando(canal, tarefa.comando));
		const estado = doCanal(canal);
		const sinal = tarefa.controle.signal;
		estado.atual = tarefa;
		tarefa.fase = "rodando";
		// uma mensagem de progresso que vai sendo editada e some no fim. Ela é só um enfeite: se falhar, o pedido segue
		const aviso = await saida.dizer(canal, { text: FAREJANDO }).catch(() => undefined);
		try {
			const resposta = await responder(canal, tarefa.textos.join("\n"), async (progresso) => {
				if (aviso && !sinal.aborted) await saida.editar(canal, aviso, progresso).catch(console.log);
			}, sinal);
			// cancelado: a resposta velha nunca chega no Slack, mesmo se o grafo já tinha terminado
			if (sinal.aborted) return;
			tarefa.fase = "respondendo";
			console.log("O bot respondeu: " + resposta);
			await comLinhaOuTexto(canal, resposta);
		} catch (erro: any) {
			if (sinal.aborted) return console.log(`[canal] pedido cancelado: ${tarefa.textos.join(" / ").slice(0, 100)}`);
			console.log("Deu erro: ", erro);    // o erro técnico fica no log; a pessoa lê o que aconteceu e o que fazer
			await dizer(canal, explicarErro(erro));
		} finally {
			tarefa.fase = "feito";
			estado.atual = null;
			if (aviso) await saida.apagar(canal, aviso).catch(console.log);
		}
	}

	async function fazerComando(canal: string, comando: "compactar" | "excluir") {
		try {
			const texto = comando === "compactar" ? await compactar(canal) : await excluir(canal);
			anotarNoPainel(canal, "contexto", `${comando === "compactar" ? "compactou" : "excluiu"}: ${texto}`);
			return texto;
		} catch (erro: any) {
			console.log(`[contexto] não consegui ${comando}: ${erro.message}`);
			anotarNoPainel(canal, "contexto", `não consegui ${comando}: ${erro.message}`);
			return `Não consegui ${comando} a conversa agora, e nada foi apagado. Tente de novo daqui a pouco.`;
		}
	}

	// compactar entra na fila do canal: espera o pedido que está rodando terminar.
	// Excluir cancela o pedido que está rodando (senão ele escreveria de volta o que acabou de ser apagado) e vai
	// para a frente da fila; os pedidos que já estavam esperando vêm depois, numa conversa nova
	function comando(canal: string, qual: "compactar" | "excluir") {
		const { promise, resolve } = Promise.withResolvers<string>();
		if (qual === "excluir") cancelar(canal, "a pessoa pediu para excluir o contexto");
		enfileirar(canal, { tipo: "comando", comando: qual, terminou: resolve }, qual === "excluir");
		return promise;
	}

	// ---------- O JUIZ ----------
	// a resposta do modelo passa pelo zod (Decisao); qualquer erro, ou o prazo vencendo, vira fila
	async function julgar(canal: string, emAndamento: string, nova: string) {
		let pararPrazo = () => {};
		const desistir = new AbortController();    // o prazo venceu: a chamada ao modelo para, e não gasta crédito à toa
		try {
			const prazo = new Promise<never>((_, falhar) => {
				pararPrazo = relogio.depois(PRAZO_DO_JUIZ, () => {
					desistir.abort();
					falhar(new Error(`passou de ${PRAZO_DO_JUIZ / 1000} s`));
				});
			});
			const juiz = modelos.especialista.withStructuredOutput(Decisao, { name: "decidir", method: "functionCalling" });
			const chamada = juiz.invoke([new SystemMessage(INSTRUCOES_DO_JUIZ), new HumanMessage(`Pedido em andamento:\n${emAndamento}\n\nMensagem nova:\n${nova}`)], { callbacks: rastrear(canal, rotuloDosModelos()), signal: desistir.signal });
			chamada.catch(() => {});    // se o prazo vencer antes, o erro que vier depois não pode derrubar o bot
			return { ...(await Promise.race([chamada, prazo])), certo: true };
		} catch (erro: any) {
			return { decisao: "fila" as const, motivo: `o juiz falhou (${erro?.message}); na dúvida, fila`, certo: false };
		} finally {
			pararPrazo();
		}
	}

	async function decidir(canal: string, lote: string[]) {
		const estado = doCanal(canal);
		// o pedido que vai responder: o que está rodando, ou o primeiro da fila, que ainda nem começou (o refazer de agora há pouco)
		const rodando = estado.atual && estado.atual.fase === "rodando" && !estado.atual.controle.signal.aborted ? estado.atual : null;
		const alvo = rodando ?? estado.fila.find((tarefa): tarefa is Pedido => tarefa.tipo === "pedido");
		if (!alvo) {
			if (estado.trabalhando) await dizer(canal, PEGUEI);    // um compactar ou excluir rodando
			return enfileirar(canal, novoPedido(lote));
		}
		const { decisao, motivo, certo } = await julgar(canal, alvo.textos.join("\n"), lote.join("\n"));
		console.log(`[juiz] ${decisao}: ${motivo}`);
		anotarNoPainel(canal, "juiz", `${decisao}: ${motivo}`);
		anotar(canal, "juiz_das_mensagens", certo, `${decisao}: ${motivo}`);
		if (decisao === "ignorar_espera") return;
		// o juiz leva segundos, e nesse tempo o alvo pode ter mudado de fase. Olha onde ele está AGORA:
		//   cancelado por outro motivo (um "excluir contexto"): as mensagens dele não voltam, o lote vai sozinho;
		//   respondendo ou feito: tarde para refazer, a resposta já saiu. O lote vai para a fila;
		//   na fila: ainda não leu o texto, o lote entra nele;
		//   rodando: cancela, e um pedido novo com as mensagens dele e as do lote vai para a frente da fila
		if (decisao === "fila" || alvo.controle.signal.aborted || alvo.fase === "respondendo" || alvo.fase === "feito") {
			await dizer(canal, PEGUEI);
			return enfileirar(canal, novoPedido(lote));
		}
		if (alvo.fase === "fila") {
			alvo.textos.push(...lote);
			return void (await dizer(canal, REFAZENDO));
		}
		cancelar(canal, "a mensagem nova muda o pedido");
		enfileirar(canal, novoPedido([...alvo.textos, ...lote]), true);
		await dizer(canal, REFAZENDO);
	}

	// o retrato não muda nada, então não espera a fila.
	// Se o Slack recusar os botões, o retrato vai só em texto: a pessoa não pode ficar sem ele
	async function verContexto(canal: string) {
		const texto = retratoParaSlack(await retratoDaConversa(canal));
		await comLinhaOuTexto(canal, texto, blocosDoContexto(texto));
	}

	// compactar espera a fila: com outra coisa rodando, a pessoa fica sabendo que entrou
	async function pedirComando(canal: string, qual: "compactar" | "excluir") {
		if (qual === "compactar" && doCanal(canal).trabalhando) await dizer(canal, PEGUEI);
		await dizer(canal, await comando(canal, qual));
	}

	// ---------- A PORTA DE ENTRADA ----------
	// devolve na hora: o lote espera o cronômetro. Quem precisa esperar o trabalho acabar usa vazio()
	async function receber(canal: string, texto: string) {
		const qual = comandoDeContexto(texto);
		if (qual === "ver") return verContexto(canal).catch((erro) => dizer(canal, explicarErro(erro)));
		if (qual) return pedirComando(canal, qual);
		const estado = doCanal(canal);
		estado.chegando.push(texto);
		estado.pararCronometro?.();
		estado.pararCronometro = relogio.depois(ESPERA_POR_MAIS, () => {
			estado.pararCronometro = null;
			const lote = estado.chegando.splice(0);
			estado.decidindo = estado.decidindo.then(() => decidir(canal, lote)).catch((erro) => console.log(`[canal] a decisão quebrou: ${erro?.message}`));
		});
		const ate = new Date(Date.now() + ESPERA_POR_MAIS).toISOString();
		anotarNoPainel(canal, "espera", `esperando mais mensagens (${ESPERA_POR_MAIS / 1000} s): ${estado.chegando.length} até agora`, { ate });
	}

	// o botão do Slack: a mesma ação do texto exato, com a resposta no canal
	const botao = pedirComando;

	// para os testes (e para quem precisa saber que o canal sossegou): espera as decisões e a fila do canal acabarem.
	// O lote que ainda espera o cronômetro não conta
	async function vazio(canal: string) {
		const estado = doCanal(canal);
		for (;;) {
			const decisoes = estado.decidindo;
			await decisoes;
			while (estado.trabalhando) await estado.trabalho;
			if (estado.decidindo === decisoes) return;
		}
	}

	// o painel ao vivo usa as mesmas ações, pela mesma fila (brain/live.ts recebe isto em ligarPainel)
	const acoesDoPainel = {
		conversas: () => listarConversas(),
		retrato: (canal: string) => retratoDaConversa(canal),
		executar: (canal: string, qual: "compactar" | "excluir") => comando(canal, qual),
	};

	return { receber, botao, comando, vazio, acoesDoPainel };
}
