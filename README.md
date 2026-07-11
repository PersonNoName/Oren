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

### B) OpenAI 兼容接口（Chat Completions 格式 / 自定义网关）

很多中转、硅基流动、DeepSeek OpenAI 模式、自建 vLLM 都属于这类：

```bash
export OREN_LLM=pi
export OREN_MODEL=openai:你的模型名          # 网关文档里的 model id
export OPENAI_API_KEY=sk-...                 # 或网关发的 key
export OPENAI_BASE_URL=https://api.xxx.com/v1  # 必须带到 /v1 这一层（按网关文档）

npm run oren -- tick --force-mode contemplate
```

说明：

- **只要设置了 `OPENAI_BASE_URL`**，Oren 会走 **OpenAI Completions 兼容通道**（`openai-completions`），而不是官方 Responses API。
- `OREN_MODEL` 的 `openai:` 后面填网关要求的模型名，例如 `deepseek-chat`、`gpt-4o-mini`、`qwen-plus`。
- Key 也可用 `OPENAI_COMPAT_API_KEY`（与 `OPENAI_API_KEY` 二选一即可）。

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
