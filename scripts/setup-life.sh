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

# Prefer Application Support (launchd-friendly); override with OREN_HOME=
DEFAULT_HOME="$HOME/Library/Application Support/Oren"
export OREN_HOME="${OREN_HOME:-$DEFAULT_HOME}"
export OREN_LLM="${OREN_LLM:-pi}"
export OREN_MODEL="${OREN_MODEL:-deepseek:deepseek-v4-flash}"
export OREN_TICK_LLM="${OREN_TICK_LLM:-fake}"
export OREN_SAY_LLM="${OREN_SAY_LLM:-pi}"

echo "Setting up durable life at OREN_HOME=$OREN_HOME"
mkdir -p "$OREN_HOME"
# copy / merge .env into life home (Node loads this; do not bash-source under launchd)
python3 - <<PY
from pathlib import Path
import os
root = Path("$ROOT")
home = Path(os.environ["OREN_HOME"])
home.mkdir(parents=True, exist_ok=True)
kv = {}
for p in [root/".env", home/".env"]:
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k,v = line.split("=",1)
                kv[k.strip()] = v.strip()
# fix corrupted keys that accidentally stored a path ending in "life"
k = kv.get("DEEPSEEK_API_KEY","")
if (not k) or k.endswith("life") or len(k) > 80:
    if (root/".env").exists():
        for line in (root/".env").read_text().splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                kv["DEEPSEEK_API_KEY"] = line.split("=",1)[1].strip()
kv["OREN_HOME"] = str(home)
kv.setdefault("OREN_LLM", os.environ.get("OREN_LLM","pi"))
kv.setdefault("OREN_MODEL", os.environ.get("OREN_MODEL","deepseek:deepseek-v4-flash"))
kv.setdefault("OREN_TICK_LLM", "fake")
kv.setdefault("OREN_SAY_LLM", "pi")
(home/".env").write_text("\n".join(f"{a}={b}" for a,b in kv.items())+"\n")
print("wrote", home/".env", "keys", sorted(kv))
PY

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
