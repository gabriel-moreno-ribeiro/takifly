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

- Main em `2175ee2` (merge do PR #2, harness dos agentes). A pasta principal está na main.
- O WhatsApp sem commit da pasta principal foi guardado, sem mudanças, na branch local `whatsapp-em-andamento` (`2d38c63`). Para retomar: `git switch whatsapp-em-andamento` na pasta principal.
- `npm test`: Tudo certo! em 2026-11-08 na worktree, sem `.env` (agora ele é opcional para os testes), com o grafo inteiro rodando em modelos falsos.
- Serviços: `com.takifly.bot` e `com.takifly.watcher` reiniciados em 08/11 às 15h com a main `2175ee2` (glm-5.3 + glm-5.3-flash); log com "Takifly ligado no Slack". Falta uma mensagem real no Slack.

# Item ativo

Nenhum. H15, F26, H16, H17, H18 e H08 passaram pelo `verify-feature.ts` em 08/11 (camada 1, sem crédito). H08 está só no disco, sem commit.

A pessoa escolheu os modelos em 08/11: glm-5.3 no forte, glm-5.3-flash no barato (`brain/models.ts`). A prova ainda não mediu essa dupla.

Próximo passo: investigar as 2 falhas da prova de 08/11 (`seguimento-mais-rapido`, `lugar-sao-jose`), ambas do modelo forte.

Depois: `F13`, o bot só pesquisar com origem, destino e data de cada trecho (custa crédito: 7 cenários da prova).

# Histórico da prova

| Data | Commit | Modelo | Cenários | Fatos | Escrita | Piores famílias |
|---|---|---|---|---|---|---|
| 2026-11-08 | 63a4965 | glm-5.3 + glm-5.3-flash | 284 | 278/284; com o conserto 6048585 os 6 que falharam rodaram de novo e 4 passaram (~280/284) | | seguimento-mais-rapido (preço atribuído à Azul), lugar-sao-jose (não perguntou qual São José). Antes 282/284 com o grafo antigo. 26 s por caso, contra 37 s |
| 2026-11-03 | sem commit | glm-5.3 | 10 mil gerados | 9767/10000 | 4,26/5 | saudacao 203/250, hotel 390/450, classe 369/400 |
| 2026-10-30 | f52b5ee | glm-5.3, gemma4:31b, gpt-oss:20b, nemotron-3-nano:30b | 284 | ver `node quality/scoreboard.ts` (hoje quebra, item H09) | | |

# Sessões

## 2026-11-08

- Painel ao vivo (H19), a pedido da pessoa: http://localhost:4500 com o bot ligado. Callback do LangChain em `rodar()` + SSE, sem dependência nova (os prontos do GitHub são de Python). Revisão independente achou 10 problemas (o pior: DNS rebinding lia as mensagens), todos consertados com teste. Entra no ar com merge e restart.
- Painel mais vivo, a pedido da pessoa: só as setas do caminho percorrido acendem, a seta do passo de agora corre em laranja com uma bolinha, e o aviso novo pisca na lista. `npm test` confere que cada seta liga nós que existem.
- Interface no Slack, a pedido da pessoa (branch `gabriel-moreno-ribeiro/interface-slack`, sem commit): progresso passo a passo (F21 passou), links com nome e sem prévia, milhar com ponto, "Peguei" na fila, resposta para foto e áudio, erro sem jargão, emergência e aviso de preço para gente. Só código, sem prompt: não gasta crédito. Detalhes em `docs/AGENCIA.md`, "A interface no Slack". Mascote: `assets/taki-icone.png` e `assets/taki-emoji.png` gerados da foto da pessoa; o código usa `:taki:`. Antes do restart, a pessoa precisa subir o emoji no Slack. Quando a branch `whatsapp-em-andamento` voltar, o mapa `EMOJIS` de `sources/whatsapp.ts` precisa de `taki: "🐶"`. Falta: botões e boas-vindas (precisam de config no Slack).
- Prova da dupla glm-5.3 + glm-5.3-flash: 278/284. Achou um defeito do grafo novo (replano sem plano derrubava o pedido), consertado em `6048585` com teste. Sobraram 2 falhas do modelo forte, a investigar. A pessoa escolheu pôr no ar mesmo com Fatos ~2 abaixo; PR #2 com merge.
- A pedido da pessoa: WhatsApp guardado na branch `whatsapp-em-andamento`, main nova na pasta principal, `npm test` Tudo certo! lá e restart.
- H08: `hojeEmSaoPaulo` e `somarDias` foram para `rules/dates.ts`; `rules/` e `sources/` não importam mais `brain/`, e o bloco FRONTEIRAS do `quality/tests.ts` confere. `brain/tools.ts` reexporta as duas, então nenhum outro arquivo mudou.
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
