# Takifly

O bot de passagens no Slack. São dois programas: o **bot**, que conversa, e o **vigia**, que confere sozinho cada preço que você pediu para acompanhar, de 2 em 2 horas.

## Ligar e desligar

```
node takifly.ts start      liga os dois e deixa ligados (religam sozinhos se caírem)
node takifly.ts restart    reinicia os dois com o código novo: use depois de mudar qualquer coisa
node takifly.ts status     mostra se estão rodando
node takifly.ts stop       desliga os dois de vez
```

Antes de reiniciar, `node quality/tests.ts` tem que dizer **Tudo certo!**.

## As pastas

Uma pasta é um trabalho. Para mudar como o bot pensa, abra `brain/`. Se uma busca quebrou porque um site mudou, abra `sources/`.

| Pasta | O que tem |
|---|---|
| `bot.ts`, `watcher.ts`, `takifly.ts` | Os três programas: o bot, o vigia e quem liga os dois como serviço do Mac. |
| `brain/` | O que decide: o grafo, os agentes, as ferramentas, o verificador, o grafo do vigia e o rastreio no Langfuse. |
| `sources/` | O que fala com o mundo de fora: Google Flights, Google Hotels, Google Sheets e e-mail. |
| `rules/` | O que o código sabe sozinho, sem IA: aeroportos do mundo, visto, vacina, passaporte. |
| `storage/` | O que precisa durar depois de reiniciar: monitoramentos, preferências e documentos. |
| `quality/` | O que testa e mede: os testes, a prova, os 10 mil cenários, o juiz de escrita e o painel. |
| `assets/` | O Taki: `taki-icone.png` (ícone do app no Slack, 1024 px) e `taki-emoji.png` (emoji `:taki:`, 128 px). |
| `docs/` | O que já foi feito (`AGENCIA.md`), o que vem depois (`FUTURE.md`), notas e o manual. |
| `data/` | Os dois bancos (`dados.sqlite`, `memoria.sqlite`) e a trava do vigia. **Não apague.** |
| `logs/`, `results/` | Gerados enquanto o bot e a prova rodam. Podem ser apagados. |
| `floorplan/` | Mapa interativo do código, feito por uma ferramenta que sempre grava aqui na raiz. |

As chaves (Slack, Ollama, Langfuse) ficam no `.env`, que nunca vai para o git.
