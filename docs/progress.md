---
type: Status
title: Onde paramos
description: Estado verificado agora, o item ativo, o próximo passo, o histórico da prova e o diário das sessões, do mais novo ao mais antigo.
tags: [estado, sessão, prova]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
stale_after: 2026-11-11T00:00:00Z
---

# Madrugada 08→09/11

Trabalho sozinho, a pedido da pessoa, na branch `gabriel-moreno-ribeiro/madrugada-memoria-planilha` (worktree do Orca, sem `.env`). Três itens, nesta ordem: F71 (planilha por par de cidades), F72 (ver, compactar e excluir o contexto), F73 (várias mensagens seguidas). O porquê de cada um está no `docs/FUTURE.md`, seção 10.

## Próximo passo

F73 ativo. O prompt e o formato do juiz já estão em `brain/agents.ts` (`INSTRUCOES_DO_JUIZ`, `Decisao`). Falta: o debounce, o juiz e o cancelamento em `brain/channel.ts` (`criarCanais`, com um relógio que o teste troca), o `AbortSignal` em `rodar()` e `responder()` de `brain/graph.ts` (e desfazer o pedido cancelado no checkpointer), a faixa no desenho de `brain/live.html`, e o bloco "VÁRIAS MENSAGENS SEGUIDAS" em `quality/tests.ts` (há um rascunho do relógio falso em `/tmp/madrugada/testes_f73.ts.txt`, se ainda existir). O excluir com pedido rodando passa a cancelar o pedido, em vez de recusar.

## O que ficou pronto

- F71: a mesma viagem entre duas cidades fica numa planilha só por conversa (GRU→GIG e SDU→VCP são a mesma), reescrita a cada pesquisa e com no máximo 100 voos. Commit `7f83e0f`.
- F72: `contexto` no Slack e no painel mostra o que o bot lembra da conversa; `compactar contexto` e `excluir contexto` (e os botões) resumem ou apagam, guardando antes as preferências. Commit "Ver, compactar e excluir o contexto (F72)".

## O que travou

(nada até agora)

## Decisões que tomei

- F71, cidade do aeroporto: uso primeiro a tabela à mão `AJUSTES` de `rules/airports.ts` e só depois a cidade do OurAirports (`AEROPORTO`). Sem isso, VCP seria Campinas e não São Paulo, como o pedido exige. Não é tabela nova. Limite: fora da tabela à mão, aeroportos da mesma cidade podem cair em pares diferentes (Luton é "luton", não Londres) e os nomes saem sem acento ("Milao").
- F71, voos guardados: o banco guarda, junto do link, os voos que estão na planilha (no máximo 100). A pesquisa seguinte junta os novos com esses, troca os do trecho pesquisado de novo e tira os de dia que já passou. Cada voo guarda a hora em que foi checado, para a planilha não dizer que um preço antigo é de agora.
- F71, como dizer quantos ficaram de fora sem mudar o `.gs`: uma aba a mais, "Sobre esta planilha", com uma linha. Aba que ficaria vazia (por exemplo, nenhum voo caro) vai com a linha "nenhum voo aqui", porque o `.gs` pula aba vazia e a lista velha ficaria lá.
- F71, Google falhando com planilha guardada: tenta de novo uma vez; se falhar de novo, cria outra planilha e passa a usar ela (a guardada pode ter sido apagada do Drive).
- F71, o nome do par no Slack vai no sentido da pesquisa ("São Paulo–Recife"), e a planilha guarda o título da primeira pesquisa.
- F72, dossiê: compactar e excluir não pedem ao modelo para tirar documento da conversa. Documento continua entrando só pelo especialista memoria, quando a pessoa conta (a regra de sempre), então o dossiê fica como está.
- F72, preferências no compactar e no excluir: o modelo lê as mensagens juntas, mas cada fato só entra se passar na conferência do agente de memória contra uma mensagem sozinha, e o lote nunca troca uma preferência guardada (ele não sabe qual mensagem é a mais nova). Fato de um valor só ("mora em", "é de", "sai de") não entra se já há um guardado. E o que a pessoa pediu para esquecer não volta.
- F72, excluir com o modelo falhando: apaga mesmo assim (foi o que a pessoa pediu) e diz que não guardou preferências novas.
- F72, excluir apaga a conversa inteira do `memoria.sqlite`, com os checkpoints antigos (`deleteThread`). O compactar não apaga os checkpoints antigos: as mensagens saem da memória de agora, mas continuam no histórico do arquivo.
- F72, compactar com um pedido parado no meio (o bot caiu durante ele) é recusado: a próxima mensagem retoma o pedido, e depois dá para compactar.
- F72, compactar e excluir pelo painel não mandam mensagem no Slack; o aviso fica só na lista do painel.
- F72, ficam as últimas 10 mensagens depois de compactar (`MANTER_AO_COMPACTAR`), contadas como na janela: o corte começa numa mensagem da pessoa.

