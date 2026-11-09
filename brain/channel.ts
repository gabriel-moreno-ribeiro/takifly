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

import { CRITERIOS_DO_JUIZ, Decisao, DECISOES_DO_JUIZ, INSTRUCOES_DO_JUIZ, PERGUNTA_DO_JUIZ } from "./agents.ts";
import { explicarErro } from "./checker.ts";
import { compactar, excluir, retratoDaConversa, retratoParaSlack } from "./context.ts";
import { listarConversas, modelos, responder as responderDeVerdade, voosDaConversa as voosDeVerdade } from "./graph.ts";
import { anotarNoPainel } from "./live.ts";
import { rotuloDosModelos } from "./models.ts";
import { anotar, rastrear } from "./tracing.ts";
import { diaDaSemana } from "./tools.ts";
import { semAcento } from "../rules/airports.ts";
import type { Voo } from "../sources/flights.ts";
import { horas } from "../sources/spreadsheet.ts";

// ---------- A SAÍDA ----------
// dizer devolve o id da mensagem (o "ts" do Slack), para editar e apagar o aviso de progresso depois
// attachments: o painel dos cartões de voo, com a barra colorida do lado (blocos do Slack não têm borda)
export type Mensagem = { text: string; blocks?: unknown[]; attachments?: unknown[] };
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

// ---------- OS CARTÕES DE VOO ----------
// cada voo que a resposta cita vira um cartão embaixo dela, montado pelo código com os dados da busca (09/11):
// o modelo escreve a conclusão, e dia, horários, escalas e o botão de comprar vêm daqui, sem chance de erro de cópia
const MAX_CARTOES = 3;
const reais = (valor: number) => `R$ ${valor.toLocaleString("pt-BR")}`;

// os voos citados, na ordem em que aparecem: o preço em R$ e a companhia precisam estar no texto
// shortcut: dois voos da mesma companhia e do mesmo preço viram o primeiro deles; se isso confundir, casar também o horário
// "TAP Air Portugal + Lufthansa" é citada como "TAP": a primeira palavra basta, menos "Air", que é de várias companhias
function nomeCurto(companhia: string) {
	const palavras = semAcento(companhia.split(/\s*\+\s*/)[0]).split(/\s+/);
	return palavras[0] === "air" ? palavras.slice(0, 2).join(" ") : palavras[0];
}

export function voosCitados(voos: Voo[], texto: string) {
	const limpo = semAcento(texto);
	const citados: Voo[] = [];
	for (const achado of texto.matchAll(/R\$\s*(\d[\d.]*)/g)) {
		const preco = Number(achado[1].replace(/\./g, ""));
		const voo = voos.find((um) => um.preco === preco && limpo.includes(nomeCurto(um.companhia)) && !citados.includes(um));
		if (voo) citados.push(voo);
		if (citados.length === MAX_CARTOES) break;
	}
	return citados;
}

// rótulo: o mais barato e o mais rápido entre os voos do painel (só quando há mais de um para comparar)
export function cartaoDoVoo(voo: Voo, indice: number, rotulo = "") {
	const diaMes = `${voo.data.slice(8, 10)}/${voo.data.slice(5, 7)}`;
	const dia = `${diaDaSemana(voo.data).slice(0, 3)}, ${diaMes}`;
	const escalas = voo.escalas === 0 ? "direto" : `${voo.escalas} escala${voo.escalas > 1 ? "s" : ""}`;
	const chegada = voo.chegada.startsWith(diaMes + " ") ? voo.chegada.slice(6) : voo.chegada;    // no mesmo dia, só a hora
	const campo = (nome: string, valor: string) => ({ type: "mrkdwn", text: `*${nome}*\n${valor}` });
	return {
		type: "section",
		text: { type: "mrkdwn", text: `*${reais(voo.preco)}*  ·  ${voo.companhia}${rotulo ? `   ${rotulo}` : ""}` },
		fields: [campo("Quando", dia), campo("Trajeto", `${voo.origem} ${voo.saida} → ${voo.destino} ${chegada}`), campo("Escalas", escalas), campo("Duração", horas(voo.duracao_min))],
		accessory: { type: "button", action_id: `comprar_${indice}`, text: { type: "plain_text", text: "Comprar" }, url: voo.link },
	};
}

function rotulos(voos: Voo[]) {
	if (voos.length < 2) return voos.map(() => "");
	const barato = voos.reduce((a, b) => (b.preco < a.preco ? b : a));
	const rapido = voos.reduce((a, b) => (b.duracao_min < a.duracao_min ? b : a));
	return voos.map((voo) => [voo === barato ? "💰 Mais barato" : "", voo === rapido ? "⚡ Mais rápido" : ""].filter(Boolean).join("  "));
}

