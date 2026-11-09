// brain/channel.ts - o que o bot faz com as mensagens de cada canal, sem saber que é o Slack
//
// O bot.ts só liga isto ao Slack (dizer, editar e apagar mensagem, e os botões). Aqui mora a ordem das coisas:
//   - um trabalho por vez em cada canal (um pedido para o grafo, ou compactar e excluir o contexto): dois ao mesmo
//     tempo escreveriam no mesmo checkpoint e um apagaria o que o outro escreveu;
//   - "contexto", "compactar contexto" e "excluir contexto", exatos, viram a ação e não vão para o grafo.
// Este arquivo não lê o .env: o quality/tests.ts importa ele com uma saída falsa no lugar do Slack.

import { explicarErro } from "./checker.ts";
import { compactar, excluir, retratoDaConversa, retratoParaSlack } from "./context.ts";
import { listarConversas, responder as responderDeVerdade } from "./graph.ts";
import { anotarNoPainel } from "./live.ts";
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
		{ type: "section", text: { type: "mrkdwn", text: texto.slice(0, 2900) } },    // o Slack recusa seção com mais de 3000 letras
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

// ---------- OS CANAIS ----------
type Tarefa =
	| { tipo: "pedido"; textos: string[] }
	| { tipo: "comando"; comando: "compactar" | "excluir"; terminou: (texto: string) => void };

type EstadoDoCanal = { fila: Tarefa[]; trabalhando: boolean; trabalho: Promise<void> };

type Opcoes = { responder?: typeof responderDeVerdade };

export function criarCanais(saida: Saida, opcoes: Opcoes = {}) {
	const responder = opcoes.responder ?? responderDeVerdade;
	const canais = new Map<string, EstadoDoCanal>();

	const doCanal = (canal: string) => {
		if (!canais.has(canal)) canais.set(canal, { fila: [], trabalhando: false, trabalho: Promise.resolve() });
		return canais.get(canal)!;
	};

	// trabalhando vira falso no mesmo instante em que a fila fica vazia: assim uma tarefa que chega logo depois nunca fica parada
	function enfileirar(canal: string, tarefa: Tarefa) {
		const estado = doCanal(canal);
		estado.fila.push(tarefa);
		if (estado.trabalhando) return;
		estado.trabalhando = true;
		estado.trabalho = (async () => {
			while (estado.fila.length > 0) await fazer(canal, estado.fila.shift()!).catch((erro) => console.log(`[canal] o trabalho quebrou: ${erro?.message}`));
			estado.trabalhando = false;
		})();
	}

	async function fazer(canal: string, tarefa: Tarefa) {
		if (tarefa.tipo === "comando") return tarefa.terminou(await fazerComando(canal, tarefa.comando));
		// uma mensagem de progresso que vai sendo editada e some no fim. Ela é só um enfeite: se falhar, o pedido segue
		const aviso = await saida.dizer(canal, { text: FAREJANDO }).catch(() => undefined);
		try {
			const resposta = await responder(canal, tarefa.textos.join("\n"), async (progresso) => {
				if (aviso) await saida.editar(canal, aviso, progresso).catch(console.log);
			});
			console.log("O bot respondeu: " + resposta);
			await saida.dizer(canal, { text: resposta });
		} catch (erro: any) {
			console.log("Deu erro: ", erro);    // o erro técnico fica no log; a pessoa lê o que aconteceu e o que fazer
			await saida.dizer(canal, { text: explicarErro(erro) }).catch(console.log);
		} finally {
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

	// compactar e excluir entram na fila do canal: esperam o pedido que está rodando terminar.
	// Excluir com pedido rodando ou esperando é recusado, porque o pedido escreveria de novo o que acabou de ser apagado
	function comando(canal: string, qual: "compactar" | "excluir") {
		if (qual === "excluir" && doCanal(canal).trabalhando) {
			return Promise.resolve("Estou terminando outra coisa nesta conversa. Espere a minha resposta e mande `excluir contexto` de novo.");
		}
		const { promise, resolve } = Promise.withResolvers<string>();
		enfileirar(canal, { tipo: "comando", comando: qual, terminou: resolve });
		return promise;
	}

	// o retrato não muda nada, então não espera a fila
	// se o Slack recusar os botões, o retrato vai só em texto: a pessoa não pode ficar sem ele
	async function verContexto(canal: string) {
		const texto = retratoParaSlack(await retratoDaConversa(canal));
		await saida.dizer(canal, { text: texto, blocks: blocosDoContexto(texto) }).catch((erro) => {
			console.log(`[contexto] o Slack recusou os botões (${erro?.message}): mando só o texto`);
			return saida.dizer(canal, { text: texto });
		});
	}

	// compactar e excluir esperam a fila: com outra coisa rodando, a pessoa fica sabendo que entrou
	async function pedirComando(canal: string, qual: "compactar" | "excluir") {
		if (qual === "compactar" && doCanal(canal).trabalhando) await saida.dizer(canal, { text: PEGUEI }).catch(console.log);
		await saida.dizer(canal, { text: await comando(canal, qual) }).catch(console.log);
	}

	// ---------- A PORTA DE ENTRADA ----------
	// devolve quando a mensagem foi encaminhada; quem precisa esperar o trabalho acabar usa vazio()
	async function receber(canal: string, texto: string) {
		const qual = comandoDeContexto(texto);
		if (qual === "ver") return verContexto(canal).catch((erro) => saida.dizer(canal, { text: explicarErro(erro) }).catch(console.log));
		if (qual) return pedirComando(canal, qual);
		if (doCanal(canal).trabalhando) await saida.dizer(canal, { text: PEGUEI }).catch(console.log);
		enfileirar(canal, { tipo: "pedido", textos: [texto] });
	}

	// o botão do Slack: a mesma ação do texto exato, com a resposta no canal
	const botao = pedirComando;

	// para os testes (e para quem precisa saber que o canal sossegou): espera a fila do canal esvaziar
	async function vazio(canal: string) {
		while (doCanal(canal).trabalhando) await doCanal(canal).trabalho;
	}

	// o painel ao vivo usa as mesmas ações, pela mesma fila (brain/live.ts recebe isto em ligarPainel)
	const acoesDoPainel = {
		conversas: () => listarConversas(),
		retrato: (canal: string) => retratoDaConversa(canal),
		executar: (canal: string, qual: "compactar" | "excluir") => comando(canal, qual),
	};

	return { receber, botao, comando, vazio, acoesDoPainel };
}
