#!/usr/bin/env bash
# Create a durable OREN_HOME, seed corpus, print heartbeat install hints.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

export OREN_HOME="${OREN_HOME:-$ROOT/.oren-life}"
export OREN_LLM="${OREN_LLM:-pi}"
export OREN_MODEL="${OREN_MODEL:-deepseek:deepseek-v4-flash}"

echo "Setting up durable life at OREN_HOME=$OREN_HOME"
mkdir -p "$OREN_HOME"
# copy .env into life home so launchd can source it
if [[ -f "$ROOT/.env" && ! -f "$OREN_HOME/.env" ]]; then
  cp "$ROOT/.env" "$OREN_HOME/.env"
  # ensure model lines
  grep -q '^OREN_HOME=' "$OREN_HOME/.env" 2>/dev/null || echo "OREN_HOME=$OREN_HOME" >>"$OREN_HOME/.env"
  grep -q '^OREN_MODEL=' "$OREN_HOME/.env" || echo "OREN_MODEL=$OREN_MODEL" >>"$OREN_HOME/.env"
  grep -q '^OREN_LLM=' "$OREN_HOME/.env" || echo "OREN_LLM=$OREN_LLM" >>"$OREN_HOME/.env"
fi

node --import tsx src/cli.ts setup-life
node --import tsx src/cli.ts doctor || true

NODE_BIN="$(command -v node)"
PLIST_SRC="$ROOT/scripts/com.oren.tick.plist.example"
PLIST_DST="${HOME}/Library/LaunchAgents/com.oren.tick.plist"

echo ""
echo "== Heartbeat (optional) =="
echo "Generated agent command:"
echo "  OREN_HOME=$OREN_HOME $NODE_BIN --import tsx $ROOT/src/cli.ts tick"
echo ""
echo "To install launchd (every 30 min):"
echo "  bash $ROOT/scripts/install-heartbeat.sh"
echo "Plist target: $PLIST_DST (from $PLIST_SRC)"
echo ""
echo "Manual tick:"
echo "  export OREN_HOME=$OREN_HOME"
echo "  npm run oren -- tick"
echo "  npm run oren -- visit \"back briefly\""
echo "  npm run oren -- status"
