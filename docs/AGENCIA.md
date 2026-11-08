---
type: Product Vision
title: Takifly, a agência de viagens que conversa
description: O que o bot faz e não faz, o grafo alvo, a ordem dos passos (o que já foi feito) e de onde vem cada dado real.
tags: [produto, grafo, passos, fontes]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# Takifly: uma agência de viagens que conversa

O nome vem do Taki, o cachorro da Taqtile. Ele fareja passagem barata e late no Slack quando acha.

## O que a gente está construindo

Um bot que conversa no Slack e funciona como um agente de viagens. A pessoa diz para onde quer ir,
o bot pesquisa tudo (voo, hotel, carro, seguro, passeios), confere as regras da viagem, monta duas ou
três opções e manda os links. A compra quem faz é a pessoa.

É o mesmo projeto de sempre. O `passagens.ts` é o `passagens` reescrito em TypeScript, para poder usar
LangGraph e Pi Durable. Não são dois produtos.

## O que ele NÃO faz: reservar

O bot não reserva, não emite bilhete e não cobra nada. Ele pesquisa, explica e manda o link.

Isso parece uma limitação e é na verdade a melhor notícia do projeto, por três motivos:

1. Some a parte mais perigosa. Uma ação irreversível (emitir bilhete) obriga a resolver idempotência,
   estorno, dupla cobrança e dado de cartão. Nada disso vai existir aqui.
2. Some a parte impossível. Não existe API pública para emitir passagem: precisa de consolidadora,
   Amadeus ou Sabre, e contrato. A gente não ia conseguir mesmo.
3. Sobra o que importa. O valor de um agente de viagens não está em clicar em "comprar". Está em saber
   que você precisa de visto americano só para fazer conexão em Miami, e que a sua conexão de 50 minutos
   em Guarulhos não dá tempo. É isso que a gente vai construir.

## As sete coisas que o bot faz

| # | O que faz | Existe hoje? | Precisa de IA? |
|---|---|---|---|
| 1 | Conversar até entender a viagem: quem vai, quando, de onde, orçamento, estilo | em parte | sim |
| 2 | Lembrar quem é a pessoa: passaporte, idade, fidelidade, preferências | em parte | não |
| 3 | Pesquisar: voo, hotel, carro, seguro, passeios | voo e hotel | não |
| 4 | Conferir as regras: visto, passaporte, vacina, conexão, bagagem | tudo menos conexão e bagagem | não |
| 5 | Montar opções: dois ou três roteiros completos, com o total | não | não |
| 6 | Explicar e comparar, e mandar os links | sim, para voo | sim |
| 7 | Continuar acompanhando: preço caiu, check-in abriu, passaporte vencendo | só preço | não |

De sete, duas precisam de modelo de linguagem: entender o pedido (1) e escrever a resposta (6).
As outras cinco são conta, regra, tabela e pesquisa. Isso é a sua ideia de harness aplicada ao produto:
o modelo decide o que é difuso, o código faz o que é exato.

## O item 4 é o produto

Um bot que só pesquisa voo é um buscador. O que transforma ele em agente de viagens é conferir as regras.
São sete regras, e nenhuma precisa de IA:

| Regra | O que confere | Como |
|---|---|---|
| Passaporte | Quase toda fronteira exige validade de 6 meses depois da volta | subtração de datas |
| Visto | Depende de nacionalidade, destino, motivo e tempo de permanência. Conexão também conta | tabela |
| Vacina | Febre amarela precisa de 10 dias de antecedência em alguns destinos | tabela |
| Menor de idade | Autorização quando viaja sozinho ou com um dos pais | data de nascimento |
| Conexão | Tempo mínimo de conexão. Bilhete separado é risco da pessoa, não da companhia | subtração de horários |
| Bagagem | Quanto cada trecho permite. Trecho de outra companhia pode zerar a franquia | o que a busca trouxer |
| Câmbio | IOF, parcelamento, taxa de conversão do cartão | conta |

No grafo isso vira um nó só, de código, que roda depois de pesquisar e antes de responder. Ele não fala
com a pessoa: ele devolve a lista do que está errado, e o redator explica.

É também o nó que protege a pessoa de um erro do modelo. Hoje o verificador garante que nenhum preço
inventado chega ao Slack. Esse nó garante que nenhuma viagem impossível chega ao Slack.

## O que uma agência faz e a gente não vai fazer

Pesquisei o escopo inteiro de uma agência de viagens. Fora do nosso caminho ficam:

