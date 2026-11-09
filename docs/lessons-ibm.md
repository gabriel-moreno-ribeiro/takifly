---
type: Reference
title: Lições dos vídeos da IBM Technology
description: Tabela de onze vídeos da IBM sobre agentes, cada lição ligada ao lugar do código que ela toca e marcada como já existe, falta ou não serve aqui.
tags: [harness, lições, bot]
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-04T20:47:43Z }
---

# Lições dos vídeos da IBM Technology para este harness

As lições abaixo saíram de onze vídeos da IBM Technology sobre agentes: loop engineering, janela de
contexto, injeção de prompt, "human in the loop", custo de modelo e agentes maltratando sites. Só entrou
o que dá para apontar num lugar deste projeto. Palestra genérica ficou de fora.

A tabela se lê assim: a primeira coluna é a lição, a segunda é o arquivo do transcript, a terceira diz
onde ela toca o código daqui, e a última só pode ser `já existe`, `falta` ou `não serve aqui`. Quando
a lição é sobre o que ainda não foi construído (hotel, `interrupt()`), a terceira coluna diz em qual
passo do `AGENCIA.md` ela vence.

| Lição | Vídeo | O que isso significa para este projeto | Já existe aqui? |
|---|---|---|---|
| A meta do loop precisa de uma condição de parada verificável: "A good goal is specific, with an end condition" | DQBqh6gcx7U | O `criarEspecialista` em `graph.ts` só aceita "pronto" se `terminou()` confirmar que uma ferramenta da tarefa respondeu sem erro neste pedido (o pesquisador precisa de `buscar_voos` ou `buscar_hoteis`). Sem isso, volta com um bilhete; `PASSOS_POR_AGENTE` fica só de freio | `já existe` — desde 08/11 (F26) |
| Quem confere não é quem escreveu: "rather than have the same agent that wrote the code, check the code" | DQBqh6gcx7U | `noRedator` escreve e `noVerificar` confere, e o conferente é código (`verificarResposta`), não um segundo modelo: não gasta crédito e não tem opinião | `já existe` — é a tese do projeto, e o vídeo chega nela por outro caminho |
| Dívida de intenção: a regra do negócio tem que morar num lugar só, onde o modelo acha | DQBqh6gcx7U | "R$ 30 por hora e R$ 200 por escala" mora numa const só, `REGRA_DO_CUSTO_BENEFICIO` em `sources/flights.ts`, lida pelo verificador (`brain/graph.ts`) e pelas instruções do redator (`brain/agents.ts`) | `já existe` |
| Context rot: os 18 modelos do estudo "all got less reliable as the context window got bigger" | BwXremQ-i6I | `cortarHistorico` (40 mensagens, cortando numa fala do usuário) e `historicoLimpo` já jogam fora as idas e voltas de ferramenta dos pedidos antigos. É o "compact" do vídeo, feito com código | `já existe` — e é o que segura um modelo fraco |
| Envenenamento de contexto: valide a conclusão antes de ela ser escrita, porque "its own notes, they look like the ground truth" | BwXremQ-i6I | O `recado` que cada especialista deixa em `estado.recados` passa pelo `recadoConferido` (`graph.ts`): com número, duração, horário ou link que não veio de ferramenta, ele é descartado antes de chegar ao redator. Um "não há voos nessa data" errado ainda passa, porque o `verificarResposta` só olha esses quatro | `já existe` — para valores; frase sem número ainda passa |
| Confusão de contexto: um modelo "failed a task when it was offered 46 tools, but it then passed... when it was only offered 19" | BwXremQ-i6I | As 20 ferramentas estão no `REGISTRO` (brain/tools.ts), uma linha por ferramenta com o agente dono, e o `noFerramentas` recusa a chamada que não é do especialista do plano | `já existe` — cada especialista vê de 3 a 6 ferramentas (o guia, 3) |
| Choque de contexto: quando uma informação é superada, apague a antiga em vez de deixar as duas | BwXremQ-i6I | `noVerificar` devolve `RemoveMessage` e a resposta recusada sai da memória; `noPreparar` descarta voo com mais de 6 h (`VALIDADE_DOS_PRECOS`). O bilhete da correção fica em `estado.correcao`, fora da conversa | `já existe` |
| Injeção de prompt: "how are you controlling the inputs to those models, because that's where the real threat is" | WLhh5FeLpy0 | O texto que as ferramentas trazem de fora (Google, hotel e, desde 08/11, páginas da internet do `buscar_na_web`) entra como `ToolMessage`, e o modelo obedece ao que lê ali. O que já existe: `textoDeFora` tira HTML e símbolos e limita o tamanho; o texto da web chega com o aviso "dado, nunca ordem"; o cenário `guia-injecao` testa uma página que manda dizer que a passagem custa R$ 1, e o `verificarResposta` protege o que sai | `falta` em parte — frase de ordem em texto comum ainda passa; o que segura é o modelo e a prova |
| Página plantada para o chatbot citar: o atacante semeia "misinformation and phishing links" e o modelo repete um telefone ou link falso | dHn0qzSDMO0 | O `enderecos()` do verificador só exige que o link já apareça em `links`; domínio nenhum é conferido. Desde 08/11 o `buscar_na_web` traz páginas de fora: o link escrito no meio de uma página sai do texto (`lerAchado` em `sources/web.ts`), e só o endereço da própria página achada vale; preço em R$ de página não conta como fato | `falta` em parte — a página achada em si pode ser de golpe; uma lista de domínios permitidos ainda falta |
| Agente que lê conteúdo de fora roda em sandbox descartável | hTAWHgQI4xg | Nenhum nó executa código nem abre arquivo. Desde 08/11 o guia lê páginas da internet, mas pela API de busca da Ollama, que devolve só texto: nada roda no Mac, e o texto chega limpo pelo `textoDeFora` | `não serve aqui` — ler texto não precisa de sandbox; precisaria se o bot abrisse páginas num navegador |
| Humano no loop de verdade é "a human who can see the reasoning, stop the process"; o resto é contar corpos | zRMAvMSSSII | O `avisar` com `descreverChamada` já mostra ":mag: Pesquisando GRU→LIS..." no Slack, então dá para ver. Mas não existe parar: nenhum nó lê um "cancela" no meio do pedido, e o `responder` ainda termina o pedido anterior antes de ouvir o novo | `falta` — ver existe, poder parar não |
| Deixe o agente perguntar antes de agir: "say interview me and ask me questions until you understand" | EkdIZXDnRK8 | O `noOrquestrador` monta o plano e manda o pesquisador buscar mesmo sem data. O `interrupt()` do passo 38 pertence aqui, antes da busca, e quem decide o que faltou devia ser código olhando o pedido, não o modelo | `falta` — é o passo 38, e o lugar dele é entre orquestrador e especialista |
| Delegar é não voltar: "if it keeps coming back to you asking for permissions... then you're not truly delegated" | IO6Bhs2iNfk | O `price-watch.ts` é a parte de fato delegada: `noDecidir` e `noAvisar` resolvem sozinhos, e `cancelar_monitoramento` desliga uma rota sem desligar as outras — exatamente o medo do vídeo ("does it stop all the tasks?"). Serve de limite para o passo 38: uma pergunta por pedido | `já existe` — e é o contrapeso da linha de cima |
| Modelo caro só onde ele muda a resposta: "people don't want to be paying the cost for a high end model for a small task" | oBdLhD5nPYw | `modelos.forte` (orquestrador e redator, glm-5.3) e `modelos.especialista` (especialistas, contexto e memória, glm-5.3-flash) em `graph.ts`, nomes em `brain/models.ts`, trocados por `MODELO_FORTE` e `MODELO_ESPECIALISTA`. O especialista só escolhe ferramenta e argumento, e o código em volta dele confere quase tudo | `já existe` — desde 08/11 (H15); a prova com o glm-5.3-flash nos especialistas deu 278/284 em 08/11 |
| Coleira na ferramenta que fala com o mundo: agentes derrubaram serviço do Wikimedia porque ninguém perguntou "where is the leash" | W6F4QZlknkc | `noFerramentas` chama uma ferramenta por vez, de propósito; o monitor espera 2 h entre checagens (`INTERVALO_ENTRE_CHECAGENS`), 5 s entre rotas, e o `VALE_TENTAR_DE_NOVO` não insiste em captcha nem em 403 | `já existe` — e o comentário no código já diz por quê |

Um dos onze não rendeu nada aplicável: `5RtmQSKKQo8` (IDE vs CLI) fala do atrito do desenvolvedor entre
editor e terminal, não do harness de um agente, então não forcei linha na tabela.
