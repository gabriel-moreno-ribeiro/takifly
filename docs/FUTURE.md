---
type: Backlog
title: O que já combinamos fazer
description: Cada pendência do bot e do harness com o quê, por quê e onde mexe; o estado de cada uma fica no feature_list.json.
tags: [pendências, bot, harness]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# FUTURE.md — o que já combinamos fazer, mas ainda não fizemos

Cada item diz **o quê**, **por quê** e **onde mexe**. A ordem dentro de cada grupo é a ordem em que eu faria.
O que já foi feito está no `AGENCIA.md`. Quando um item daqui sair do papel, ele vai para lá.
O estado de cada item (por fazer, ativo, feito) mora no `feature_list.json`, ligado pelo número da seção. Aqui fica só o porquê.

---

## 1. O PDF de 10 a 15 páginas (o objetivo final)

**1.1 Um agente pequeno por seção do PDF (o "passo 46")**
- O quê: um arquivo `brain/sections.ts` com as ~12 seções do roteiro. Cada seção diz o título, quais fatos recebe e 5 linhas de instrução. Um modelo barato escreve uma seção por vez.
- Por quê: um modelo fraco escreve bem uma página com fatos na mão. Pedir 12 páginas de uma vez é pedir para ele se perder.
- Onde: `brain/sections.ts` (novo), `brain/document.ts` já imprime o PDF e conta as páginas. Quem decide o número de páginas é o código, não o modelo.

**1.2 Os capítulos do PDF**
- Voos, hotel e regras (visto, passaporte, vacina) já vêm das nossas ferramentas.
- Chegada (aeroporto → cidade), como se locomover, o que ver, o que fazer, onde comer e segurança vêm do guia de viagem (item 2).

**1.3 Execução durável para gerar o PDF**
- Por quê: são umas 12 chamadas de modelo. Se cair na 9ª, não pode refazer da 1ª à 8ª.
- Duas opções: o checkpointer do LangGraph (que já usamos e retoma do último nó) ou o Pi Durable (implementação de referência guardada em `../passagens/durable/`). Decidir quando o 1.1 existir.

---

## 2. Consultor de viagem: "como saio do aeroporto?", "o que fazer lá?"

Regra que não pode quebrar: **o modelo não responde isso de memória.** Número de ônibus, preço de metrô e nome de estação são exatamente o que um modelo fraco inventa. O fato vem de uma fonte, e o modelo só escreve.

**2.1 `sources/guide.ts`**
- Lê uma seção de uma cidade no Wikivoyage em inglês (API aberta, licença CC BY-SA) e limpa a marcação do wiki.
- Já testei com Lisboa: a seção "By plane" tem 5.800 caracteres sobre terminais, metrô e shuttle.
- Teste em cima de uma página gravada, igual o `flights.ts`.
- Risco: o Wikivoyage em português é raso, então usar o inglês e deixar o redator traduzir. Se a marcação do wiki mudar, quebra aqui, e só aqui.

**2.2 Uma ferramenta, não seis**
- `read_travel_guide(city, topic)`, com `topic` numa lista fechada: `airport_to_city`, `get_around`, `see`, `do`, `eat`, `safety`.
- Seis ferramentas que diferem por uma palavra é onde o modelo fraco mais troca uma pela outra.

**2.3 Agente novo: `guia`** — feito em 08/11 com internet e clima (F28, ver `docs/AGENCIA.md`). O 2.1 e o 2.2 continuam valendo: uma fonte fixa dá resposta mais estável que a busca.

---

## 3. Agentes e ferramentas

**3.1 Dividir os especialistas** (com o registro, agora cada um custa uma linha)
- `hospedagem` sai do `pesquisador`: voo e hotel são dois assuntos.
- `documentos` sai da `memoria`: passaporte e vacina não são a mesma coisa que "prefiro janela".
- `comparador` sai do `analista`: comparar (`comparar_trechos`, `somar_ida_e_volta`) separado de recortar e contar (`filtrar_voos`, `calcular`).
- Onde: `agente` no `REGISTRO`, a entrada em `AGENTES`, os exemplos do orquestrador e `quality/scenarios.ts`.

**3.2 Nomes de ferramentas e campos em inglês (só a camada que o modelo lê)**
- `search_flights(origin, destination, date)` em vez de `buscar_voos(origem, destino, data)`. O campo `data` em inglês quer dizer "dados", e isso confunde um modelo fraco.
- As descriptions e o código continuam em português: a description precisa casar com o que a pessoa escreve, e o código é para você ler.

**3.3 Apagar `dia_da_semana` e `listar_trechos`**
- São redundantes. Apagar quando a prova mostrar que o modelo não chama nenhuma das duas.

