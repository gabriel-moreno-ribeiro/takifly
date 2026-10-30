// pensar.ts - passo 10: o "cérebro" do bot. Recebe um texto, pergunta ao modelo e devolve a resposta.
//
// Este arquivo não roda sozinho: quem usa ele é o bot.ts (com o import { pensar } from "./pensar.ts").
// A chave OLLAMA_API_KEY já foi lida do .env pelo bot.ts.

// "export" deixa outros arquivos usarem esta função; "async" porque lá dentro esperamos a internet
export async function pensar(pergunta: string) {
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
			messages: [{ role: "user", content: pergunta }],
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