// clicar num botão de frase vale como mandar a frase (bot.ts, app.action). Precisa da Interactivity ligada no app
const PROXIMOS_PASSOS = [
	["🔔 Avisar se baixar", "me avisa quando o preço desse voo baixar"],
	["✈️ Só diretos", "mostra só os voos diretos"],
	["📅 Dia seguinte", "e no dia seguinte?"],
];
const botoesDeFrase = (frases: string[][]) => ({
	type: "actions",
	elements: frases.map(([rotulo, frase], indice) => ({ type: "button", action_id: `frase_${indice}`, value: frase, text: { type: "plain_text", text: rotulo } })),
});

// o texto fica em cima; embaixo, um painel com a barra dourada do Taki: os cartões, a planilha e os botões de próximo passo.
// A linha "Comprar: <link>" do voo que tem cartão sai do texto (o botão faz isso), e a da planilha vai para o pé do painel
const COR_DO_TAKI = "#F2A93B";
export function blocosDaResposta(texto: string, voos: Voo[]) {
	const linhas = texto.split("\n");
	const daPlanilha = (linha: string) => /^:bar_chart: Planilhas?:/.test(linha.trim());
	const corpo = linhas.filter((linha) => !daPlanilha(linha) && !(/comprar/i.test(linha) && voos.some((voo) => linha.includes(voo.link)))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
	const planilhas = linhas.filter(daPlanilha).map((linha) => ({ type: "context", elements: [{ type: "mrkdwn", text: linha.trim() }] }));
	const nomes = rotulos(voos);
	const cartoes = voos.flatMap((voo, indice) => [...(indice > 0 ? [{ type: "divider" }] : []), cartaoDoVoo(voo, indice, nomes[indice])]);
	return { texto: corpo, blocos: emSecoes(corpo), painel: { color: COR_DO_TAKI, blocks: [...cartoes, ...planilhas, botoesDeFrase(PROXIMOS_PASSOS)] } };
}

// ---------- BOAS-VINDAS E A ABA HOME ----------
// quem abre o Takifly pela primeira vez não sabe o que pedir: três exemplos, que também viram botões
const EXEMPLOS = [
	["✈️ Um voo", "voos de São Paulo para Lisboa em 12/12"],
	["📅 O mais barato do mês", "o voo mais barato de Salvador para Portugal em dezembro"],
	["🔔 Avisar quando baixar", "me avisa quando São Paulo–Recife em 20/12 baixar de R$ 600"],
];
const O_QUE_EU_FACO = "Eu procuro voos e hotéis de verdade no Google e te mostro o mais barato, o mais rápido e o melhor custo-benefício. Também acho o dia ou a cidade mais barata de um mês ou de um país, vigio um preço e te aviso quando ele cair, e respondo dúvidas de viagem: visto, clima, passaporte.";
export const BOAS_VINDAS = {
	text: ":taki: Oi! Eu sou o Takifly.",
	blocks: [
		{ type: "section", text: { type: "mrkdwn", text: `:taki: *Oi! Eu sou o Takifly.*\n${O_QUE_EU_FACO}\n\nMe escreve como você falaria com uma pessoa. Por exemplo:` } },
		botoesDeFrase(EXEMPLOS),
	],
};
export function telaInicial() {
	return {
		type: "home",
		blocks: [
			{ type: "header", text: { type: "plain_text", text: "Takifly" } },
			{ type: "section", text: { type: "mrkdwn", text: O_QUE_EU_FACO } },
			{ type: "divider" },
			{ type: "section", text: { type: "mrkdwn", text: `*Experimente, na aba Mensagens:*\n${EXEMPLOS.map(([, frase]) => `• ${frase}`).join("\n")}` } },
			{ type: "section", text: { type: "mrkdwn", text: "*Atalhos:* `contexto` mostra o que eu lembro da conversa · `para` interrompe uma busca · `volte` retoma a busca parada" } },
		],
	};
}

// ---------- OS CANAIS ----------
// Várias mensagens seguidas viram um pedido só. Cada mensagem zera um cronômetro de ESPERA_POR_MAIS; quando ele vence,
// as mensagens juntas (uma por linha) são o lote. Se nenhum pedido do canal está rodando, o lote vira um pedido.
// Se um está, o juiz (o modelo barato, com prazo curto) lê o pedido e o lote e escolhe:
//   refazer: o lote muda ou completa o pedido. O pedido é cancelado de verdade (AbortSignal até o grafo.stream, e o
//     responder desfaz ele no checkpointer) e um novo começa com as mensagens dele e as do lote;
//   fila: outro assunto. O pedido termina e o lote vem depois, com o "Peguei";
//   ignorar_espera: "ok", "valeu". Nada muda;
//   cancelar: "para", "stop", "esquece". O pedido rodando é cancelado e os que esperam na fila saem, sem pedido novo.
// Juiz que quebra ou demora vale fila: é o que o bot fazia antes, e nunca perde mensagem.
export const ESPERA_POR_MAIS = 2_000;    // quanto silêncio fecha um lote de mensagens (era 5 s até 09/11: a pessoa achou lento)
export const PRAZO_DO_JUIZ = 8_000;      // depois disso, sem decisão do juiz, vale fila
export const REFAZENDO = ":taki: Vi que você mudou o pedido. Refaço com a mensagem nova junto.";
export const PAREI = ":taki: Parei o pedido. Quando quiser, é só mandar de novo.";
export const NADA_PARA_PARAR = ":taki: Não tinha nada rodando para parar: o pedido já tinha terminado.";
export const RETOMANDO = ":taki: Volto para o pedido que eu tinha parado.";
// "volte", "continua", "pode seguir": a mensagem curta que só pede para voltar ao pedido parado
const RETOMAR = /^(volt[ae]|continu[ae]|retom[ae]|prossig[ae]|segue|pode (voltar|continuar|seguir|retomar))\b[^?]{0,30}$/;
const TEMPO_PARA_RETOMAR = 30 * 60_000;    // depois de meia hora, "volte" é conversa nova

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
	parado: { textos: string[]; quando: number } | null;    // o último pedido parado com "para", que um "volte" retoma
};

