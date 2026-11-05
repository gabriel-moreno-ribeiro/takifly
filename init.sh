#!/usr/bin/env bash
# init.sh - confere se o projeto está são antes de começar a trabalhar: Node, dependências, chaves, testes, git e serviços
#
# Como rodar (dentro da pasta passagens.ts/):   bash init.sh      (~80 s, quase tudo nos testes)
set -euo pipefail
cd "$(dirname "$0")"

PRECISA=$(cat .node-version)
TEM=$(node --version | sed 's/^v//; s/\..*//')
[ "$TEM" -ge "$PRECISA" ] || { echo "Precisa do Node $PRECISA ou mais novo; este é o $(node --version)."; exit 1; }
echo "==> Node $(node --version)"

npm install --no-fund --no-audit --loglevel=error

for CHAVE in SLACK_BOT_TOKEN SLACK_APP_TOKEN OLLAMA_API_KEY; do
	grep -q "^$CHAVE=" .env 2>/dev/null || { echo "Falta $CHAVE no .env (docs/conventions.md lista as chaves)."; exit 1; }
done
echo "==> .env com as chaves obrigatórias"

echo "==> npm test"
node quality/tests.ts

echo "==> Git: $(git status --short | wc -l | tr -d ' ') arquivo(s) sem commit"
git log --oneline -3
echo "==> Item ativo: $(node -e 'const l = JSON.parse(require("fs").readFileSync("feature_list.json", "utf8")); console.log(l.features.filter((f) => f.state === "active").map((f) => f.id + " " + f.behavior).join("; ") || "nenhum")')"
node takifly.ts status
