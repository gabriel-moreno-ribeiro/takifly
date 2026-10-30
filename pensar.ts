// pensar.ts - passo 12: o "cérebro" do bot. Recebe a conversa, junta as instruções, pergunta ao modelo e devolve a resposta.
//
// Este arquivo não roda sozinho: quem usa ele é o bot.ts (com o import { pensar } from "./pensar.ts").
// A chave OLLAMA_API_KEY já foi lida do .env pelo bot.ts.

// o formato de cada mensagem da conversa: quem falou ("user" = você, "assistant" = o bot) e o que falou
export type Mensagem = { role: string; content: string };

// ---------- PROMPT DE SISTEMA ----------
// as regras do trabalho: vão no começo de TODA carta, antes da conversa
const INSTRUCOES = `Você é o assistente de passagens aéreas do Gabriel, e conversa com ele pelo Slack.
Responda curto e direto, no mesmo idioma em que ele escrever.
Você ainda NÃO consegue pesquisar voos nem ver preços de verdade: nunca invente preços, horários ou companhias.
Se ele pedir uma pesquisa, explique que essa função ainda está sendo construída.
Para negrito, use *um asterisco de cada lado* (é o formato do Slack).`;

// "export" deixa outros arquivos usarem esta função; "async" porque lá dentro esperamos a internet
export async function pensar(conversa: Mensagem[]) {
	// ---------- MANDAR PARA O MODELO ----------
	// fetch já vem no Node: manda um pedido pela internet (aqui, para os computadores da Ollama Cloud)
	const resposta = await fetch("https://ollama.com/v1/chat/completions", {
		method: "POST",                                             // POST = "estou mandando dados"
		headers: {
			"Content-Type": "application/json",                     // os dados vão em formato JSON
			"Authorization": "Bearer " + process.env.OLLAMA_API_KEY, // a chave que prova que é você
		},
		body: JSON.stringify({
			model: "glm-5.3",
			// primeiro as instruções, depois TODAS as mensagens da conversa ("..." = "cada item de")
			messages: [{ role: "system", content: INSTRUCOES }, ...conversa],
		}),
	});

	// ---------- LER A RESPOSTA ----------
	// se der erro, devolvemos o erro como texto: assim ele aparece no Slack e você vê o que houve
	if (!resposta.ok) {
		return "Deu erro na Ollama: " + resposta.status + " " + (await resposta.text());
	}
	const dados = await resposta.json();
	return dados.choices[0].message.content;
}