// o relógio que o teste troca: assim ele não espera de verdade
export type Relogio = { depois(ms: number, fazer: () => void): () => void };
const relogioDeVerdade: Relogio = {
	depois(ms, fazer) {
		const cronometro = setTimeout(fazer, ms);
		return () => clearTimeout(cronometro);
	},
};

// ---------- O JEV ----------
// O juiz roda no Jev, o modelo de classificação da TypeSafe: ele não escreve texto, só escolhe uma das quatro
// decisões e diz a confiança, em bem menos de 1 s (o modelo barato da Ollama levava segundos). O formato vem do
// pacote oficial @typesafe-ai/sdk 0.7.0 (POST /v1/systemone), chamado aqui com fetch, sem instalar o pacote.
// Sem TYPESAFE_API_KEY no .env, o juiz continua no modelo barato da Ollama.
const MODELO_DO_JEV = "jev-latest";
type DecisaoDoJuiz = { decisao: (typeof DECISOES_DO_JUIZ)[number]; motivo: string };
export type Jev = (emAndamento: string, nova: string, sinal: AbortSignal) => Promise<DecisaoDoJuiz>;

export function pedidoAoJev(emAndamento: string, nova: string) {
	return {
		model: MODELO_DO_JEV,
		state: { pedido_em_andamento: emAndamento, mensagem_nova: nova },
		questions: { decisao: { type: "choice", instructions: PERGUNTA_DO_JUIZ, criteria: CRITERIOS_DO_JUIZ } },
	};
}

export function lerRespostaDoJev(resposta: any): DecisaoDoJuiz {
	const { choice, confidence } = resposta?.answers?.decisao ?? {};
	if (!DECISOES_DO_JUIZ.includes(choice)) throw new Error(`o Jev respondeu sem uma decisão válida (${JSON.stringify(choice)})`);
	return { decisao: choice, motivo: typeof confidence === "number" ? `Jev, ${Math.round(confidence * 100)}% de confiança` : "Jev, sem confiança" };
}

const perguntarAoJev: Jev = async (emAndamento, nova, sinal) => {
	const resposta = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(pedidoAoJev(emAndamento, nova)),
		signal: sinal,
	});
	// o corpo do erro pode trazer o estado enviado (a mensagem da pessoa): para o log, só o código
	if (!resposta.ok) throw new Error(`o Jev respondeu com erro ${resposta.status}`);
	return lerRespostaDoJev(await resposta.json());
};

type Opcoes = { responder?: typeof responderDeVerdade; relogio?: Relogio; jev?: Jev; voosDaConversa?: (canal: string) => Promise<Voo[]> };

const novoPedido = (textos: string[]): Pedido => ({ tipo: "pedido", textos, controle: new AbortController(), fase: "fila" });

