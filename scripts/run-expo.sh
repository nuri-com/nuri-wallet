#!/usr/bin/env zsh
set -euo pipefail

# Ensure nvm is available in any shell
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"

# Switch to project Node (from .nvmrc)
if command -v nvm >/dev/null 2>&1; then
  nvm use >/dev/null || true
fi

# Resolve Node & npm from nvm (Node 22)
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "Node not found in PATH" >&2
  exit 1
fi

SCRIPT_DIR="${0:a:h}"
REPO_ROOT="${SCRIPT_DIR:h}"
cd "$REPO_ROOT"

# Prefer local @expo/cli if installed
if [ -f "./node_modules/@expo/cli/build/bin/cli.js" ]; then
  exec "$NODE_BIN" ./node_modules/@expo/cli/build/bin/cli.js "$@"
fi

# Fallback: use Node 22's npx to execute @expo/cli without relying on shell 'npx'
NPX_BIN="$(dirname "$NODE_BIN")/npx"
if [ -x "$NPX_BIN" ]; then
  exec "$NPX_BIN" @expo/cli "$@"
fi

echo "Could not find @expo/cli. Install it: npm i -D @expo/cli" >&2
exit 1
