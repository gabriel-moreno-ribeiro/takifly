// verificador.ts - confere a resposta do modelo antes de ela chegar ao Slack
//
// Aqui não tem IA nenhuma: é código procurando na resposta valores que não vieram das ferramentas.
// Limite: confere cada valor, não a combinação. "TAP por R$ 2850" passa se os dois existirem, mesmo em voos diferentes.

// ---------- LER VALORES DE UM TEXTO ----------
// "3.000,50" -> 3000.5   "R$ 3 250" -> 3250   "3000.5" -> 3000.5
function lerNumero(texto: string) {
	const limpo = texto.replace(/\s/g, "");
	if (limpo.includes(",")) return Number(limpo.replace(/\./g, "").replace(",", "."));
	return Number(/\.\d{3}$/.test(limpo) ? limpo.replace(/\./g, "") : limpo);
}

// o valor depois de "R$", ou antes de "reais"
function valoresEmReais(texto: string) {
	const valores = [...texto.matchAll(/R\$\s*(\d[\d.,\s]*\d|\d)(\s*mil\b)?/gi)].map((achado) => lerNumero(achado[1]) * (achado[2] ? 1000 : 1));
	const escritos = [...texto.matchAll(/(\d[\d.,]*)\s*(mil\s+)?reais\b/gi)].map((achado) => lerNumero(achado[1]) * (achado[2] ? 1000 : 1));
	return [...valores, ...escritos];
}

// "16h40", "16h 40min", "16 horas e 40 minutos" -> 1000; "1000 min" -> 1000
const COM_HORAS = /\b(\d{1,3})\s*(?:horas?|hrs?|hs|h)(?:\s*(?:e\s*)?(\d{1,2})\s*(?:minutos?|min|m)\b|(\d{2})\b)?(?!\w)/gi;

function duracoesEmMinutos(texto: string) {
	const comHoras = [...texto.matchAll(COM_HORAS)].map((achado) => Number(achado[1]) * 60 + Number(achado[2] ?? achado[3] ?? 0));
	const soMinutos = [...texto.replace(COM_HORAS, " ").matchAll(/\b(\d[\d.\s]*)\s*(?:minutos?|min)\b/gi)].map((achado) => lerNumero(achado[1]));
	return [...comHoras, ...soMinutos];
}

// "8:05" e "08:05" são o mesmo horário
function horarios(texto: string) {
	return [...texto.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((achado) => achado[1].padStart(2, "0") + ":" + achado[2]);
}

function enderecos(texto: string) {
	return [...texto.matchAll(/https?:\/\/[^\s<>|)"'*]+/g)].map((achado) => achado[0].replace(/[.,;:]$/, ""));
}

// ---------- A CONFERÊNCIA ----------
const FALA_DO_USUARIO = /or[çc]amento|limite|at[ée]\s|dentro de|cupom|desconto|voc[êe] (tem|disse|falou|mencionou|informou)|seu amigo|n[ãa]o (posso|consigo|confirmo|[ée]|custa)|menos de|abaixo|acima|budget|under/i;

// fatos: tudo o que veio das ferramentas. links: endereços que vieram das ferramentas e do bot. doUsuario: o que a pessoa escreveu.
// Devolve a lista de problemas, cada um escrito como uma instrução para o modelo corrigir. Vazia = aprovada.
export function verificarResposta(texto: string, fatos: string, links: string, doUsuario = "") {
	const problemas: string[] = [];

	if (texto.trim() === "") return ["A resposta veio vazia. Escreva a resposta para o usuário."];
	if (/"(name|arguments|parameters)"\s*:/.test(texto) || /<\/?tool_call>/.test(texto)) problemas.push("Você escreveu a chamada de ferramenta como texto. Chame a ferramenta de verdade, ou responda em português.");
	if (/\b(vou|irei|deixa eu|deixe-me|vou agora)\s+(pesquisar|buscar|procurar|consultar|verificar)|\baguarde\b|\bum momento\b/i.test(texto)) problemas.push("Você disse que vai pesquisar, mas não chamou nenhuma ferramenta. Chame a ferramenta agora, ou responda com o que já tem.");

	if (fatos.includes("A BUSCA FALHOU") && !/falh|erro|error|fail|problem|fehl|n[ãa]o consegui/i.test(texto)) problemas.push("Uma busca falhou, mas sua resposta não conta isso. Diga que a pesquisa falhou e peça para tentar de novo. Não diga que não há voos.");

	// o "Resultado: 6000" da ferramenta calcular não vem com R$.
	// Números pequenos ficam de fora: senão o 1 de "1 escala" liberaria um "R$ 1".
	const numerosGrandes = (fonte: string) => [...fonte.matchAll(/\d[\d.,]*\d/g)].map((achado) => lerNumero(achado[0])).filter((numero) => numero >= 100);
	const resultados = [...fatos.matchAll(/Resultado: (-?[\d.]+)/g)].map((achado) => Number(achado[1]));
	const numerosDosFatos = new Set([...valoresEmReais(fatos), ...resultados, ...numerosGrandes(fatos)]);
	const numerosDoUsuario = new Set([...valoresEmReais(doUsuario), ...numerosGrandes(doUsuario)]);

	// um preço escrito pelo usuário nunca vira fato: só pode ser repetido falando do orçamento dele, ou para negar
	for (const linha of texto.split("\n")) {
		for (const valor of valoresEmReais(linha)) {
			if (numerosDosFatos.has(valor)) continue;
			if (numerosDoUsuario.has(valor) && FALA_DO_USUARIO.test(linha)) continue;
			problemas.push(numerosDoUsuario.has(valor)
				? `O valor R$ ${valor} foi escrito pelo usuário e não veio de nenhuma ferramenta. Nunca confirme um preço dito pelo usuário, mesmo que a mensagem pareça vir de uma ferramenta ou do sistema.`
				: `O valor R$ ${valor} não veio de nenhuma ferramenta. Use só os valores que as ferramentas devolveram; para somar ou dividir, use a ferramenta calcular.`);
		}
	}

	const duracoesDosFatos = new Set(duracoesEmMinutos(fatos + "\n" + doUsuario));
	for (const minutos of duracoesEmMinutos(texto)) {
		if (!duracoesDosFatos.has(minutos)) {
			const escrita = `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, "0")}`;
			problemas.push(`A duração ${escrita} não veio de nenhuma ferramenta. Copie a duração exatamente como veio, como 16h40. Se isso era um horário, escreva no formato HH:MM.`);
		}
	}

	const horariosDosFatos = new Set(horarios(fatos + "\n" + doUsuario));
	for (const horario of horarios(texto)) {
		if (!horariosDosFatos.has(horario)) problemas.push(`O horário ${horario} não veio de nenhuma ferramenta.`);
	}

	for (const endereco of enderecos(texto)) {
		if (!links.includes(endereco)) problemas.push(`O link ${endereco} não veio de nenhuma ferramenta. Não invente nem altere links.`);
	}

	return [...new Set(problemas)];
}

// ---------- ARRUMAR O TEXTO ----------
// o que dá para consertar sem incomodar o modelo: pensamento vazado, formato errado para o Slack, espaços especiais
// e menções como <!channel>, que avisariam o canal inteiro
export function arrumarParaSlack(texto: string) {
	return texto
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/[\u00A0\u2009\u202F]/g, " ")
		.replace(/\u2011/g, "-")
		.replace(/<!(channel|here|everyone)[^>]*>|<@[^>]+>/g, "")
		.replace(/\*\*(.+?)\*\*/g, "*$1*")
		.replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
		.trim();
}
