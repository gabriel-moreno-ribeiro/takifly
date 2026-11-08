---
type: Status
title: Onde paramos
description: Estado verificado agora, o item ativo, o próximo passo, o histórico da prova e o diário das sessões, do mais novo ao mais antigo.
tags: [estado, sessão, prova]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
stale_after: 2026-11-11T00:00:00Z
---

# Estado verificado

- Main em `51b6b8a`. O harness dos agentes de 08/11 está commitado na branch `gabriel-moreno-ribeiro/melhorar-harness-agentes-bot` (worktree `cuskeel`), ainda sem merge na main.
- `npm test`: Tudo certo! em 2026-11-08 na worktree, sem `.env` (agora ele é opcional para os testes), com o grafo inteiro rodando em modelos falsos.
- Serviços: `com.takifly.bot` e `com.takifly.watcher` rodando no launchd com o código da pasta principal; nada de 08/11 chegou neles.

# Item ativo

Nenhum. H15, F26, H16, H17 e H18 passaram pelo `verify-feature.ts` em 08/11 (camada 1, sem crédito).

A pessoa escolheu os modelos em 08/11: glm-5.3 no forte, glm-5.3-flash no barato (`brain/models.ts`). A prova ainda não mediu essa dupla.

Próximo passo, que é da pessoa porque gasta crédito: `node quality/exam.ts` (284 casos, ~40 s cada; grava em `results/glm-5.3+glm-5.3-flash.jsonl`) e comparar com `results/glm-5.3.jsonl`. Se a nota de Fatos cair, o flash volta a ser só uma opção.
- Antes de pôr no bot: commit, merge e `node takifly.ts restart`, quando a pessoa pedir.

Depois: `F13`, o bot só pesquisar com origem, destino e data de cada trecho (custa crédito: 7 cenários da prova).

# Histórico da prova

| Data | Commit | Modelo | Cenários | Fatos | Escrita | Piores famílias |
|---|---|---|---|---|---|---|
| 2026-11-03 | sem commit | glm-5.3 | 10 mil gerados | 9767/10000 | 4,26/5 | saudacao 203/250, hotel 390/450, classe 369/400 |
| 2026-10-30 | f52b5ee | glm-5.3, gemma4:31b, gpt-oss:20b, nemotron-3-nano:30b | 284 | ver `node quality/scoreboard.ts` (hoje quebra, item H09) | | |

# Sessões

## 2026-11-08

- Harness dos agentes, a pedido da pessoa: modelo forte e barato por papel (H15), "pronto" conferido por código (F26), especialistas voltando ao orquestrador (H16), agente de contexto (H17) e agente de memória (H18). Detalhes em `docs/AGENCIA.md`, seção "O harness dos agentes".
- `npm test` agora roda o grafo de ponta a ponta com `ModeloFalso`: dá para testar mudança no grafo sem crédito.
- O `.env` passou a ser opcional para os testes (`brain/graph.ts`, `brain/tracing.ts`, `sources/email.ts`); `bot.ts` e `watcher.ts` continuam exigindo.
- Uma revisão independente achou 10 problemas na primeira versão (o pior: preferência guardada soltava a trava da data). Todos consertados, cada um com teste.
- Não rodei a prova (gasta crédito). Commit na branch a pedido da pessoa; merge e restart, quando ela pedir.

## 2026-11-05

- Commit `2b05fcb` com tudo o que estava só no disco desde 02/11. F61 passou pelo `verify-feature.ts`.
- A regra "só pesquisar com o mínimo de informação" entrou no F13 e no passo 38 do `docs/AGENCIA.md`.

## 2026-11-04

- Aplicado o curso Learn Harness Engineering: `AGENTS.md` virou mapa dos docs, todo doc em `docs/` ganhou cabeçalho OKF, nasceram `docs/session.md`, `docs/verification.md`, `docs/conventions.md`, `docs/lessons-harness.md`, este arquivo, `feature_list.json`, `quality/verify-feature.ts`, `init.sh` e `.node-version`.
- `npm test` não abre mais o `data/memoria.sqlite` do bot; confere a lista e o mapa dos docs.
- A prova agora sai com código 1 quando algum cenário falha.
- Corrigidos nos docs: 6 h → 2 h no `lessons-ibm.md`, os 10 mil no `FUTURE.md`, "só voo" e o retryPolicy no `AGENCIA.md`.
- Os itens `passing` de antes de hoje foram registrados à mão na criação da lista, com a evidência que já existia. Daqui em diante, só o `verify-feature.ts` promove.
