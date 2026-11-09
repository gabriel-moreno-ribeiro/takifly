// bot.ts - os ouvidos e a boca do bot: recebe a mensagem no Slack, chama o grafo (brain/graph.ts) e responde
//
// Como rodar (dentro da pasta passagens.ts/):   node bot.ts        (Ctrl+C para parar)
// O vigia de preços é outro programa, em outro terminal:   node watcher.ts
// Para ligar os dois de uma vez e deixar ligados (religam sozinhos se caírem):   node takifly.ts start

// ---------- BIBLIOTECA ----------
// puxa da biblioteca do Slack, as 21929129120 milhoes de bibliotecas para a biblioteca do slack funcionar e puxa apenas o que eu quero dela que é a parte de APP, ou seja, o bot em si, para ele nao apenas conseguir se conectar com o slack mas tambem conversar com ele
import { App } from "@slack/bolt";

// puxa do NOSSO arquivo brain/channel.ts (o "./" quer dizer "aqui nesta mesma pasta") o que o bot faz com cada
// mensagem: a fila de cada canal e os comandos de contexto. Aqui fica só a ligação com o Slack
import { comLinha, criarCanais, telaInicial } from "./brain/channel.ts";
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
// o Slack às vezes entrega a mesma mensagem duas vezes; o "ts" é o id único de cada mensagem
const mensagensVistas = new Set<string>();

// unfurl desligado: sem isso o Slack pendura um cartão de prévia do Google embaixo de cada link
const SEM_PREVIA = { unfurl_links: false, unfurl_media: false };

// a fila de cada canal (um pedido por vez) e os comandos de contexto moram em brain/channel.ts; ele fala com o
// Slack por estas três funções. dizer devolve o "ts", o id da mensagem, para o aviso de progresso ser editado e apagado
const canais = criarCanais({
	dizer: async (canal, mensagem) => (await app.client.chat.postMessage({ channel: canal, ...mensagem, ...SEM_PREVIA } as any)).ts,
	editar: (canal, id, texto) => app.client.chat.update({ channel: canal, ts: id, text: texto }),
	apagar: (canal, id) => app.client.chat.delete({ channel: canal, ts: id }),
});

// ---------- RESPONDER ----------
// toda vez que chegar uma mensagem, o Slack chama esta função
app.message(async ({ message, say }) => {
	// foto, áudio ou arquivo chegam com subtype "file_share"; editada, apagada etc. têm outros subtypes e ficam de fora
	if (message.subtype !== undefined && message.subtype !== "file_share") return;
	if (mensagensVistas.has(message.ts)) return;
	if (mensagensVistas.size > 5000) mensagensVistas.clear();    // shortcut: a trava só precisa lembrar os últimos minutos, e assim a memória não cresce para sempre
	mensagensVistas.add(message.ts);

	const texto = message.text?.trim();
	if (!texto) {
		// só o arquivo, sem texto: o modelo não lê arquivo, então o bot diz isso em vez de ficar calado
		const tipo = message.subtype === "file_share" ? message.files?.[0]?.mimetype ?? "" : "";
		await say(comLinha(tipo.startsWith("audio") ? "Ainda não consigo ouvir áudio. Me escreve o pedido que eu procuro." : "Ainda não consigo ler foto nem arquivo. Me escreve de onde você sai, para onde vai e quando, que eu procuro.") as any);
		return;
	}
	console.log("Chegou uma mensagem: " + texto);
	// cada canal do Slack é uma conversa separada na memória
	await canais.receber(message.channel, texto);
});

// ---------- BOTÕES ----------
// os botões "Compactar" e "Excluir" da resposta do "contexto". Só chegam aqui com "Interactivity" ligada no app do
// Slack (api.slack.com → Interactivity & Shortcuts); sem ela, os textos "compactar contexto" e "excluir contexto" fazem o mesmo.
// O ack() vem antes: o Slack desiste do clique se não ouvir nada em 3 segundos
for (const qual of ["compactar", "excluir"] as const) {
	app.action(`contexto_${qual}`, async ({ ack, body }) => {
		await ack();
		const canal = (body as any).channel?.id;
		if (canal) await canais.botao(canal, qual);
	});
}

// os botões embaixo de uma resposta com voos ("Só diretos", "Dia seguinte"...) e os exemplos das boas-vindas:
// clicar vale como mandar a frase do botão
app.action(/^frase_/, async ({ ack, body, action }) => {
	await ack();
	const canal = (body as any).channel?.id;
	const frase = (action as any).value;
	if (canal && frase) await canais.frase(canal, frase);
});
// "Comprar" é um link e o Slack abre sozinho, mas ele espera o ack para não mostrar um aviso de erro no botão
app.action(/^comprar_/, async ({ ack }) => {
	await ack();
});

// ---------- BOAS-VINDAS E A ABA HOME ----------
// precisa, em api.slack.com: App Home → ligar a Home Tab; Event Subscriptions → bot event app_home_opened
app.event("app_home_opened", async ({ event, client }) => {
	if (event.tab === "home") await client.views.publish({ user_id: event.user, view: telaInicial() as any }).catch((erro) => console.log(`[home] não publiquei a aba Home: ${erro.message}`));
	if (event.tab === "messages" && event.channel) await canais.boasVindas(event.channel);
});

// ---------- LIGAR ----------
await app.start();
console.log("Takifly ligado no Slack. O Taki está de orelha em pé. Ctrl+C para desligar.");
ligarPainel(undefined, canais.acoesDoPainel);    // http://localhost:4500 mostra cada passo do grafo ao vivo e as conversas (brain/live.ts)

// ---------- MONITORAMENTOS ----------
// o vigia de preços NÃO roda aqui: ele é outro programa (watcher.ts), para não cair junto se o bot cair.
// Daqui o bot só grava o monitoramento no dados.sqlite; quem confere o preço e avisa é o vigia.
