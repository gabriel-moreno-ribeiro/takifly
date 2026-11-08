// email.ts - manda o mesmo aviso do Slack por e-mail, usando a API da Resend com fetch puro
//
// Por que Resend e não Gmail: mandar pelo Gmail é SMTP, e o Node não traz cliente SMTP na biblioteca
// padrão - precisaria instalar o nodemailer. A Resend recebe um POST normal, então dá para usar o
// mesmo fetch que o flights.ts já usa, sem dependência nova.
//
// ---------- O QUE VOCÊ PRECISA FAZER (só você pode fazer esta parte) ----------
// 1. Abra https://resend.com e crie a conta grátis com o SEU e-mail (não pede cartão de crédito).
//    O plano grátis dá 3.000 e-mails por mês, no máximo 100 por dia: muito mais do que o bot gasta.
// 2. Confirme o e-mail de boas-vindas que a Resend manda, senão a chave não funciona.
// 3. No painel, vá em "API Keys" → "Create API Key", dê qualquer nome e copie a chave (começa com re_).
//    Ela aparece UMA vez só: copie antes de fechar a janela.
// 4. Abra o arquivo .env (na pasta passagens.ts/) e acrescente estas duas linhas:
//
//        EMAIL_CHAVE=re_cole_a_sua_chave_aqui
//        EMAIL_PARA=o-mesmo-email-da-sua-conta-resend@exemplo.com
//
// 5. Teste no terminal, de dentro da pasta passagens.ts/:   node sources/email.ts "teste" "oi"
//
// ATENÇÃO ao passo 4: sem domínio próprio, a Resend só entrega para o e-mail da sua própria conta.
// Mandar para qualquer outro endereço volta com erro 403. Para avisar outra pessoa, você precisa ter
// um domínio seu, verificá-lo no painel da Resend (ela pede uns registros no DNS) e aí pôr uma terceira
// linha no .env com um remetente desse domínio, por exemplo:
//
//        EMAIL_DE=Takifly <avisos@seudominio.com.br>
//
// Sem as linhas no .env o e-mail fica desligado e o bot roda igual, só avisando pelo Slack.

import { existsSync } from "node:fs";

// sem .env (worktree nova, CI), as chaves vêm do ambiente: os testes não precisam delas
if (existsSync(import.meta.dirname + "/../.env")) process.loadEnvFile(import.meta.dirname + "/../.env");

// o remetente de teste da Resend: serve sem domínio nenhum, e é por isso que ele é o padrão aqui
const REMETENTE_DE_TESTE = "Takifly <onboarding@resend.dev>";

// ---------- MONTAR O PEDIDO ----------
// separado do envio para dar para conferir no tests.ts sem internet, igual ao montarTfs do flights.ts
export function montarPedido(chave: string, de: string, para: string, assunto: string, texto: string) {
	return {
		endereco: "https://api.resend.com/emails",
		opcoes: {
			method: "POST",
			headers: {
				Authorization: "Bearer " + chave,
				"Content-Type": "application/json",
			},
			// text e não html: o aviso é a mesma frase que vai para o Slack, não precisa de enfeite
			body: JSON.stringify({ from: de, to: [para], subject: assunto, text: texto }),
			signal: AbortSignal.timeout(15_000),    // desiste depois de 15 segundos, para não travar a checagem de preço
		},
	};
}

// ---------- MANDAR ----------
// esta função NUNCA lança erro: ela é chamada de dentro do monitor, e um aviso que não saiu não pode
// matar a checagem de preço. Todo problema vira uma linha no console e a vida continua.
export async function mandarEmail(assunto: string, texto: string): Promise<void> {
	const chave = process.env.EMAIL_CHAVE;
	const para = process.env.EMAIL_PARA;
	if (!chave || !para) {
		console.log("[email] desligado: faltam EMAIL_CHAVE e EMAIL_PARA no .env (o aviso foi só para o Slack)");
		return;
	}

	const pedido = montarPedido(chave, process.env.EMAIL_DE || REMETENTE_DE_TESTE, para, assunto, texto);
	try {
		const resposta = await fetch(pedido.endereco, pedido.opcoes);
		if (!resposta.ok) {
			// a Resend explica o motivo no corpo da resposta, e a explicação é o que resolve: sem ela
			// o 403 de remetente sem domínio fica parecido com o 401 de chave errada
			console.log(`[email] a Resend recusou (erro ${resposta.status}): ${(await resposta.text()).slice(0, 300)}`);
			return;
		}
		console.log(`[email] avisei ${para}: ${assunto}`);
	} catch (erro) {
		console.log(`[email] não consegui mandar: ${(erro as Error).message}`);
	}
}

// ---------- TESTE PELO TERMINAL ----------
// só roda com "node sources/email.ts ...", não quando outro arquivo importa este
if (import.meta.main) {
	await mandarEmail(process.argv[2] ?? "teste do Takifly", process.argv[3] ?? "Se você está lendo isto, o e-mail está funcionando e o Taki mandou um oi.");
}