# Estado verificado

- Main em `6928ba1` (merge do PR #3, interface no Slack). A pasta principal está na main.
- A auditoria do harness de 08/11 está na branch `gabriel-moreno-ribeiro/harness-curso-v2` (worktree do Orca, criada da main `6928ba1`), toda sem commit: `git status --short` lista os arquivos.
- O WhatsApp sem commit da pasta principal foi guardado, sem mudanças, na branch local `whatsapp-em-andamento` (`2d38c63`). Para retomar: `git switch whatsapp-em-andamento` na pasta principal.
- `npm test`: Tudo certo! em 2026-11-08 na branch da auditoria, sem `.env`, com o grafo inteiro rodando em modelos falsos.
- Serviços: `node takifly.ts status` mostra `bot.ts` e `watcher.ts` rodando, ligados em 08/11 às 16h26 da pasta principal, logo depois do merge `6928ba1`. A branch da auditoria não está no ar. Falta uma mensagem real no Slack.

# Item ativo

Nenhum. A auditoria do harness de 08/11 promoveu pelo `verify-feature.ts` (camada 1, sem crédito) H03, H09, H19 a H27 e F64 a F69. Ficaram `not_started`: H12 (o CI só vale depois de rodar verde no GitHub), H28, H29, H30 e F70.

A pessoa escolheu os modelos em 08/11: glm-5.3 no forte, glm-5.3-flash no barato (`brain/models.ts`). A prova mediu essa dupla em 08/11: 278/284.

As 2 falhas que sobraram da prova de 08/11, com a causa achada na auditoria:
- `lugar-sao-jose`: defeito do código, não do modelo. A tabela do mundo levava "sao jose" direto para SJC (San Jose, nos EUA), sem perguntar; a busca foi GRU→SJC e a trava avisou do visto americano (`results/glm-5.3+glm-5.3-flash.jsonl`). Conserto: F68.
- `seguimento-mais-rapido`: a resposta deixou confuso de qual companhia era cada preço, e o juiz leu um preço como da Azul. O verificador conferia cada valor sozinho, e não o par companhia e preço, então deixou passar; o mesmo erro reprovou o `fala-enrolada` na primeira rodada ("Air Europa por R$ 3250", que é preço da Azul). Conserto: F64. A frase exata não ficou em `results/`: a rodada repetida está no scratchpad de outra sessão.

Próximo passo, da pessoa (gasta crédito da Ollama e cota do Langfuse): rodar a prova só dos 7 cenários que as mudanças do bot tocam, para medir o efeito antes do commit. São `fala-enrolada` e `seguimento-mais-rapido` (F64), `conta-hora-por-reais` (F65), `rota-ida-e-volta-executiva` e `conta-quatro-pessoas` (F66), `rota-flexivel-acima-do-limite` (F67) e `lugar-sao-jose` (F68). A worktree não tem `.env`, então o comando lê o da pasta principal sem copiá-lo, e grava numa pasta nova de `results/` para não pular os casos que já rodaram. No terminal, dentro de `/Users/ithaca3_/orca/workspaces/passagens.ts/cuskeel`:

```
for c in fala-enrolada seguimento-mais-rapido rota-ida-e-volta-executiva conta-quatro-pessoas conta-hora-por-reais rota-flexivel-acima-do-limite lugar-sao-jose; do RESULTADOS=results/auditoria-08-11 node --env-file="/Users/ithaca3_/VS Code/Gabriel <> Ithaca W1/passagens.ts/.env" quality/exam.ts "$c"; done
```

Cada cenário mostra PASSOU ou FALHOU e "Nota de glm-5.3+glm-5.3-flash: 1 de 1" (uns 30 s cada). A guarda do Claude pede o ok antes, porque o comando roda a prova e usa o `.env`.

Depois, quando a pessoa pedir: commit na branch, PR, merge na main, `git pull` na pasta principal e `node takifly.ts restart` (as mudanças do bot só valem no Slack depois disso). O push roda o CI pela primeira vez: verde no GitHub, `node quality/verify-feature.ts H12`.

Depois: `F13`, o bot só pesquisar com origem, destino e data de cada trecho (custa crédito: 7 cenários da prova).

# Histórico da prova

| Data | Commit | Modelo | Cenários | Fatos | Escrita | Piores famílias |
|---|---|---|---|---|---|---|
| 2026-11-08 | guia, antes do merge | glm-5.3 + glm-5.3-flash | 14 `guia-` + 40 sorteados | 14/14 e 39/40 | | o único que falhou, `sem-data`, pediu o que faltava com "me diz:" sem "?", e o juiz não reconhece; já falhava em 30/10. Juiz a rever com a pessoa |
| 2026-11-08 | 63a4965 | glm-5.3 + glm-5.3-flash | 284 | 278/284; com o conserto 6048585 os 6 que falharam rodaram de novo e 4 passaram (~280/284) | | seguimento-mais-rapido (preço atribuído à Azul), lugar-sao-jose (não perguntou qual São José). Antes 282/284 com o grafo antigo. 26 s por caso, contra 37 s |
| 2026-11-03 | sem commit | glm-5.3 | 10 mil gerados | 9767/10000 | 4,26/5 | saudacao 203/250, hotel 390/450, classe 369/400 |
| 2026-10-30 | f52b5ee | glm-5.3, gemma4:31b, gpt-oss:20b, nemotron-3-nano:30b | 284 | ver `node quality/scoreboard.ts` (na pasta principal, que tem os resultados) | | |

# Sessões

## 2026-11-08

- Conferência final, depois dos agentes: a trava do `calcular` (F66) recusava qualquer preço × 2 a 9 e quebraria o `conta-quatro-pessoas` (busca de 1 adulto, pergunta para 4); agora recusa só o número de passageiros da própria busca. A guarda pedia o ok para `grep data` e commit com a palavra "data" (o dia da viagem); agora `data` e `logs` sem barra só contam em `rm`, `cp`, `ls`, `cat` e parecidos. Com o verificador final, as respostas aprovadas guardadas da prova (278 + 282) não têm nenhuma recusa nova, e os 10 mil têm 1 em 9767.
- Auditoria do harness, a pedido da pessoa (branch `gabriel-moreno-ribeiro/harness-curso-v2`, sem commit): guarda do Claude (H19), trava de crédito e evidência melhor no `verify-feature.ts` (H20), `init.sh` em worktree sem `.env` (H21), revisor como subagente (H22), CI escrito (H12, falta rodar), laço do verificador testado de graça (H23), datas da prova andando com hoje (H24), juízes testáveis (H25), commit e caminho em cada linha da prova (H26), `REFAZER=falhas` (H27), placar (H09) e id citado nas notes conferido (H03); no bot, F64 a F69. Tudo com teste e sem crédito. Uma revisão independente achou 14 problemas: 11 consertados com teste; ficaram 3 de gravidade baixa (a guarda pergunta à toa em algumas leituras e o comentário dela ainda diz que `bash -c` passa; a regra do F64 recusaria uma comparação como "o mais barato é R$ 2850, se não fizer questão da TAP"; o commit gravado pela prova sai `-sujo` na pasta principal por causa de um PDF solto). Para depois: F70, H13, H28, H29 e H30 (`docs/FUTURE.md`).
- Agente guia com internet e clima (F28), a pedido da pessoa: `ver_clima` (Open-Meteo) e `buscar_na_web` (busca da Ollama, mesma chave). Testes sem crédito passam; uma revisão independente reprovou a primeira versão (página com "R$ 89" e link de golpe passavam no verificador) e os 10 problemas foram consertados com teste. Prova autorizada pela pessoa: 14/14 nos `guia-` (duas vezes, a segunda pelo `verify-feature.ts`) e 39/40 em 40 antigos sorteados.
- Painel ao vivo (H31), a pedido da pessoa: http://localhost:4500 com o bot ligado. Callback do LangChain em `rodar()` + SSE, sem dependência nova (os prontos do GitHub são de Python). Revisão independente achou 10 problemas (o pior: DNS rebinding lia as mensagens), todos consertados com teste. Entra no ar com merge e restart.
- Painel mais vivo, a pedido da pessoa: só as setas do caminho percorrido acendem, a seta do passo de agora corre em laranja com uma bolinha, e o aviso novo pisca na lista. `npm test` confere que cada seta liga nós que existem.
- Interface no Slack, a pedido da pessoa (commit `b4ba9b3`, na main pelo PR #3, `6928ba1`): progresso passo a passo (F21 passou), links com nome e sem prévia, milhar com ponto, "Peguei" na fila, resposta para foto e áudio, erro sem jargão, emergência e aviso de preço para gente. Só código, sem prompt: não gasta crédito. Detalhes em `docs/AGENCIA.md`, "A interface no Slack". Mascote: `assets/taki-icone.png` e `assets/taki-emoji.png` gerados da foto da pessoa; o código usa `:taki:`. Antes do restart, a pessoa precisa subir o emoji no Slack. Quando a branch `whatsapp-em-andamento` voltar, o mapa `EMOJIS` de `sources/whatsapp.ts` precisa de `taki: "🐶"`. Falta: botões e boas-vindas (precisam de config no Slack).
- Prova da dupla glm-5.3 + glm-5.3-flash: 278/284. Achou um defeito do grafo novo (replano sem plano derrubava o pedido), consertado em `6048585` com teste. Sobraram 2 falhas, que a auditoria do mesmo dia pôs no código (`lugar-sao-jose`) e numa folga do verificador (`seguimento-mais-rapido`); causas em "Item ativo". A pessoa escolheu pôr no ar mesmo com Fatos ~2 abaixo; PR #2 com merge.
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
