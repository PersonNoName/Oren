#!/usr/bin/env bash
# Install macOS launchd agent for Oren ticks. Does not start until load.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OREN_HOME="${OREN_HOME:-$ROOT/.oren-life}"
NODE_BIN="$(command -v node)"
INTERVAL="${INTERVAL:-1800}" # seconds
LABEL="com.oren.tick"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$OREN_HOME"

# Ensure life exists
export OREN_HOME
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
export OREN_HOME
node --import tsx "$ROOT/src/cli.ts" setup-life >/dev/null

# Prefer life-local .env
if [[ -f "$ROOT/.env" && ! -f "$OREN_HOME/.env" ]]; then
  cp "$ROOT/.env" "$OREN_HOME/.env"
fi

TICK_CMD="cd '$ROOT' && set -a && [ -f '$OREN_HOME/.env' ] && source '$OREN_HOME/.env'; set +a; export OREN_HOME='$OREN_HOME'; exec '$NODE_BIN' --import tsx '$ROOT/src/cli.ts' tick"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${TICK_CMD}</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/oren-tick.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/oren-tick.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

echo "Wrote $PLIST"
echo "Interval=${INTERVAL}s OREN_HOME=$OREN_HOME"
echo ""
echo "Load (starts heartbeat):"
echo "  launchctl bootout gui/\$(id -u) $PLIST 2>/dev/null || true"
echo "  launchctl bootstrap gui/\$(id -u) $PLIST"
echo "  launchctl enable gui/\$(id -u)/$LABEL"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo ""
echo "Unload:"
echo "  launchctl bootout gui/\$(id -u) $PLIST"
echo ""
echo "Logs: /tmp/oren-tick.out.log  /tmp/oren-tick.err.log"
echo ""
echo "NOTE: live LLM ticks cost money. Set OREN_LLM=fake in $OREN_HOME/.env for free heartbeat,"
echo "      or keep OREN_LLM=pi with DeepSeek for real contemplation."
