// bot.ts - passo 10: o bot lê o que você escreveu, pergunta ao modelo e responde no Slack
//
// Como rodar (dentro da pasta passagens.ts/):   node bot.ts        (Ctrl+C para parar)

// ---------- BIBLIOTECA ----------
// puxa da biblioteca do Slack, as 21929129120 milhoes de bibliotecas para a biblioteca do slack funcionar e puxa apenas o que eu quero dela que é a parte de APP, ou seja, o bot em si, para ele nao apenas conseguir se conectar com o slack mas tambem conversar com ele
import { App } from "@slack/bolt";

// puxa a função pensar do NOSSO arquivo pensar.ts (o "./" quer dizer "aqui nesta mesma pasta")
import { pensar } from "./pensar.ts";

// ---------- CHAVES ----------
// lê o arquivo .env e guarda cada chave em process.env (depois esse process.env vai dar o valor da chave API em si ao process.env.SLACK_BOT_TOKEN
process.loadEnvFile(".env");

// ---------- CONEXÃO COM O SLACK ----------
const app = new App({
	token: process.env.SLACK_BOT_TOKEN,    // o crachá do bot (xoxb-...)
	appToken: process.env.SLACK_APP_TOKEN, // a permissão para conectar do seu Mac (xapp-...)
	socketMode: true,                      // o bot liga para o Slack, e não o contrário
});

// ---------- RESPONDER ----------
// toda vez que chegar uma mensagem, o Slack chama esta função
app.message(async ({ message, say }) => {
	// mensagem editada, apagada etc. tem um "subtype"; só queremos as mensagens normais, que trazem texto
	if (message.subtype !== undefined) return;

	const texto = message.text;
	if (texto === undefined) return;    // mensagem só com foto ou arquivo: não tem texto para mandar ao modelo
	console.log("Chegou uma mensagem: " + texto);

	const respostaDoModelo = await pensar(texto);
	console.log("O modelo respondeu: " + respostaDoModelo);
	await say(respostaDoModelo);

});

// ---------- LIGAR ----------
await app.start();
console.log("Bot ligado no Slack! Ctrl+C para desligar.");