| Escopo | Por que fica fora |
|---|---|
| Reservar e emitir | Não tem API pública, e exige contrato com consolidadora |
| Cobrar, parcelar, estornar | Dinheiro de verdade, e o bot não vende |
| Remarcar e cancelar | Só dá para remarcar o que você mesmo emitiu |
| Reembolso | Mesmo motivo |
| Direitos em voo cancelado | Vale a pena só como informação, depois que o resto estiver pronto |
| Corporativo: política e aprovação | A aprovação do gestor existe para liberar uma compra. Sem compra, não tem o que aprovar |
| Faturamento e relatórios | É cadastro, e não ensina nada de LangGraph |

## O que ainda falta aprender de LangGraph

Você já usa `StateGraph`, `Annotation`, arestas condicionais, checkpointer em arquivo e nós de código
no meio dos nós de modelo. Falta isto, e cada item resolve um problema concreto da lista das sete coisas:

| Recurso | Para que serve aqui |
|---|---|
| `interrupt()` | O grafo para e pergunta. "Faltou a data, qual é?" e "quer que eu detalhe qual das três?". Hoje, quando falta um dado, a conversa volta ao começo em vez de continuar de onde parou |
| subgrafo | Um grafo por tipo de pesquisa. O grafo de hoje tem 11 nós; com hotel, carro, seguro e passeios viriam uns 50 no mesmo desenho |
| `Send` | Pesquisar voo, hotel e carro ao mesmo tempo. Hoje vai um de cada vez |
| nó `defer` | Montar as opções só depois que todas as pesquisas voltarem |
| `Store` | O passaporte da pessoa valer em qualquer conversa, não só num canal do Slack |
| `Command` | Um nó que muda o estado e já diz para onde ir. Com 10 tipos de pesquisa, a corrente de `addConditionalEdges` de hoje fica ilegível |
| ~~`retryPolicy`~~ | Feito nos passos 35 e 36. A busca do vigia e o orquestrador (resposta fora do formato) tentam de novo; os nós de modelo não, porque o `ChatOpenAI` já tenta 6 vezes |
| cache de nó | Não refazer uma pesquisa que acabou de ser feita |
| ~~grafo no relógio~~ | Feito no passo 35. O monitor é um grafo; o `setInterval` continua, porque o LangGraph não tem relógio próprio |
| `getStateHistory` | Voltar o grafo a um ponto anterior. Serve para a pessoa ("e com o outro hotel?") e para você depurar |

## O caminho que um pedido vai percorrer

Hoje o orquestrador é o centro: preparar, lembrar e contexto arrumam a memória, o orquestrador monta o plano,
cada especialista trabalha e volta para ele, e com o plano acabado vêm conferir, redator e verificar (a planta
completa está no cabeçalho de `brain/graph.ts`). O alvo é parecido, com duas diferenças que faltam: as pesquisas
vão em paralelo, e o grafo pode parar para perguntar.

```
  Slack
    │
    ▼
  recepcao ──► dossie ──► supervisor ──┬──► voo       ┐
  (código)    (código)   (modelo)      ├──► hotel     │ em paralelo (Send),
                                       ├──► carro     │ cada um um subgrafo
                                       ├──► seguro    │
                                       └──► passeios  ┘
                                              │
                                              ▼
                                        montar opcoes      espera todas (defer)
                                              │
                                              ▼
                                         conferir          visto, passaporte, vacina,
                                          (código)         conexão, bagagem
                                              │
                                              ▼
                                          redator  ◄── pode parar e perguntar (interrupt)
                                              │
                                              ▼
                                         verificar         nenhum preço inventado
                                              │
                                              ▼
                                         planilha ──► Slack
```

## A ordem

Um conceito novo por passo. Os três primeiros só arrumam o que já existe, e não dependem de
nenhuma pesquisa nova.

