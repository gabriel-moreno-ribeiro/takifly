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

- Último commit: `ecda5f3` (02/11). Há mudanças sem commit desde então: a reorganização em pastas e o harness de 04/11.
- `npm test`: Tudo certo! em 2026-11-04 (65 s, sem rede, sem modelo e sem abrir `data/`).
- Serviços: `com.takifly.bot` e `com.takifly.watcher` rodando no launchd com o código de 04/11 15:49.

# Item ativo

`F61`: commitar a reorganização em pastas.

- Por que agora: nada depois de `ecda5f3` está no git, nem o vigia (`watcher.ts`, `takifly.ts`). Um `git checkout` errado apaga tudo.
- Pronto quando: `git status --short` vazio e `npm test` em "Tudo certo!".
- Não mudar neste passo: código do bot. É só commit, quando a pessoa pedir.

# Histórico da prova

| Data | Commit | Modelo | Cenários | Fatos | Escrita | Piores famílias |
|---|---|---|---|---|---|---|
| 2026-11-03 | sem commit | glm-5.3 | 10 mil gerados | 9767/10000 | 4,26/5 | saudacao 203/250, hotel 390/450, classe 369/400 |
| 2026-10-30 | f52b5ee | glm-5.3, gemma4:31b, gpt-oss:20b, nemotron-3-nano:30b | 284 | ver `node quality/scoreboard.ts` (hoje quebra, item H09) | | |

# Sessões

## 2026-11-04

- Aplicado o curso Learn Harness Engineering: `AGENTS.md` virou mapa dos docs, todo doc em `docs/` ganhou cabeçalho OKF, nasceram `docs/session.md`, `docs/verification.md`, `docs/conventions.md`, `docs/lessons-harness.md`, este arquivo, `feature_list.json`, `quality/verify-feature.ts`, `init.sh` e `.node-version`.
- `npm test` não abre mais o `data/memoria.sqlite` do bot; confere a lista e o mapa dos docs.
- A prova agora sai com código 1 quando algum cenário falha.
- Corrigidos nos docs: 6 h → 2 h no `lessons-ibm.md`, os 10 mil no `FUTURE.md`, "só voo" e o retryPolicy no `AGENCIA.md`.
- Os itens `passing` de antes de hoje foram registrados à mão na criação da lista, com a evidência que já existia. Daqui em diante, só o `verify-feature.ts` promove.
