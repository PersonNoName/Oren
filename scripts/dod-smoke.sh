#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OREN_HOME
OREN_HOME="$(mktemp -d /tmp/oren-dod-XXXXXX)"
export OREN_LLM=fake
cd "$ROOT"
echo "OREN_HOME=$OREN_HOME"
node --import tsx src/cli.ts init
cp fixtures/corpus/*.md "$OREN_HOME/data/corpus/"
BEFORE=$(find "$OREN_HOME/data/corpus" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
node --import tsx src/cli.ts tick --force-mode idle
node --import tsx src/cli.ts tick --force-mode contemplate
node --import tsx src/cli.ts status
AFTER=$(find "$OREN_HOME/data/corpus" -type f -exec shasum -a 256 {} \; | sort | shasum -a 256)
test "$BEFORE" = "$AFTER"
grep -q thought_written "$OREN_HOME/data/life/stream.jsonl"
test -n "$(ls "$OREN_HOME/data/life/threads"/*.json 2>/dev/null | head -1)"
echo "DoD smoke OK ($OREN_HOME)"