| Passo | O que faz | Conceito novo |
|---|---|---|
| ~~35~~ | **feito.** O monitor de preço virou um grafo: 5 nós, com `retryPolicy` na busca e trace no Langfuse | grafo invocado de fora, `retryPolicy`, `errorHandler` |
| ~~36~~ | **não precisa.** O `ChatOpenAI` já tenta de novo sozinho até 6 vezes. `retryPolicy` em cima disso daria 18 chamadas | — |
| 37 | A planilha e a coleta de voos viram nós, com cache | cache de nó |
| 38 | O grafo para e pergunta a data que faltou. Só pesquisa quando cada trecho tem origem, destino e data | `interrupt()` |
| 39 | Os quatro especialistas de hoje viram subgrafos | subgrafo, `Command` |
| ~~40~~ | **feito, e com dado real.** `sources/hotels.ts` lê hotel de verdade do Google Hotels (nome, nota, avaliações, comodidades). O que ele NÃO consegue é o preço das datas pedidas | serve de molde |
| 41 | Voo e hotel ao mesmo tempo, e as opções esperando os dois | `Send`, `defer` |
| ~~42~~ | **meio feito.** O dossiê existe (tabela `dossie` no dados.sqlite, ferramenta `guardar_documentos`), mas por conversa, não por pessoa. O `Store` continua faltando | `Store` |
| ~~43~~ | **feito.** O nó `conferir` roda entre os especialistas e o redator: `rules/rules.ts` confere visto, passaporte, vacina e menor de idade, por tabela e subtração de data | nenhum, é código |
| 44+ | Carro, seguro, passeios, roteiro: cada um copia o molde do 40 | nenhum |

### O harness dos agentes (feito em 08/11)

Pedido da pessoa: o orquestrador organiza tudo, os especialistas podem ser modelos mais fracos desde que o
código em volta segure, e dois agentes novos cuidam da memória e do contexto. Tudo provado com `npm test`,
que agora roda o grafo inteiro com modelos falsos (`ModeloFalso` em `quality/tests.ts`), sem crédito.

| Item | O que mudou | Onde |
|---|---|---|
| H15 | Dois papéis de modelo: o forte (orquestrador e redator) é o glm-5.3 e o barato (especialistas, lembrar, contexto) é o glm-5.3-flash, escolha da pessoa em 08/11. `MODELO_FORTE` e `MODELO_ESPECIALISTA` trocam um só; `MODELO` troca os dois | `brain/models.ts`, `modelos` em `brain/graph.ts` |
| F26 | "pronto" só vale se `terminou()` confirmar que uma ferramenta da tarefa respondeu sem erro neste pedido. Se nem tentou, volta com um bilhete; se tentou e a ferramenta recusou ("só até 9 pessoas: pergunte"), ninguém insiste | `terminou`, `comoVoltou` em `brain/graph.ts` |
| H16 | Todo especialista volta ao orquestrador. Quem terminou (ou teve a ferramenta recusando) só libera o próximo, sem chamada de modelo; quem voltou dizendo que faltou algo faz o orquestrador refazer o plano, até 2 vezes por pedido. Ninguém trabalha uma terceira vez, e quem já resolveu não é chamado de novo | `noOrquestrador`, campos `feitos` e `replanos` |
| H17 | Agente de contexto: assim que uma mensagem sai da janela de 40 sem estar no resumo, o modelo barato resume as que saíram e as 20 seguintes (nada fica no buraco), e o código tira do resumo valor, horário, duração, link e documento | `noContexto`, `resumoLimpo` |
| H18 | Agente de memória, no fim do pedido: com pista em primeira pessoa ("moro", "prefiro", "sempre viajo") e sem o especialista `memoria` no pedido (senão ficariam duas cópias), o modelo barato propõe fatos. O código só guarda o que começa com a forma da pista ("mora" só com "moro"), usa só palavras da pessoa, não tem número, valor nem assunto sensível, e não repete. Documento continua só com o especialista `memoria` | `noLembrar`, `fatosParaGuardar` |
| H19 | Painel ao vivo: com o bot ligado, http://localhost:4500 acende cada nó do grafo na hora em que roda, com o que decidiu, quanto levou e quantas chamadas de cada modelo o pedido fez. Só escuta no próprio Mac, recusa outro `Host` (DNS rebinding) e nunca derruba o bot | `brain/live.ts`, `brain/live.html` |

Revisão independente em 08/11 (um agente que não sabia das minhas conclusões) achou 10 problemas nesta primeira
versão; os 10 foram consertados, cada um com o seu teste. O mais grave: as preferências entravam na mesma lista
que a trava da data inventada lê, e "mora em Natal" soltava qualquer data. Agora elas valem só para o lugar.

O que ainda não foi medido: a prova (`quality/exam.ts`) com um modelo barato de verdade nos especialistas.
Gasta crédito, então é a pessoa que decide quando rodar.

### Workflow ou agente: o que é o quê neste bot (decidido em 08/11)

