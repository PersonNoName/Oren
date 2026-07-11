# Oren Runtime v1

A no-UI runtime for **Oren**: a continuous-presence agent with its own inner life (local corpus → contemplation → self-memory threads).

Companion is *not* the spine in v1 — there is no chat UI. Success is auditable mechanism: ticks, stream, and growing threads under `data/life`.

## Docs

- Essence: `design/2026-07-11-oren-core-essence.md`
- Architecture discussion: `discussion/2026-07-10-oren-agent-design.md`
- Technical spec: `docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-12-oren-runtime-v1.md`

## Setup

```bash
npm install
npm test
```

## Quick start (fake LLM, no API key)

```bash
export OREN_HOME=/tmp/oren-demo
export OREN_LLM=fake
npm run oren -- init
cp fixtures/corpus/*.md "$OREN_HOME/data/corpus/"
npm run oren -- tick --force-mode idle
npm run oren -- tick --force-mode contemplate
npm run oren -- status
```

Inspect:

- `data/life/threads/` — self-memory threads  
- `data/life/stream.jsonl` — consciousness / event log  
- `data/life/ticks/` — per-tick audit snapshots  

## Live LLM (pi-ai)

Uses `@earendil-works/pi-ai` (Models collection API, v0.80+).

```bash
npm install   # includes @earendil-works/pi-ai
export OREN_LLM=pi
export OREN_MODEL=anthropic:claude-sonnet-4-5   # default
# one of:
export ANTHROPIC_API_KEY=...
# or Claude-style:
export ANTHROPIC_AUTH_TOKEN=...   # mapped to ANTHROPIC_OAUTH_TOKEN
# optional gateway:
export ANTHROPIC_BASE_URL=https://your-gateway.example/api

npm run oren -- tick --force-mode contemplate
```

Live test (integration):

```bash
OREN_LIVE_LLM=1 OREN_LLM=pi npm test -- tests/llm/pi-ai-live.test.ts
```

Without a provider key / with `OREN_LLM=fake`, CLI uses the fake completer.

## Scheduling

v1 is a one-shot CLI. Use cron or launchd:

```cron
*/30 * * * * cd /path/to/home && OREN_HOME=/path/to/home OREN_LLM=fake /path/to/node --import tsx /path/to/oren/src/cli.ts tick
```

## What v1 does not do

- User chat / outreach  
- Wound/healing dynamics  
- Vector DB / multi-user  
- Modify the Pi monorepo (only optional npm dep on `pi-ai`)  

## Commands

| Command | Meaning |
|---------|---------|
| `oren init` | Create `data/life` + corpus README |
| `oren tick` | One experience-loop tick |
| `oren tick --force-mode …` | Force idle / organize / contemplate |
| `oren status` | Summary of meta, threads, recent stream |
