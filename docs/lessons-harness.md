---
type: Reference
title: Lições do curso Learn Harness Engineering
description: As 14 aulas do curso da WalkingLabs, cada lição ligada ao lugar deste projeto que ela toca e marcada como já existe, falta ou não serve aqui.
tags: [harness, lições, agente de código, bot]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
sources:
  - id: curso
    resource: https://github.com/walkinglabs/learn-harness-engineering
    title: Learn Harness Engineering (aulas em docs/pt-BR/lectures/)
---

O curso está copiado em `../learn-harness-engineering/`. Este projeto tem dois harnesses: o **do bot** (grafo, verificador, prova, Langfuse) e o **do agente de código** que mexe no repositório (`AGENTS.md`, `docs/`, `feature_list.json`, `init.sh`). A coluna "Para" diz qual.

Os itens marcados `falta` têm id no `feature_list.json`.[^curso]

| Aula | Lição | Para | O que significa aqui | Já existe aqui? |
|---|---|---|---|---|
| 01 | Quando falha, conserte o harness antes de trocar de modelo | bot | O modelo decide o difuso e o código faz o exato; `MODELO=` serve para comparar modelos na mesma prova, não para fugir de um defeito | `já existe` |
| 01 | Sem definição de pronto verificável, o agente declara pronto quando acha | agente | `docs/verification.md` e o campo `verification` de cada item | `já existe` |
| 02 | Harness = instruções + ferramentas + ambiente + estado + feedback | agente | `AGENTS.md` (instruções), `docs/conventions.md` (ferramentas e limites), `init.sh` e `.node-version` (ambiente), `docs/progress.md` e `feature_list.json` (estado), `npm test` (feedback) | `já existe` |
| 02 | Meça cada peça tirando uma de cada vez, com o modelo fixo | bot | `ligada: false` numa linha do `REGISTRO` + `RESULTADOS=results/sem-<peça> node quality/exam.ts`; o verificador ainda não tem interruptor | `falta` |
| 03 | O que não está no repositório não existe para o agente | agente | Nomes das chaves, versão do Node e decisões de ferramental agora estão em `docs/conventions.md` | `já existe` |
| 03 | Doc desatualizado é pior que doc nenhum | agente | Corrigidos hoje: 6 h → 2 h no `lessons-ibm.md`, os 10 mil no `FUTURE.md`, "só voo" no `AGENCIA.md`. O `docs/manual/` continua com caminhos velhos | `falta` |
| 04 | O arquivo de entrada é um roteador, não uma enciclopédia | agente | `AGENTS.md` é um mapa: diz qual doc ler em qual situação, e cada doc começa com o cabeçalho OKF para ser escolhido sem abrir | `já existe` |
| 04 | Regra a cada erro incha o prompt; antes, veja se o código já garante | bot | As 14 regras do redator (`brain/agents.ts`) nunca foram auditadas uma a uma contra o que o `checker.ts` já confere | `falta` |
| 05 | Estado entre sessões mora em arquivo, não na conversa | agente | `docs/progress.md` com estado verificado, item ativo e próximo passo | `já existe` |
| 05 | O agente apressa o fim quando o contexto acaba | agente | `docs/session.md`, seção "Contexto acabando" | `já existe` |
| 06 | Inicializar é uma fase própria, antes de qualquer trabalho | agente | `bash init.sh`: Node, dependências, chaves, testes, git e serviços | `já existe` |
| 06 | Pré-requisito faltando tem que avisar ao ligar, não no meio | bot | `bot.ts` e `watcher.ts` sem `.env` morrem com stack trace, e o launchd religa a cada 10 s | `falta` |
| 07 | Um item ativo por vez (WIP=1) | os dois | No bot, o plano é uma fila e cada canal tem a sua. No repositório, no máximo um `active` no `feature_list.json`, conferido por `npm test` | `já existe` |
| 07 | O especialista sai por conclusão, não por cansaço | bot | `terminou()` em `graph.ts` confere se uma ferramenta da tarefa respondeu sem erro neste pedido; "pronto" sem isso volta com bilhete, e a contagem (`PASSOS_POR_AGENTE`) fica só de freio | `já existe` — desde 08/11 (F26) |
| 08 | Lista de funcionalidades é primitiva: comportamento + verificação + estado | agente | `feature_list.json`, validado por `npm test` | `já existe` |
| 08 | Quem muda para passing é o harness, depois de rodar a verificação | agente | `node quality/verify-feature.ts <id>` | `já existe` |
| 08 | Documento pode ser ignorado, primitiva não | agente | "Antes de reiniciar, Tudo certo!" ainda é só texto: `node takifly.ts restart` não roda os testes | `falta` |
| 09 | Quem avalia não é quem escreveu | bot | `noRedator` escreve, `noVerificar` confere com código; a prova julga sem usar nada do bot | `já existe` |
| 09 | Teste verde não é tarefa pronta; o teste tem que estar isolado do ambiente real | agente | Os testes abriam o `data/memoria.sqlite` do bot em serviço; agora definem `MEMORIA=:memory:` antes de carregar o grafo | `já existe` |
| 10 | Só o pipeline inteiro prova o sistema | bot | A prova roda o grafo inteiro com Google e planilha de mentira; Slack, launchd e checkpoint antigo só a camada 3 vê | `já existe` |
| 10 | Regra de arquitetura só vale se for executável | agente | "Uma pasta é um trabalho" não tem teste, e `rules/rules.ts` e `sources/hotels.ts` já importam `brain/` | `falta` |
| 11 | Observabilidade é do harness, não do agente | bot | Langfuse com um trace por pedido e scores (`verificador_recusou`, `passou`); `quality/failures.ts` junta as falhas | `já existe` |
| 11 | Processo vivo não é processo pronto | bot | `node takifly.ts status` diz "rodando" mesmo com o bot sem conexão com o Slack; os logs saem sem hora nem id da conversa | `falta` |
| 12 | Sessão só termina com estado limpo | agente | `docs/session.md`, seção "Fim" | `já existe` |
| 12 | O harness também envelhece: simplifique de tempos em tempos | os dois | `dia_da_semana` e `listar_trechos` (FUTURE 3.3) esperam esse teste | `falta` |
| 13 | Um loop é objetivo + verificação + parada, com memória no disco | os dois | O vigia é o loop do bot (`ligarMonitor`, estado no sqlite); o agente de código usa `feature_list.json` + `docs/progress.md` | `já existe` |
| 13 | O agente não edita quem o avalia | agente | `docs/verification.md`, seção "Juízes" | `já existe` |
| 14 | O grafo põe o problema no papel e tem que bater com o código | bot | O cabeçalho de `brain/graph.ts` é a planta, mas `brain/graph.html` não tem o nó `situacao` e o laço do especialista não está no cabeçalho | `falta` |
| 14 | Antes de desenhar: quem veta e qual métrica fica congelada | bot | Fatos é a congelada, escrita pode mover (`docs/verification.md`); quem veta é o verificador e o `REGISTRO` | `já existe` |
| 14 | Âncoras prendem o loop à realidade | bot | Fatos têm âncora (o catálogo falso da prova); a reação da pessoa no Slack não vira nota | `falta` |

[^curso]: Learn Harness Engineering (aulas em docs/pt-BR/lectures/)
