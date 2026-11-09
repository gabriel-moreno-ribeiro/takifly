// models.ts - qual modelo faz cada papel. Fica fora do graph.ts para a prova, o juiz de escrita e o painel
// lerem o nome sem abrir o banco do bot.
//
// Dois papéis. O forte decide e escreve (orquestrador e redator): é onde um erro muda a resposta.
// O barato só escolhe ferramenta e argumento (especialistas, contexto e memória), resume no compactar e julga as mensagens
// seguidas (brain/context.ts, brain/channel.ts): o código em volta confere quase tudo.
// Escolha da pessoa em 08/11/2026: glm-5.3 no forte e glm-5.3-flash no barato (9x mais barato na saída).
// MODELO troca os dois de uma vez (a prova compara modelos assim); MODELO_FORTE e MODELO_ESPECIALISTA trocam um só.
//
// São funções, e não constantes: o .env é lido depois dos imports, então uma constante aqui não o veria.
export function nomesDosModelos() {
	return {
		forte: process.env.MODELO_FORTE ?? process.env.MODELO ?? "glm-5.3",
		especialista: process.env.MODELO_ESPECIALISTA ?? process.env.MODELO ?? "glm-5.3-flash",
	};
}

// o nome que vai para o Langfuse e para o arquivo da prova: "glm-5.3+glm-5.3-flash", ou um só quando são iguais
export function rotuloDosModelos() {
	const { forte, especialista } = nomesDosModelos();
	return forte === especialista ? forte : `${forte}+${especialista}`;
}