export function criarCanais(saida: Saida, opcoes: Opcoes = {}) {
	const responder = opcoes.responder ?? responderDeVerdade;
	const relogio = opcoes.relogio ?? relogioDeVerdade;
	const jev = opcoes.jev ?? (process.env.TYPESAFE_API_KEY ? perguntarAoJev : null);
	const voosDaConversa = opcoes.voosDaConversa ?? voosDeVerdade;
	const recebidos = new Set<string>();    // quem já ganhou as boas-vindas desde que o bot ligou
	const canais = new Map<string, EstadoDoCanal>();

	const doCanal = (canal: string) => {
		if (!canais.has(canal)) canais.set(canal, { fila: [], trabalhando: false, trabalho: Promise.resolve(), atual: null, chegando: [], pararCronometro: null, decidindo: Promise.resolve(), parado: null });
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
			// com voos citados, a resposta ganha os cartões e os botões. Se o Slack recusar os blocos, vai a resposta inteira, com o link
			const voos = voosCitados(await voosDaConversa(canal).catch(() => []), resposta);
			if (voos.length === 0) await comLinhaOuTexto(canal, resposta);
			else {
				// sem a linha do fim: o painel com a barra já separa esta resposta da próxima
				const { texto, blocos, painel } = blocosDaResposta(resposta, voos);
				await saida.dizer(canal, { text: texto, blocks: blocos, attachments: [painel] }).catch((erro) => {
					console.log(`[canal] o Slack recusou os cartões (${erro?.message}): mando só o texto`);
					return saida.dizer(canal, { text: resposta });
				});
			}
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
	// o Jev, ou sem a chave dele o modelo barato (a resposta passa pelo zod, Decisao); qualquer erro, ou o prazo vencendo, vira fila
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
			const chamada = jev
				? jev(emAndamento, nova, desistir.signal)
				: modelos.especialista.withStructuredOutput(Decisao, { name: "decidir", method: "functionCalling" })
					.invoke([new SystemMessage(INSTRUCOES_DO_JUIZ), new HumanMessage(`Pedido em andamento:\n${emAndamento}\n\nMensagem nova:\n${nova}`)], { callbacks: rastrear(canal, rotuloDosModelos()), signal: desistir.signal });
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
			// "volte" depois de um "para": o pedido parado começa de novo, em vez de virar conversa solta (09/11)
			const parado = estado.parado;
			estado.parado = null;
			if (parado && Date.now() - parado.quando <= TEMPO_PARA_RETOMAR && RETOMAR.test(semAcento(lote.join(" ")).trim())) {
				anotarNoPainel(canal, "juiz", `retomar: ${parado.textos.join(" / ").slice(0, 100)}`);
				await dizer(canal, RETOMANDO);
				return enfileirar(canal, novoPedido(parado.textos));
			}
			if (estado.trabalhando) await dizer(canal, PEGUEI);    // um compactar ou excluir rodando
			return enfileirar(canal, novoPedido(lote));
		}
		const { decisao, motivo, certo } = await julgar(canal, alvo.textos.join("\n"), lote.join("\n"));
		console.log(`[juiz] ${decisao}: ${motivo}`);
		anotarNoPainel(canal, "juiz", `${decisao}: ${motivo}`);
		anotar(canal, "juiz_das_mensagens", certo, `${decisao}: ${motivo}`);
		if (decisao === "ignorar_espera") return;
		// cancelar: até 09/11 o "stop" virava refazer, e o bot começava um pedido novo com o texto "stop" junto
		if (decisao === "cancelar") {
			const naFila = estado.fila.filter((tarefa): tarefa is Pedido => tarefa.tipo === "pedido");
			estado.fila = estado.fila.filter((tarefa) => tarefa.tipo !== "pedido");
			const agora = estado.atual && estado.atual.fase === "rodando" && !estado.atual.controle.signal.aborted ? estado.atual : null;
			if (agora) cancelar(canal, "a pessoa pediu para parar");
			const textos = [...(agora?.textos ?? []), ...naFila.flatMap((pedido) => pedido.textos)];
			if (textos.length > 0) estado.parado = { textos, quando: Date.now() };
			return void (await dizer(canal, agora || naFila.length > 0 ? PAREI : NADA_PARA_PARAR));
		}
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

	// o botão de frase (próximo passo ou exemplo): a frase aparece no canal, para a resposta ter contexto, e segue
	// como se a pessoa tivesse escrito
	async function frase(canal: string, texto: string) {
		await saida.dizer(canal, { text: `:point_right: _${texto}_` }).catch(console.log);
		return receber(canal, texto);
	}

	// a primeira vez que a pessoa abre a conversa com o bot. Quem já conversou (está no checkpointer) não ganha de novo
	async function boasVindas(canal: string) {
		if (recebidos.has(canal) || listarConversas().includes(canal)) return;
		recebidos.add(canal);
		await saida.dizer(canal, BOAS_VINDAS).catch(console.log);
	}

	return { receber, botao, frase, boasVindas, comando, vazio, acoesDoPainel };
}
