---
type: Playbook
title: Como verificar uma mudança e quando ela está pronta
description: As três camadas de verificação em ordem, o custo de cada comando e a regra de que só o script promove um item a passing.
tags: [verificação, testes, prova, definição de pronto]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# Camadas

Rodam nesta ordem. Uma camada falhando para tudo: não se passa para a próxima.

| Camada | Comando | Custo | Quando |
|---|---|---|---|
| 1. Testes | `npm test` (= `node quality/tests.ts`), termina em `Tudo certo!` | grátis, ~70 s, sem rede nem modelo | sempre |
| 1. Sintaxe | `for f in bot.ts watcher.ts takifly.ts; do node --check "$f" \|\| exit 1; done` | grátis | mudou um desses três (nenhum teste os importa) |
| 2. Prova | `node quality/exam.ts <família ou cenário>` | crédito da Ollama, ~40 s por cenário | mudou prompt, ferramenta, agente ou grafo (`brain/`, `quality/scenarios.ts`) |
| 3. Produção | `node takifly.ts restart`, depois `node takifly.ts status` e `tail -n 5 logs/bot.log` com "Takifly ligado no Slack", e uma mensagem real no Slack | mexe nos serviços em uso | só quando a pessoa pedir |

A prova pula o que já está em `results/<modelo>.jsonl`. Para rodar de novo num código novo, use uma pasta vazia: `RESULTADOS=results/<nome-novo> node quality/exam.ts <família>`. O `verify-feature.ts` já faz isso sozinho.

# Pronto

- Pronto é a verificação do item rodando agora e passando, não o código escrito.
- Só `node quality/verify-feature.ts <id>` muda um item para `passing`: ele roda a `verification`, e só com saída 0 grava a evidência (data, commit, última linha da saída). Nunca escreva `passing` à mão.
- Verificação nova só vale depois de você vê-la falhar uma vez, com o item ainda por fazer.
- Item com `verification` começando por `manual:` é conferido pela pessoa, que registra a evidência.

# Juízes

`quality/tests.ts`, `quality/scenarios.ts`, `quality/scenarios-10k.ts`, `brain/checker.ts` e as `REGRAS` de `quality/style-judge.ts` medem o bot. Não afrouxe nenhum deles para algo passar. Se um juiz estiver errado, prove com um caso novo em `quality/tests.ts` ou com `REJULGAR=1 node quality/exam.ts` (rejulga as respostas guardadas sem gastar crédito) e mostre à pessoa antes de mudar.

# Métricas

- Fatos (a nota da prova) é a métrica congelada: não pode cair.
- Escrita (`quality/style-judge.ts`) pode subir ou descer, mas nunca à custa de um fato.
- Toda falha nova vista na prova, no Langfuse (`node quality/failures.ts`) ou no Slack vira primeiro um assert em `quality/tests.ts` ou um cenário em `quality/scenarios.ts`, com a data, e só depois o conserto.
