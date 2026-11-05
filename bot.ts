// bot.ts - os ouvidos e a boca do bot: recebe a mensagem no Slack, chama o grafo (brain/graph.ts) e responde
//
// Como rodar (dentro da pasta passagens.ts/):   node bot.ts        (Ctrl+C para parar)
// O vigia de preços é outro programa, em outro terminal:   node watcher.ts
// Para ligar os dois de uma vez e deixar ligados (religam sozinhos se caírem):   node takifly.ts start

// ---------- BIBLIOTECA ----------
// puxa da biblioteca do Slack, as 21929129120 milhoes de bibliotecas para a biblioteca do slack funcionar e puxa apenas o que eu quero dela que é a parte de APP, ou seja, o bot em si, para ele nao apenas conseguir se conectar com o slack mas tambem conversar com ele
import { App } from "@slack/bolt";

// puxa a função responder do NOSSO arquivo brain/graph.ts (o "./" quer dizer "aqui nesta mesma pasta")
import { responder } from "./brain/graph.ts";

// ---------- CHAVES ----------
// lê o arquivo .env e guarda cada chave em process.env (depois esse process.env vai dar o valor da chave API em si ao process.env.SLACK_BOT_TOKEN
process.loadEnvFile(import.meta.dirname + "/.env");

// ---------- CONEXÃO COM O SLACK ----------
const app = new App({
	token: process.env.SLACK_BOT_TOKEN,    // o crachá do bot (xoxb-...)
	appToken: process.env.SLACK_APP_TOKEN, // a permissão para conectar do seu Mac (xapp-...)
	socketMode: true,                      // o bot liga para o Slack, e não o contrário
});

// ---------- ORDEM DAS MENSAGENS ----------
// um pedido por vez em cada canal: dois ao mesmo tempo mexeriam na mesma conversa e bagunçariam a memória
const filaDoCanal = new Map<string, Promise<void>>();

function naFila(canal: string, trabalho: () => Promise<void>) {
	const anterior = filaDoCanal.get(canal) ?? Promise.resolve();
	const proximo = anterior.then(trabalho, trabalho);
	filaDoCanal.set(canal, proximo);
	return proximo;
}

// o Slack às vezes entrega a mesma mensagem duas vezes; o "ts" é o id único de cada mensagem
const mensagensVistas = new Set<string>();

// ---------- RESPONDER ----------
// toda vez que chegar uma mensagem, o Slack chama esta função
app.message(async ({ message, say, client }) => {
	// mensagem editada, apagada etc. tem um "subtype"; só queremos as mensagens normais, que trazem texto
	if (message.subtype !== undefined) return;

	const texto = message.text;
	if (texto === undefined) return;    // mensagem só com foto ou arquivo: não tem texto para mandar ao modelo
	if (mensagensVistas.has(message.ts)) return;
	mensagensVistas.add(message.ts);
	console.log("Chegou uma mensagem: " + texto);

	await naFila(message.channel, async () => {
		// uma mensagem de progresso que vai sendo editada e some no fim
		const aviso = await say(":dog: O Taki está farejando...");
		const canal = message.channel;
		const idDoAviso = aviso.ts!;

		try {
			// cada canal do Slack é uma conversa separada na memória
			const resposta = await responder(canal, texto, async (progresso) => {
				// se o aviso falhar, o pedido continua: ele é só um enfeite
				await client.chat.update({ channel: canal, ts: idDoAviso, text: progresso }).catch(console.log);
			});
			console.log("O bot respondeu: " + resposta);
			await say(resposta);
		} catch (erro: any) {
			console.log("Deu erro: ", erro);
			await say("O Taki tropeçou: " + erro.message + "\nManda de novo daqui a pouco que eu continuo de onde parei.");
		}
		await client.chat.delete({ channel: canal, ts: idDoAviso }).catch(console.log);
	});
});

// ---------- LIGAR ----------
await app.start();
console.log("Takifly ligado no Slack. O Taki está de orelha em pé. Ctrl+C para desligar.");

// ---------- MONITORAMENTOS ----------
// o vigia de preços NÃO roda aqui: ele é outro programa (watcher.ts), para não cair junto se o bot cair.
// Daqui o bot só grava o monitoramento no dados.sqlite; quem confere o preço e avisa é o vigia.
