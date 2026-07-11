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
npm run oren -- setup-life
npm run oren -- tick --force-mode idle
npm run oren -- tick --force-mode contemplate
npm run oren -- visit "checking in"
npm run oren -- status
npm run oren -- doctor
```

## Durable life + heartbeat (recommended)

Default durable home (launchd-friendly):

`~/Library/Application Support/Oren`

```bash
bash scripts/setup-life.sh
export OREN_HOME="$HOME/Library/Application Support/Oren"

npm run oren -- doctor
npm run oren -- tick
npm run oren -- visit "evening presence"
npm run oren -- say "what are you thinking about?"

# install + load LaunchAgent (every 30m, OREN_TICK_LLM=fake by default — cheap)
bash scripts/install-heartbeat.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.oren.tick.plist
# logs: /tmp/oren-tick.out.log
```

Uses compiled `dist/cli.js` under launchd (no `tsx`, avoids macOS Documents sandbox issues).

`oren visit [note]` marks companion contact (absence clock). Contemplation may feel the absence as background texture only — not chat.

### Talk to Oren (`say`)

Overflow channel — companion speaks; Oren replies with **seepage** from current threads and may **share** a slice of inner life (gate stays with Oren).

```bash
export OREN_HOME=/path/to/.oren-life
npm run oren -- say "what have you been thinking about?"
npm run oren -- say "hey, just checking in"
npm run oren -- history 20
```

Artifacts: `data/life/dialogue.jsonl` + stream events `user_message` / `oren_reply` / `inner_share`.

Relationship cognition (`relation.json`): cold/warm topics from reception — **does not rewrite Oren's interests**, only calibrates how often to share.

### Dashboard (read-only)

```bash
export OREN_HOME="$HOME/Library/Application Support/Oren"
npm run oren -- serve
# open http://127.0.0.1:8787
# npm run oren -- serve --port 8790
```

Shows active threads, **recent monologues**, dialogue, corpus, stream, relation.
- Chat → `/api/say`
- **Tick** → `/api/tick`
- Corpus add → `POST /api/corpus` `{ name, content }`
- Corpus preview → `GET /api/corpus?name=`
- Corpus delete → `DELETE /api/corpus?name=`
- Monologues filterable by thread in the UI
Auto-refreshes every 15s. Bound to `127.0.0.1` only.

### Dual LLM (cost control)

```bash
# cheap unsupervised life + live conversation
export OREN_TICK_LLM=fake
export OREN_SAY_LLM=pi
export OREN_MODEL=deepseek:deepseek-v4-flash
```

Inspect:

- `data/life/threads/` — self-memory threads  
- `data/life/stream.jsonl` — consciousness / event log  
- `data/life/ticks/` — per-tick audit snapshots  

## Live LLM (pi-ai)

Uses `@earendil-works/pi-ai` (Models collection API, v0.80+).

```bash
export OREN_LLM=pi
npm run oren -- tick --force-mode contemplate
```

### A) OpenAI 官方

```bash
export OREN_LLM=pi
export OREN_MODEL=openai:gpt-4o-mini   # 或 gpt-4o / gpt-4.1-mini 等
export OPENAI_API_KEY=sk-...

npm run oren -- tick --force-mode contemplate
```

### B) DeepSeek（推荐）

pi-ai 已内置，base 为 `https://api.deepseek.com`：

```bash
export OREN_LLM=pi
export OREN_MODEL=deepseek:deepseek-v4-flash   # 或 deepseek:deepseek-v4-pro
export DEEPSEEK_API_KEY=sk-...                  # platform.deepseek.com

npm run oren -- tick --force-mode contemplate
```

### C) 其它 OpenAI 兼容网关

```bash
export OREN_LLM=pi
export OREN_MODEL=openai:你的模型名
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.xxx.com/v1

npm run oren -- tick --force-mode contemplate
```

设置了 `OPENAI_BASE_URL` 后走 Completions 兼容通道；key 也可用 `OPENAI_COMPAT_API_KEY`。

### D) Anthropic / Claude 风格

```bash
export OREN_LLM=pi
export OREN_MODEL=anthropic:claude-sonnet-4-5
export ANTHROPIC_API_KEY=...
# 或 Claude Code 风格：
export ANTHROPIC_AUTH_TOKEN=...   # 会映射为 ANTHROPIC_OAUTH_TOKEN
# 可选 Messages 网关：
export ANTHROPIC_BASE_URL=https://your-gateway.example/api
```

### Live 测试

```bash
OREN_LIVE_LLM=1 OREN_LLM=pi OREN_MODEL=openai:gpt-4o-mini npm test -- tests/llm/pi-ai-live.test.ts
```

未配置 key 时，或 `OREN_LLM=fake` 时，使用本地 Fake 沉思。

## Mechanism B demo (multi-tick)

After D works, verify unsupervised multi-tick growth (default **fake** LLM — free):

```bash
bash scripts/verify-mechanism-b.sh
# optional: N=12 GAP_SEC=1
# live DeepSeek (costs tokens): LIVE=1 bash scripts/verify-mechanism-b.sh
```

Expects: multiple modes, thread re-engagement, `explore` reason, `gap_ms > 0`.

## Scheduling

v1 is a one-shot CLI. Heartbeat = external scheduler.

**cron** (every 30 minutes):

```cron
*/30 * * * * cd /Users/robot/Documents/Projects/Oren && OREN_HOME=/Users/robot/Documents/Projects/Oren/.oren-life /usr/bin/env bash -lc 'set -a; source .env; set +a; node --import tsx src/cli.ts tick' >>/tmp/oren-tick.log 2>&1
```

**launchd** (macOS): copy `scripts/com.oren.tick.plist.example` to `~/Library/LaunchAgents/com.oren.tick.plist`, edit paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.oren.tick.plist
```

Keep a dedicated `OREN_HOME` directory (not the repo root if you prefer) so life state survives.

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
