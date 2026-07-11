#!/usr/bin/env bash
# Live verification: DeepSeek contemplate tick + expectation checks
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# load .env into this shell for preflight
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

export OREN_LLM="${OREN_LLM:-pi}"
export OREN_MODEL="${OREN_MODEL:-deepseek:deepseek-v4-flash}"
export OREN_HOME="${OREN_HOME:-$(mktemp -d /tmp/oren-ds-XXXXXX)}"

echo "== preflight =="
echo "OREN_HOME=$OREN_HOME"
echo "OREN_MODEL=$OREN_MODEL"
echo "OREN_LLM=$OREN_LLM"
echo "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:+set}"

if [[ -z "${DEEPSEEK_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo "FAIL: no DEEPSEEK_API_KEY (or OPENAI_API_KEY) in environment or .env"
  echo "Create $ROOT/.env from .env.example and set DEEPSEEK_API_KEY=sk-..."
  exit 3
fi

echo "== auth resolve =="
node --import tsx -e "
import { loadDotEnv } from './src/load-env.ts';
loadDotEnv();
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
const m = builtinModels();
const model = m.getModel('deepseek','deepseek-v4-flash');
if (!model) throw new Error('model deepseek-v4-flash missing');
const auth = await m.getAuth(model);
if (!auth) throw new Error('auth not resolved — check DEEPSEEK_API_KEY');
console.log('auth_ok source=' + auth.source);
"

echo "== init + corpus =="
node --import tsx src/cli.ts init
mkdir -p "$OREN_HOME/data/corpus"
cp fixtures/corpus/*.md "$OREN_HOME/data/corpus/"

echo "== contemplate tick =="
node --import tsx src/cli.ts tick --force-mode contemplate

echo "== status =="
node --import tsx src/cli.ts status

echo "== expectations =="
python3 - <<'PY'
import json, glob, os, sys
home = os.environ["OREN_HOME"]
life = os.path.join(home, "data/life")
stream = open(os.path.join(life, "stream.jsonl")).read().splitlines()
types = [json.loads(l)["type"] for l in stream if l.strip()]
need = ["tick_started", "mode_chosen", "corpus_read", "thought_written", "thread_created", "tick_finished"]
missing = [t for t in need if t not in types]
if missing:
    print("FAIL stream missing", missing); sys.exit(1)
print("stream_ok", need)

ticks = sorted(glob.glob(os.path.join(life, "ticks", "*.json")))
assert ticks, "no tick snapshot"
snap = json.load(open(ticks[-1]))
assert snap.get("mode") == "contemplate", snap.get("mode")
plan = snap.get("reading_plan") or {}
items = plan.get("items") or []
assert items, "empty reading_plan"
art = snap.get("parsed_artifact") or {}
assert art.get("monologue"), "no monologue"
assert art.get("refined_summary") or art.get("open_questions"), "empty useful fields"
threads = glob.glob(os.path.join(life, "threads", "*.json"))
assert threads, "no thread files"
t = json.load(open(threads[0]))
assert t.get("summary"), "thread summary empty"
# corpus unchanged
print("tick_mode", snap["mode"])
print("read", [(i.get("path"), i.get("reason")) for i in items])
print("monologue_preview", (art.get("monologue") or "")[:180].replace("\n"," "))
print("summary", (art.get("refined_summary") or "")[:160])
print("questions", art.get("open_questions"))
print("thread", t.get("id"), t.get("title"))
print("ALL_EXPECTATIONS_OK")
PY

echo "PASS: DeepSeek live path matches expectations ($OREN_HOME)"
