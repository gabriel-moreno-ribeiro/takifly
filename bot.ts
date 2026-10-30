// bot.ts - os ouvidos e a boca do bot: recebe a mensagem no Slack, chama o grafo (agente.ts) e responde
//
// Como rodar (dentro da pasta passagens.ts/):   node bot.ts        (Ctrl+C para parar)

// ---------- BIBLIOTECA ----------
// puxa da biblioteca do Slack, as 21929129120 milhoes de bibliotecas para a biblioteca do slack funcionar e puxa apenas o que eu quero dela que é a parte de APP, ou seja, o bot em si, para ele nao apenas conseguir se conectar com o slack mas tambem conversar com ele
import { App } from "@slack/bolt";

// puxa a função responder do NOSSO arquivo agente.ts (o "./" quer dizer "aqui nesta mesma pasta")
import { responder } from "./agente.ts";

// ---------- CHAVES ----------
// lê o arquivo .env e guarda cada chave em process.env (depois esse process.env vai dar o valor da chave API em si ao process.env.SLACK_BOT_TOKEN
process.loadEnvFile(".env");

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
app.message(async ({ message, say }) => {
	// mensagem editada, apagada etc. tem um "subtype"; só queremos as mensagens normais, que trazem texto
	if (message.subtype !== undefined) return;

	const texto = message.text;
	if (texto === undefined) return;    // mensagem só com foto ou arquivo: não tem texto para mandar ao modelo
	if (mensagensVistas.has(message.ts)) return;
	mensagensVistas.add(message.ts);
	console.log("Chegou uma mensagem: " + texto);

	await naFila(message.channel, async () => {
		try {
			// cada canal do Slack é uma conversa separada na memória
			const resposta = await responder(message.channel, texto);
			console.log("O bot respondeu: " + resposta);
			await say(resposta);
		} catch (erro: any) {
			console.log("Deu erro: ", erro);
			await say("Deu erro: " + erro.message + "\nPode mandar de novo daqui a pouco: eu continuo de onde parei.");
		}
	});
});

// ---------- LIGAR ----------
await app.start();
console.log("Bot ligado no Slack! Ctrl+C para desligar.");