**Workflow + IA**: o código decide o caminho, e o modelo entra em pontos fixos para fazer uma coisa só
(classificar, extrair campos, escrever um texto). O número de chamadas é conhecido antes de rodar.
**Agente**: o modelo decide o próximo passo olhando o resultado do anterior, num laço com ferramentas.
Precisa de limites, condição de parada e conferência em volta, porque ninguém sabe quantas vezes ele vai rodar.

Um modelo fraco erra menos preenchendo um formulário do que planejando. Então a regra é: **workflow por padrão;
agente só onde o próximo passo depende de verdade do resultado anterior.**

| Peça | Hoje | Pode ser | Por quê |
|---|---|---|---|
| preparar, conferir, situacao, verificar, emergencia, planilha | código | código | nenhuma decisão difusa |
| vigia de preços (`brain/price-watch.ts`) | workflow sem IA | igual | checar, comparar, avisar: tudo é regra |
| orquestrador | workflow + IA (roteador, refaz o plano até 2 vezes) | igual | classifica o pedido; o laço é curto e o código o segura |
| redator → verificar → redator | workflow + IA (escreve, o código avalia, reescreve até 2 vezes) | igual | o avaliador é código, nunca um segundo modelo |
| contexto, lembrar | workflow + IA | igual | uma chamada em ponto fixo, código filtra a saída |
| documento em PDF (`brain/document.ts`, F06) | workflow + IA | igual | uma seção por vez, a partir de um roteiro fixo |
| especialista memoria | agente (até 6 passos) | **workflow**: o modelo extrai `{guardar, apagar, documentos}` e o código grava | a tarefa é um formulário; "esquece onde moro" o código resolve casando o texto |
| especialista monitor | agente | **workflow**: extrair rota, datas e preço-alvo; o código cria, lista ou cancela | idem |
| especialista pesquisador, pedido fechado ("GRU→LIS 12/12, volta 20/12") | agente | **workflow**: extrair os trechos, o código confere se cada um está completo (F13), pergunta o que falta (`interrupt`) e busca em paralelo (`Send`, F15) | o modelo não precisa decidir nada depois de extrair; e é onde o bot gasta mais chamadas hoje |
| especialista pesquisador, pedido aberto ("algo barato para a Europa em dezembro") | agente | **agente** | a próxima busca depende do que a anterior trouxe |
| especialista analista, pergunta simples ("o mais rápido?", "quanto dá ida e volta?") | agente | workflow: roteador escolhe uma ferramenta | uma chamada de ferramenta resolve |
| especialista analista, pergunta encadeada ("dos diretos, qual compensa mais somando ida e volta?") | agente | **agente** | precisa filtrar, olhar, e só então somar |
| guia de viagem (F08, "como saio do aeroporto?") | não existe | workflow + IA | buscar a seção do guia e escrever: dois passos fixos |

O que fica agente de verdade: a pesquisa exploratória e a análise encadeada. Todo o resto cabe num workflow,
e cada especialista que virar workflow deixa de precisar de `terminou()`, bilhete de "pronto sem fazer" e
replano: o modelo nunca decide se age, só preenche. O harness de 08/11 continua valendo para os dois agentes.

Limite da Ollama Cloud que pesa aqui: ela não aplica JSON schema e ignora `tool_choice`, então "preencher o
formulário" é oferecer uma ferramenta só e pedir que o modelo a chame (`method: "functionCalling"`, com
`retryPolicy`). Com o glm-5.3 isso acertou 4 de 4 em 03/11; com o glm-5.3-flash a prova ainda vai dizer.

## A interface no Slack

O que a pessoa vê e não passa pelo modelo é código, e por isso muda de graça (só `npm test`):

