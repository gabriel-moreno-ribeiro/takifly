// pensar.ts - passo 11: o "cérebro" do bot. Recebe a CONVERSA inteira, pergunta ao modelo e devolve a resposta.
//
// Este arquivo não roda sozinho: quem usa ele é o bot.ts (com o import { pensar } from "./pensar.ts").
// A chave OLLAMA_API_KEY já foi lida do .env pelo bot.ts.

// o formato de cada mensagem da conversa: quem falou ("user" = você, "assistant" = o bot) e o que falou
export type Mensagem = { role: string; content: string };

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
			messages: conversa,    // mandamos TODAS as mensagens: é assim que o modelo "lembra"
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
