// guarda.ts - hook PreToolUse do Claude Code: pede o ok da pessoa antes de um comando que gasta crédito, mexe nos serviços ou usa .env, data/ ou logs/
//
// Quem roda é o Claude Code (.claude/settings.json), com o JSON da ferramenta Bash na entrada padrão.
// Testar à mão (dentro da pasta passagens.ts/):   echo '{"tool_input":{"command":"npm test"}}' | node .claude/hooks/guarda.ts
// Sem saída, o comando passa; com saída, o Claude Code pergunta à pessoa. Os casos estão no bloco A GUARDA DO CLAUDE do quality/tests.ts.

import { readFileSync } from "node:fs";

// shortcut: olha o texto do comando, então "npx tsx quality/exam.ts" passa e um grep pelo texto "node quality/exam.ts" pergunta; trocar por análise do shell se acontecer
const REGRAS: [RegExp, string][] = [
	[/\bnode\s[^;&|]*?takifly\.ts["']?\s+["']?(start|stop|restart)\b/, "liga, desliga ou reinicia o bot e o vigia que estão no ar"],
	[/\blaunchctl\s[^;&|]*com\.takifly\./, "liga, desliga ou reinicia o bot e o vigia que estão no ar"],
	// sem exigir a pasta: "cd quality && node exam.ts" também gasta. Nenhum outro arquivo do repo tem esses nomes
	[/\bnode\s[^;&|]*?\b(exam|style-judge|failures)\.ts/, "roda a prova, o juiz de escrita ou o failures.ts, que gastam crédito da Ollama e cota do Langfuse"],
	[/\bCREDITO=["']?1\b/, "libera a prova paga no verify-feature e gasta crédito da Ollama"],
	// com a barra, em qualquer comando; não pega "storage/database.ts"
	[/(^|[\s'"=<>|;&(/])(\.env\b|(data|logs)\/)/, "usa o .env, data/ ou logs/, onde ficam as chaves e os bancos do bot em uso"],
	// sem a barra ("rm -rf data"), só como argumento de quem mexe em arquivo: "data" também é o dia da viagem, e grep e commit com a palavra passam
	[/(^|[;&|(])\s*(sudo\s+)?(rm|mv|cp|ls|cat|du|tar|zip|rsync|find|chmod|chown|ln|sqlite3|open|head|tail|less|more|truncate|tee)\b[^;&|]*\s(\.\/)?(data|logs)(?=$|[\s;&|)])/, "usa o .env, data/ ou logs/, onde ficam as chaves e os bancos do bot em uso"],
];

export function motivoParaPerguntar(comando: string) {
	return REGRAS.find(([padrao]) => padrao.test(comando))?.[1];
}

if (import.meta.main) {
	const comando = JSON.parse(readFileSync(0, "utf8")).tool_input?.command ?? "";
	const motivo = motivoParaPerguntar(comando);
	if (motivo) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `Este comando ${motivo} (regras do AGENTS.md). Só rode com o ok da pessoa.` } }));
}