- **Progresso passo a passo** (F21): `descreverPasso` e `descreverChamada` (`brain/graph.ts`) editam o aviso "O Taki está farejando..." a cada nó e a cada ferramenta: "Procurando voos de GRU para LIS em 12/12...", "Escrevendo a resposta...", "Conferindo cada preço e horário...", "Um número não bateu com a pesquisa. Reescrevendo...".
- **Links com nome e sem cartão de prévia**: `arrumarParaSlack` (`brain/checker.ts`) troca o link cru por `<url|ver no Google Voos>` e põe ponto no milhar (R$ 55.520) antes do verificador, que continua conferindo a URL e o valor. `bot.ts` e `watcher.ts` mandam com `unfurl_links: false`.
- **Fila e arquivos** (`bot.ts`): mensagem que chega com o bot ocupado ganha "Peguei. Termino o pedido anterior e já vejo esse."; foto, áudio ou arquivo sem texto ganham uma resposta, em vez de silêncio.
- **Erro em palavras de gente**: `explicarErro` (`brain/checker.ts`) diz o que aconteceu e o que fazer; o erro técnico fica no `logs/bot.log`. A planilha que falha diz que tenta de novo na próxima mensagem.
- **Emergência**: `listarVoosParaPessoa` (`brain/graph.ts`) manda até 5 voos por trecho, com dd/mm e sem o número do custo-benefício.
- **Aviso de preço** (`brain/price-watch.ts`, `paraGente`): data dd/mm, links "Comprar a ida" e "Comprar a volta", quanto estava quando a pessoa pediu e como parar ("cancela o monitoramento 3"). A falha não mostra mais o erro técnico.

- **O mascote**: `assets/taki-icone.png` é o ícone do app (api.slack.com → Basic Information → Display Information) e `assets/taki-emoji.png` é o emoji `:taki:` do workspace, usado no aviso de progresso, no "Peguei" e no aviso de preço. Sem o emoji enviado ao Slack, aparece o texto `:taki:` cru.

Precisam de configuração em api.slack.com e ainda não foram feitos: botões de próximo passo (Interactivity) e boas-vindas no primeiro contato (eventos `app_home_opened` e `member_joined_channel`).

## De onde vem cada dado real

Nada aqui é inventado. Cada fonte tem um jeito de quebrar, e é isso que esta tabela serve para lembrar:

| Dado | Fonte | Como atualizar | Como quebra |
|---|---|---|---|
| Voo, preço, horário | Google Flights, lido do `<script class="ds:1">` (`flights.ts`) | é ao vivo | o Google muda o formato da página e a busca lança erro |
| Hotel, nota, avaliações | Google Hotels, lido do HTML renderizado (`sources/hotels.ts`) | é ao vivo | nome de classe embaralhado muda; o código lança erro em vez de dizer "não achei hotel" |
| Visto para brasileiro, 238 países | Wikipedia EN, *Visa requirements for Brazilian citizens*, revisão citada no arquivo gerado | `node rules/update-rules-data.ts` | a extração se recusa a gravar com menos de 150 países |
| Febre amarela, 122 países | anexo da OMS de **janeiro de 2023**, pela Wikipedia | o mesmo comando | idem, com piso de 80 países |
| País de cada aeroporto, 4133 | OurAirports (domínio público) | `node rules/update-airports-data.ts` | coluna renomeada faz o gerador lançar erro |

Duas coisas que seguem **escritas à mão**, e são o que ainda pode dizer "pode viajar" errado:

1. a lista de países que exigem visto de **trânsito** (8 códigos no `rules.ts`): não existe fonte estruturada disso;
2. o preço do hotel é de **uma noite nas datas que o Google escolhe**, nunca das datas pedidas — as datas entram por JavaScript. Preço real das datas certas só com API paga. O texto da ferramenta avisa isso junto do número, e o redator é obrigado a repetir.

### O que o passo 43 ainda NÃO confere

O `rules.ts` sabe conferir conexão e bagagem, mas o nó não tem com o que alimentá-las: um `Voo` nosso é
um trecho inteiro, com as escalas somadas dentro, e o `estado.voos` guarda todas as opções pesquisadas,
não a viagem escolhida. Então hoje o nó monta a viagem mais simples que dá para afirmar (a ida mais
barata do primeiro dia e a volta mais barata do último) e confere só o que depende de destino e data.
Quando a busca trouxer perna por perna, é só preencher mais trechos no `viagemDosVoos`.

As tabelas de visto, vacina e país de aeroporto são geradas das fontes da tabela acima. Só a lista de
visto de trânsito segue escrita à mão, marcada com `shortcut:` no `rules.ts`. O que não está na tabela nunca é chutado —
vira "confirme no consulado". Aeroporto desconhecido faz o nó dizer que NÃO conferiu, em vez de calar.

Duas observações sobre o passo 40 e os seguintes:

Comece com dados de mentira, como a prova já faz com voo. Site de hotel bloqueia mais que o Google
Flights. O grafo não muda quando a ferramenta virar real, e é por isso que ferramenta e nó ficam separados.

Todo passo novo precisa de cenários novos na prova. Os cenários `novo-*` de hoje já foram vistos pelos
modelos, então a nota deles não quer mais dizer nada.
