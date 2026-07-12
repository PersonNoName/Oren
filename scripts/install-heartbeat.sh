#!/usr/bin/env bash
# Install macOS LaunchAgent using compiled dist/cli.js (no tsx, no Documents chdir).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_HOME="$HOME/Library/Application Support/Oren"
OREN_HOME="${OREN_HOME:-$DEFAULT_HOME}"
NODE_BIN="$(command -v node)"
# Default 15 minutes. Shorter burns API when OREN_TICK_LLM=pi.
INTERVAL="${INTERVAL:-900}"
LABEL="com.oren.tick"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

cd "$ROOT"
npm run build >/dev/null

export OREN_HOME
bash "$ROOT/scripts/setup-life.sh" >/tmp/oren-setup-life.log

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/dist/cli.js</string>
    <string>tick</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${OREN_HOME}</string>
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
    <key>OREN_HOME</key>
    <string>${OREN_HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>NODE_PATH</key>
    <string>${ROOT}/node_modules</string>
  </dict>
</dict>
</plist>
EOF

echo "Wrote $PLIST"
echo "OREN_HOME=$OREN_HOME  interval=${INTERVAL}s  binary=$ROOT/dist/cli.js"
echo "LLM: set OREN_TICK_LLM=fake for cheap unsupervised ticks, or pi for live (costly)."
echo "Recommended cost posture: OREN_TICK_LLM=fake, OREN_PLAN_LLM=pi only when you force plan."
echo ""
echo "Reload:"
echo "  launchctl bootout gui/\$(id -u) $PLIST 2>/dev/null || true"
echo "  launchctl bootstrap gui/\$(id -u) $PLIST"
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "Logs: /tmp/oren-tick.out.log /tmp/oren-tick.err.log"
