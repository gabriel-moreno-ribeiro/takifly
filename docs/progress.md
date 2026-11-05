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

- Último commit: `2b05fcb` (05/11), com a reorganização em pastas e o harness.
- `npm test`: Tudo certo! em 2026-11-05 (65 s, sem rede, sem modelo e sem abrir `data/`).
- Serviços: `com.takifly.bot` e `com.takifly.watcher` rodando no launchd com o código de 04/11 15:49.

# Item ativo

Nenhum. Próximo sugerido: `F13`, o bot só pesquisar com origem, destino e data de cada trecho, e perguntar o que faltar.

- Por que agora: é a regra que a pessoa pediu em 05/11, e é o que trava pedidos como a viagem de 4 trechos.
- Pronto quando: a `verification` do F13 passa (custa crédito: 7 cenários da prova).
- Não mudar neste passo: os juízes da prova e o verificador.

# Histórico da prova

| Data | Commit | Modelo | Cenários | Fatos | Escrita | Piores famílias |
|---|---|---|---|---|---|---|
| 2026-11-03 | sem commit | glm-5.3 | 10 mil gerados | 9767/10000 | 4,26/5 | saudacao 203/250, hotel 390/450, classe 369/400 |
| 2026-10-30 | f52b5ee | glm-5.3, gemma4:31b, gpt-oss:20b, nemotron-3-nano:30b | 284 | ver `node quality/scoreboard.ts` (hoje quebra, item H09) | | |

# Sessões

## 2026-11-05

- Commit `2b05fcb` com tudo o que estava só no disco desde 02/11. F61 passou pelo `verify-feature.ts`.
- A regra "só pesquisar com o mínimo de informação" entrou no F13 e no passo 38 do `docs/AGENCIA.md`.

## 2026-11-04

- Aplicado o curso Learn Harness Engineering: `AGENTS.md` virou mapa dos docs, todo doc em `docs/` ganhou cabeçalho OKF, nasceram `docs/session.md`, `docs/verification.md`, `docs/conventions.md`, `docs/lessons-harness.md`, este arquivo, `feature_list.json`, `quality/verify-feature.ts`, `init.sh` e `.node-version`.
- `npm test` não abre mais o `data/memoria.sqlite` do bot; confere a lista e o mapa dos docs.
- A prova agora sai com código 1 quando algum cenário falha.
- Corrigidos nos docs: 6 h → 2 h no `lessons-ibm.md`, os 10 mil no `FUTURE.md`, "só voo" e o retryPolicy no `AGENCIA.md`.
- Os itens `passing` de antes de hoje foram registrados à mão na criação da lista, com a evidência que já existia. Daqui em diante, só o `verify-feature.ts` promove.
