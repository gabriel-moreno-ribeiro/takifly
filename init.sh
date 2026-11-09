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

FALTA=""
for CHAVE in SLACK_BOT_TOKEN SLACK_APP_TOKEN OLLAMA_API_KEY; do
	grep -q "^$CHAVE=" .env 2>/dev/null && continue
	# worktree do Orca não tem .env: os testes rodam sem ele, e bot e vigia só ligam da pasta principal
	[ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] || { echo "Falta $CHAVE no .env (docs/conventions.md lista as chaves)."; exit 1; }
	FALTA="$FALTA $CHAVE"
done
if [ -n "$FALTA" ]; then
	echo "==> Worktree sem$FALTA no .env: os testes rodam, mas bot e vigia não ligam desta pasta (ligue da pasta principal)"
else
	echo "==> .env com as chaves obrigatórias"
fi

echo "==> npm test"
node quality/tests.ts

echo "==> Git: $(git status --short | wc -l | tr -d ' ') arquivo(s) sem commit"
git log --oneline -3
echo "==> Item ativo: $(node -e 'const l = JSON.parse(require("fs").readFileSync("feature_list.json", "utf8")); console.log(l.features.filter((f) => f.state === "active").map((f) => f.id + " " + f.behavior).join("; ") || "nenhum")')"
node takifly.ts status
