#!/bin/bash
# Prepara a sessão na nuvem (celular / claude.ai/code): instala as
# dependências antes do agente começar, para `npm test` e `npm start`
# funcionarem de primeira num container recém-clonado.
set -euo pipefail

# Só no ambiente remoto. No CLI da sua máquina o hook não faz nada:
# lá você controla o node_modules.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# `npm install` (e não `npm ci`) porque o estado do container é cacheado
# depois do hook: nas próximas sessões isso vira um no-op rápido.
echo "[session-start] instalando dependências..."
npm install --no-audit --no-fund

echo "[session-start] pronto: $(node -v) · $(ls node_modules | wc -l) pacotes"
