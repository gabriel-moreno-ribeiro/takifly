# Takifly

Bot de viagens no Slack (`bot.ts`) com um vigia de preços separado (`watcher.ts`), em TypeScript que o Node 26 roda direto, sem build. O cérebro é um grafo LangGraph em `brain/graph.ts`, com dois modelos da Ollama Cloud (`brain/models.ts`: glm-5.3 decide e escreve, glm-5.3-flash chama as ferramentas) e traces no Langfuse.

## Regras que valem sempre

- Não toque em `data/`, `logs/` nem no `.env` (cite só os nomes das chaves). Por quê: `data/` guarda os bancos do bot em uso.
- Não rode `node takifly.ts start`, `stop` ou `restart` sem a pessoa pedir; `status` pode. Por quê: bot e vigia estão rodando agora como serviços do Mac.
- Não rode `quality/exam.ts`, `quality/style-judge.ts` nem `quality/failures.ts` sem a pessoa pedir. Por quê: gastam crédito da Ollama e cota do Langfuse.
- Não commite sem a pessoa pedir, e rode `git status` antes de mexer. Por quê: outra sessão do Claude pode estar editando esta pasta.
- Nada está pronto sem `npm test` terminar em "Tudo certo!".

## Como ler os docs

Todo arquivo em `docs/` começa com um cabeçalho do Open Knowledge Format (`type`, `title`, `description`, `tags`). Para escolher o que abrir, leia só os cabeçalhos:

```
awk 'FNR==1{n=0; print "\n== " FILENAME} /^---$/{n++; next} n==1' docs/*.md
```

Abra o corpo só do doc que a tarefa pede. A tabela abaixo diz quando cada um importa.

## Mapa

| Arquivo | Leia quando |
|---|---|
| `docs/progress.md` | No começo de toda sessão: estado verificado, item ativo e próximo passo |
| `docs/session.md` | Ao começar e antes de parar uma sessão |
| `feature_list.json` | Para escolher ou fechar um item; leia só o item `active` |
| `docs/verification.md` | Antes de dizer que algo está pronto, de pedir para rodar a prova ou de reiniciar |
| `docs/conventions.md` | Antes de mexer em `brain/`, `sources/`, `rules/`, `storage/` ou `quality/`, ou numa variável de ambiente |
| `docs/FUTURE.md` | Para saber o porquê e onde mexe de um item (o número da seção está em `notes`) |
| `docs/AGENCIA.md` | Antes de criar um passo novo, mudar o grafo ou uma fonte de dados |
| `docs/lessons-harness.md` | Antes de acrescentar uma regra, um teste de harness ou uma peça nova ao processo |
| `docs/lessons-ibm.md` | Antes de mexer em contexto, ferramentas, injeção de prompt ou custo de modelo do bot |
| `README.md` | Para ver as pastas e os comandos de ligar e desligar |

O cabeçalho de cada `.ts` diz como rodar aquele arquivo sozinho, e o de `brain/graph.ts` é a planta do grafo. `docs/manual/` é gerado e está desatualizado: não use. O curso de harness está em `../learn-harness-engineering/`, só para consulta.
