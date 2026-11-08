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
import { explicarErro } from "./brain/checker.ts";
import { ligarPainel } from "./brain/live.ts";

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

// os canais com um pedido em andamento: quem manda outra mensagem nessa hora fica sabendo que ela entrou na fila
const ocupados = new Set<string>();

// unfurl desligado: sem isso o Slack pendura um cartão de prévia do Google embaixo de cada link
const SEM_PREVIA = { unfurl_links: false, unfurl_media: false };

// ---------- RESPONDER ----------
// toda vez que chegar uma mensagem, o Slack chama esta função
app.message(async ({ message, say, client }) => {
	// foto, áudio ou arquivo chegam com subtype "file_share"; editada, apagada etc. têm outros subtypes e ficam de fora
	if (message.subtype !== undefined && message.subtype !== "file_share") return;
	if (mensagensVistas.has(message.ts)) return;
	if (mensagensVistas.size > 5000) mensagensVistas.clear();    // shortcut: a trava só precisa lembrar os últimos minutos, e assim a memória não cresce para sempre
	mensagensVistas.add(message.ts);

	const texto = message.text?.trim();
	if (!texto) {
		// só o arquivo, sem texto: o modelo não lê arquivo, então o bot diz isso em vez de ficar calado
		const tipo = message.subtype === "file_share" ? message.files?.[0]?.mimetype ?? "" : "";
		await say(tipo.startsWith("audio") ? "Ainda não consigo ouvir áudio. Me escreve o pedido que eu procuro." : "Ainda não consigo ler foto nem arquivo. Me escreve de onde você sai, para onde vai e quando, que eu procuro.");
		return;
	}
	console.log("Chegou uma mensagem: " + texto);

	const canal = message.channel;
	if (ocupados.has(canal)) await say(":taki: Peguei. Termino o pedido anterior e já vejo esse.").catch(console.log);

	await naFila(canal, async () => {
		ocupados.add(canal);
		// uma mensagem de progresso que vai sendo editada e some no fim. Ela é só um enfeite: se falhar, o pedido segue
		const aviso = await say(":taki: O Taki está farejando...").catch(() => undefined);
		const idDoAviso = aviso?.ts;

		try {
			// cada canal do Slack é uma conversa separada na memória
			const resposta = await responder(canal, texto, async (progresso) => {
				if (idDoAviso) await client.chat.update({ channel: canal, ts: idDoAviso, text: progresso }).catch(console.log);
			});
			console.log("O bot respondeu: " + resposta);
			await say({ text: resposta, ...SEM_PREVIA });
		} catch (erro: any) {
			console.log("Deu erro: ", erro);    // o erro técnico fica no log; a pessoa lê o que aconteceu e o que fazer
			await say(explicarErro(erro)).catch(console.log);
		} finally {
			ocupados.delete(canal);
		}
		if (idDoAviso) await client.chat.delete({ channel: canal, ts: idDoAviso }).catch(console.log);
	});
});

// ---------- LIGAR ----------
await app.start();
console.log("Takifly ligado no Slack. O Taki está de orelha em pé. Ctrl+C para desligar.");
ligarPainel();    // http://localhost:4500 mostra cada passo do grafo ao vivo (brain/live.ts)

// ---------- MONITORAMENTOS ----------
// o vigia de preços NÃO roda aqui: ele é outro programa (watcher.ts), para não cair junto se o bot cair.
// Daqui o bot só grava o monitoramento no dados.sqlite; quem confere o preço e avisa é o vigia.
