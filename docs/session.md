---
type: Playbook
title: Como abrir, conduzir e fechar uma sessão de trabalho
description: A ordem do começo de sessão, a regra de um item ativo por vez e o que precisa estar feito antes de parar.
tags: [sessão, rotina, feature_list, commit]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# Começo

1. `bash init.sh`. Se parar em algum passo, o conserto é o trabalho da sessão.
2. Ler `docs/progress.md`: estado verificado, item ativo e próximo passo.
3. Abrir em `feature_list.json` só o item `active`. Sem item ativo, ativar o primeiro `not_started` cuja dependência (campo `notes`) já é `passing`.
4. `git status --short`. Arquivo mudado que não é seu pode ser de outra sessão do Claude: não apague, não commite, pergunte.

# Durante

- Um item `active` por vez. Termine ou marque `blocked` com o motivo em `notes` antes de ativar outro.
- Mexa só no que o item pede. Achou outra coisa para arrumar: vira item novo no `feature_list.json` (e o porquê no `docs/FUTURE.md`). Exceção: o conserto pequeno sem o qual o item ativo não anda.
- Nada de renomear ou refatorar com mudança ainda não verificada no disco.
- Item grande demais para uma sessão vira dois.

# Fim

1. Verificação do item, do jeito de `docs/verification.md`. Passou: `node quality/verify-feature.ts <id>`.
2. `docs/progress.md` atualizado: estado verificado, item ativo, próximo passo, uma linha no topo de Sessões.
3. Item feito sai do `docs/FUTURE.md` e entra no `docs/AGENCIA.md`, no mesmo commit.
4. Commit quando a pessoa pedir, um por assunto, com o porquê no corpo. `git status --short` vazio, ou o que sobrou explicado em `docs/progress.md`.
5. Bot e vigia como estavam: `node takifly.ts status` com os dois rodando.

# Contexto acabando

Não apresse nem pule a verificação. Pare num ponto limpo, atualize `docs/progress.md` e sugira conversa nova.