**3.4 Juntar `pesquisarVarios` e `maisBaratoDoTrecho`** (`brain/tools.ts`)
- São dois loops parecidos sobre origem × destino. Juntar custa um parâmetro a mais. Só vale a pena quando um dos dois precisar mudar.

**3.5 Terminar a auditoria das regras do redator** (`brain/agents.ts`)
- O quê: um comentário acima de `instrucoesDoRedator`, uma linha por regra, dizendo se ela é fato conferido por código, segurança, produto ou estilo. Regra que o código já garante só sai do prompt com a nota da prova antes e depois.
- Por quê: regra a cada erro incha o prompt. Em 08/11 o custo-benefício e o ano passaram para o verificador; a parte da classe ficou de fora, porque recusaria perguntas e avisos de falha que não citam a classe.
- Onde: `brain/agents.ts` e `brain/checker.ts`. Medir com a prova gasta crédito.

---

## 4. Recursos do LangGraph que ainda não usamos

| Recurso | Para que serviria aqui |
|---|---|
| `interrupt()` | Pausar e perguntar antes de agir: "achei dois aeroportos chamados San José, qual é?", ou confirmar antes de criar um monitoramento. |
| `Send` | Rodar especialistas independentes ao mesmo tempo (`memoria` e `pesquisador`). Cuidado: as buscas no Google têm que continuar uma por vez. |
| Subgrafos | Cada especialista vira um grafo próprio, com estado e desenho próprios. Ajuda quando forem 7 ou mais. |
| `Store` | Memória de longo prazo entre conversas (preferências, documentos), no lugar da nossa tabela no sqlite. |
| Cache de nó | Não repetir a mesma busca com os mesmos argumentos dentro de poucos minutos. |
| `getStateHistory` | Voltar no tempo para depurar: "por que ele respondeu isso?", vendo o estado depois de cada nó. |

---

## 5. Confiabilidade

**5.1 Desacoplar o vigia do `brain/tools.ts`**
- O vigia carrega o `brain/price-watch.ts`, que ainda importa `precoAtual`, `descreverMonitoramento` e `hojeEmSaoPaulo` de lá. Um bug escrito no `tools.ts` não derruba um vigia que já está rodando, mas impede que ele religue.
- Mexe no `servicos`, que é o jeito que a prova finge o Google, então precisa de cuidado.

**5.2 Testar o caminho do Slack recusando o aviso** (`watcher.ts`, `avisarNoSlack`)
- É uma linha (`if (!corpo.ok) throw`) que nunca foi exercitada. É ela que faz o vigia tentar de novo em vez de marcar "já avisei".

**5.3 O vigia avisar também por e-mail**
- `sources/email.ts` já existe, e o vigia já aceita uma lista de canais. Falta passar a função na lista do `watcher.ts`.

**5.4 Prazo e retentativas: nenhum pedido preso por minutos**
- O quê: `maxRetries: 2` no `criarModelo` (`brain/graph.ts`), `AbortSignal.timeout(180_000)` no `grafo.stream` do `rodar()` e `AbortSignal.timeout(30_000)` no fetch da planilha (`sources/spreadsheet.ts`), como o de `sources/flights.ts`.
- Por quê: hoje o LangChain repete até 6 vezes, com 120 s cada, e um pedido pode ficar minutos sem resposta. O passo 1, a retomada que quebra não prender o canal, foi feito em 08/11.
- Antes: medir no Langfuse a duração dos pedidos e das chamadas mais longas, para o prazo não cortar um pedido que hoje termina.

---

## 6. Segurança e dados (as outras ideias da Uber)

**6.1 Esconder dados pessoais no Langfuse**
- `guardar_documentos` guarda validade do passaporte e data de nascimento, e isso aparece nos traces. A Uber esconde esses dados no gateway, em toda resposta.

**6.2 Expor as ferramentas como servidor MCP**
- O Claude Desktop ou o Claude Code poderiam pesquisar voos usando o nosso código e as nossas travas. O `REGISTRO` já é a lista do que expor.
- Custa uma dependência nova. Vale a pena quando houver um motivo para usar o bot fora do Slack.

**6.3 O checker só pega "monitoramento criado" e "guardei" falsos em português** (`brain/checker.ts`)
- Uma resposta em inglês dizendo "I created your price tracker" sem ter criado passa sem ser pega.
- Cuidado ao somar negações de outras línguas: "no" em português é "em + o" ("no dia 12"), então não pode entrar na lista de negação.

---

## 7. Medir

