# Daily serve entry (`npm run start`)

Date: 2026-07-26  
Status: approved for planning  
Scope: long-running local life process with browser panel; not smoke, not a daemon manager.

## Problem

Smoke / demo / sim verify slices and then exit. There is no product entry that keeps Oren alive so a person can message it from the existing life panel and let scheduled wakes fire.

## Goals

- One command starts a durable SQLite life + real-model cognition + loopback panel.
- Terminal is launcher/logger only; conversation happens in the browser panel.
- Background `drain` advances due wakes and effect reconciliation while the process runs.
- Panel message handling settles the durable workflow in-request (`receiveUserMessage` then `drain`).
- Clear config defaults with env overrides; missing model credentials fail loudly.

## Non-goals

- Terminal REPL / chat CLI.
- Multi-Oren process manager, pid files, or background daemonization.
- Changing Cognition / Actor / kernel event contracts.
- Redesigning the panel UI.
- CI-gated real-model E2E for serve.

## Architecture

```text
npm run start
  → resolveModelConfig(oren.json + env)
  → LifeRuntime.create(db, PiCognitionAdapter, { enablePanel, panelPort, … })
  → initialize(orenId, personId)
  → print panelUrl + db path + model id
  → setInterval(drain)
  → wait for SIGINT/SIGTERM → close()
```

New app entry (alongside smoke/demo):

- `packages/app/src/serve.ts` — process main
- `packages/app/src/serve-runner.ts` — start/stop orchestration (testable)
- `package.json`: `"start": "npm run build && node --enable-source-maps dist/packages/app/src/serve.js"`

Smoke remains the credential-gated vertical-slice acceptance script. Serve does not call smoke assertions.

### Small runtime fix

Today panel `postMessage` only calls `receiveUserMessage`. Serve needs settled durable work without waiting for the timer.

In `LifeRuntime.create` panel handlers:

1. `receiveUserMessage(…)`
2. `await drain()`

This applies whenever the panel is enabled (including tests), which matches product expectations.

## Configuration

| Item | Default | Override |
|------|---------|----------|
| SQLite path | `~/.oren/life.db` (create parent dirs) | `OREN_DB` |
| Panel port | `7465` | `OREN_PANEL_PORT` |
| Identity | `oren-local` / `person-local` | `OREN_ID` / `OREN_PERSON_ID` |
| Model | existing `oren.json` + provider key env | same as smoke (`OREN_MODEL_*`, `OREN_CONFIG`, …) |
| Drain interval | `2000` ms | `OREN_DRAIN_INTERVAL_MS` |

Serve always sets `enablePanel: true` (no need for `OREN_PANEL=1`).

Real optional paths mirror smoke when credentials are present:

- `useProcessEmbeddingEnv: true`
- `useProcessWebEnv: true` only when `resolveWebConfig` succeeds

## Runtime behavior

### Start

1. Resolve model config. On failure: print redacted reason, exit non-zero (`unconfigured` and hard errors both non-zero for serve — unlike smoke’s soft skip for unconfigured).
2. Ensure database parent directory exists.
3. Create runtime with panel on the configured port.
4. `initialize` identity (conflict with an existing different identity in the DB still errors as today).
5. Log: redacted db path, provider/id, `panelUrl()`.
6. Start drain interval; keep the event loop alive.

### While running

- Browser uses existing panel static UI and `/api/*` write/read routes.
- Concurrent drains coalesce via existing `activeDrain` tracking.
- Interval drain errors are logged (redacted) and do not crash the process unless `close` is in progress.
- Terminal does not accept chat input.

### Shutdown

- `SIGINT` / `SIGTERM`: clear interval → `await runtime.close()` → exit 0.
- Bind failure (port in use): fail start with a clear error, exit non-zero.
- No pid file.

## Docs

- README: “Daily use” section with `source .env` + `npm run start`, note panel URL and Ctrl+C.
- `.env.example`: commented `OREN_DB`, `OREN_PANEL_PORT`, identity vars.

## Testing

Offline only:

1. Pure helpers for default db path, port parse, interval parse (invalid → error).
2. Panel integration: with `enablePanel`, posting a message results in drained durable work (extend existing panel tests / scripted cognition) — asserts the postMessage→drain contract.
3. Serve-runner unit test with injected cognition + temp DB: starts, exposes URL, drains on interval or after message, closes cleanly. Prefer not binding real network longer than needed; follow existing panel test patterns.

No real-model serve gate in CI.

## Success criteria

- After `set -a && source .env && set +a`, `npm run start` prints a `http://127.0.0.1:7465/` (or configured) URL and stays up.
- Sending a message from the panel produces cognition + deliveries visible in snapshot/inbox without restarting the process.
- A `ScheduleWake` due while the process is idle is eventually handled by interval drain.
- Ctrl+C leaves SQLite closed cleanly; restarting `npm run start` with the same `OREN_DB` rehydrates the same life.
