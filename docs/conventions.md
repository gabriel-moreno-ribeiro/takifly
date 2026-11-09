---
type: Reference
title: Regras do código do Takifly
description: As regras que valem ao mexer em brain/, sources/, rules/, storage/ ou quality/, as decisões de ferramental e as variáveis de ambiente.
tags: [código, arquitetura, convenções, env]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# O bot

- O modelo decide o que é difuso (entender o pedido, escrever a resposta). Conta, data, regra e filtro são código.
- Preço, horário, duração e link só chegam ao Slack depois do `brain/checker.ts`. Nunca troque uma conferência de código por um segundo modelo.
- Ferramenta nova entra no `REGISTRO` (`brain/tools.ts`) com `ligada: false` e só liga quando a família dela passa na prova.
- Passo novo do `docs/AGENCIA.md` ganha cenários novos em `quality/scenarios.ts`. Os `novo-*` já foram vistos pelos modelos.
- Mudou nó, aresta ou campo do estado em `brain/graph.ts` ou `brain/price-watch.ts`: atualize o cabeçalho do arquivo, que é a planta do grafo, e regenere o desenho (`MEMORIA=:memory: node brain/graph.ts` ou `node brain/price-watch.ts --desenho`).
- `Send` ou subgrafo só depois de trocar o reducer dos campos que dois nós escreveriam juntos (`campo()` sobrescreve) e de lembrar que as buscas no Google são uma por vez.

# Pastas

Uma pasta é um trabalho (tabela no `README.md`). `rules/`, `sources/` e `storage/` não importam de `brain/`; o bloco FRONTEIRAS do `quality/tests.ts` confere. O que dois lados usam mora fora de `brain/`, como `rules/dates.ts`.

# Ferramental

- Node 26 roda os `.ts` direto: sem `tsc`, build, `tsconfig`, lint ou bundler. Erro de tipo só aparece rodando.
- Testes com `node:assert`, sem framework. `.env` lido por `process.loadEnvFile`, sem `dotenv`. Banco pelo SQLite do próprio Node.
- Mudar qualquer uma dessas decisões é conversa com a pessoa antes.

# Travas do Claude Code

O `.claude/` faz das regras do `AGENTS.md` uma trava, e não só texto. O `settings.json` nega `Read` e `Edit` (o `Edit` vale também para `Write`) de `.env`, `data/` e `logs/`, e liga um hook `PreToolUse` no Bash: o `.claude/hooks/guarda.ts` pede o ok da pessoa antes de `node takifly.ts start|stop|restart` e de `launchctl` com os serviços `com.takifly.*`, da prova paga (`exam.ts`, `style-judge.ts`, `failures.ts`, de qualquer pasta), de `CREDITO=1` e de comando que use `.env`, `data/` ou `logs/`. Sem a barra, `data` e `logs` só contam como argumento de quem mexe em arquivo (`rm -rf data`, `ls logs`), porque "data" também é o dia da viagem: `grep data` e um commit com a palavra passam. Ler esses arquivos de código com `sed`, `grep`, `cat` ou `git diff` passa. O `.claude/agents/revisor.md` é o revisor independente, sem `Edit` nem `Write`. O bloco A GUARDA DO CLAUDE do `quality/tests.ts` confere os comandos.

Falta conferir numa sessão nova se o "ask" do hook aparece no modo bypass (as sessões daqui rodam nele). Se não aparecer, troque por "deny" com o motivo "peça à pessoa".

# Escrita

- Código, comentários, docs e mensagens em português do Brasil. Nomes de arquivo de harness em inglês; chaves de JSON em inglês, valores em português.
- Atalho com limite conhecido leva o comentário `shortcut: <o limite>, <quando melhorar>`.
- Mudou nome de arquivo, constante, intervalo ou comando citado num doc: corrija o doc no mesmo commit (`grep` antes).
- Erro que o modelo ou a pessoa lê diz o que está errado e o que fazer, como as mensagens do `brain/checker.ts`.
- Docs em `docs/` começam com o cabeçalho do Open Knowledge Format (`type`, `title`, `description`, `tags`); `npm test` confere.

# Variáveis de ambiente

Os valores ficam só no `.env`, que nunca vai para o git. Cite só os nomes.

| Nome | Quem lê | Obrigatória |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `bot.ts`, `watcher.ts` | sim |
| `OLLAMA_API_KEY` | `brain/graph.ts`, `quality/style-judge.ts` | sim |
| `PLANILHA_VIVA_URL` | `sources/spreadsheet.ts`, `brain/price-watch.ts` | para a planilha |
| `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL` | `brain/tracing.ts`, `quality/failures.ts` | não: sem elas nada é enviado |
| `EMAIL_CHAVE`, `EMAIL_DE`, `EMAIL_PARA` | `sources/email.ts` | não: sem elas o e-mail fica desligado |
| `MODELO`, `DADOS`, `MEMORIA` | grafo, banco e checkpoint | não: trocam modelo e bancos (`:memory:` nos testes e na prova) |
| `MODELO_FORTE`, `MODELO_ESPECIALISTA` | `brain/models.ts` (grafo, prova, juiz de escrita e painel leem dali) | não: sem elas, o forte é `glm-5.3` e o barato `glm-5.3-flash`, escolha da pessoa em 08/11. O forte é do orquestrador e do redator; o barato, dos especialistas e dos agentes de contexto e de memória. `MODELO` troca os dois |
| `PARTE`, `CENARIOS`, `AMOSTRA`, `RESULTADOS`, `REJULGAR`, `REFAZER`, `JUIZ` | `quality/exam.ts`, `quality/style-judge.ts` | não: os cabeçalhos desses arquivos explicam |
| `CREDITO` | `quality/verify-feature.ts` | não: `CREDITO=1` libera item com a prova na `verification`, só com o ok da pessoa |