**7.2 O que a prova de 96 achou na escrita e ainda não foi mexido** (`node quality/style-judge.ts`)
- O convite "me diga a validade do passaporte e a data de nascimento" já sai uma vez só por conversa (campo `convidou` em `brain/graph.ts`), mas ainda sem teste.
- O redator explica a conta do custo-benefício em toda resposta ("no cálculo que soma preço, tempo e escalas..."). O juiz marca como repetir o óbvio.
- As piadinhas do Taki ("o Taki farejou...") são marcadas como confusas ou com cara de robô quando aparecem no meio da informação. É uma escolha de produto (regra 14 do redator): decidir se fica, e onde.
- As famílias com escrita pior são as de várias cidades ou vários dias numa resposta só: `varios-destinos` (3,25), `limite`, `intervalo` e `hotel` (3,50). Resposta grande é onde o redator se perde.

**7.4 Decidir se o limite de 7 dias é do pedido ou da chamada**
- Para "qual o dia mais barato entre 8 e 22 de julho", o modelo divide em duas chamadas de 7 dias. Desde 08/11 não há limite de buscas por pedido (só 12 chamadas da ferramenta), então as duas saem, mais devagar. Se 7 dias é um limite de produto, ele precisa ser contado por pedido. Se não é, a description do `buscar_voos` pode dizer que dá para dividir.

**7.5 Ajustar os `maxPorPedido` do registro**
- Os números de hoje são escolha nossa. A prova mostra se algum aperta.

**7.6 Os tokens de cada pedido na prova**
- O quê: cada linha da prova grava os tokens de entrada e de saída de cada mensagem, somados por um `handleLLMEnd`.
- Por quê: a linha já diz de que commit veio e por onde passou, mas o custo de cada pedido só aparece no Langfuse, que gasta cota.
- Onde: só `quality/exam.ts`, porque o `brain/tracing.ts` roda no bot e no vigia. Antes, conferir se a Ollama Cloud devolve o `usage`.

---

## 8. Arrumação pendente

- **Renomear a pasta** `passagens.ts/` para `flight-bot/`, com as duas sessões e os dois processos fechados (eles seguram os `.sqlite`).
- **`docs/manual/`**: as notas e o `build.py` ainda usam os caminhos antigos (`harness/…`, `teste.ts`, `voos.ts`), e o `index.html` gerado ainda cita `buscar_varios_dias`.
- **Atalhos conhecidos**: `grep -rn 'shortcut:' --include='*.ts' .` lista todos, com o limite e quando melhorar. Os que viraram trabalho têm id no `feature_list.json`.

---

## 9. O harness do agente de código

**9.1 Um hook Stop que roda os testes** (`.claude/hooks/pronto.ts`)
- O quê: quando há `.ts` ou `.json` mudado, o hook roda `node quality/tests.ts` e não deixa o Claude parar sem `Tudo certo!`.
- Por quê: "nada está pronto sem `npm test`" ainda é regra escrita. Ficou para depois porque o `verify-feature.ts` já roda os testes antes de promover.
- Cuidados: timeout explícito, sair com 0 quando vier `stop_hook_active`, guardar o resultado pelo hash do `git diff`. Risco: outra sessão editando a pasta faz o hook bloquear por um erro que não é desta.

**9.2 Verificações que não provam o comportamento** (`feature_list.json`)
- O quê: as `verification` de H07, F25 e H14 passam com um `grep -q` só, a de F51 só conta cenários e a de F61 confere um `git status` vazio, que foi um fato de 05/11. H14 ganha um bloco no `quality/tests.ts` com `ModeloFalso` e `SEM_VERIFICADOR=1`; H07, F51 e F61 viram `manual:`; F25 ganha `node --check bot.ts` ou vira `manual:`. Um bloco VERIFICAÇÃO NÃO É SÓ GREP recusa item que não está passing com uma verificação que é só `grep -q`.
- Por quê: o `verify-feature.ts` promove o que a verificação disser, e um comentário com a palavra procurada já bastaria para o item virar passing. Até hoje nenhum item passou assim.
- Onde: `feature_list.json` e `quality/tests.ts`. Grátis.

---

## 10. Memória, planilha e mensagens seguidas (madrugada de 08→09/11)

**10.3 Várias mensagens seguidas: espera, juiz e cancelar** (F73)
- O quê: as mensagens de um canal esperam 5 s de silêncio e viram um pedido só. Mensagem que chega com um pedido rodando passa por um juiz (modelo barato): `refazer` cancela o pedido e começa de novo com tudo junto, `fila` espera o atual terminar, `ignorar_espera` não faz nada. Juiz que falha ou demora vale `fila`. O cancelamento é de verdade (`AbortSignal` até o `grafo.stream`): a resposta velha não sai, o aviso de progresso some e o pedido não é retomado.
- Por quê: quem manda "voos para Lisboa" e logo "dia 15" hoje ganha duas pesquisas, e a primeira com a data errada.
- Onde: `brain/channel.ts` (novo, sem `.env`, para o teste importar), `rodar()` e `responder()` em `brain/graph.ts`, `bot.ts`, `brain/tracing.ts` (a decisão vai como nota), o painel.
