# Oren

Oren is a restartable, event-sourced life-kernel slice. The Phase 1 runtime
persists user input, cognition requests, effects, receipts, Inbox work, and
scheduled wakes in SQLite, then rehydrates the same `LifeState` after restart.

## Install and verify

```bash
npm install
npm test
npm run typecheck
npm run build
node --enable-source-maps dist/packages/app/src/demo.js
```

The demo is deterministic and offline. It executes a read, persists an
increment effect, dispatches it, resumes cognition from the durable Inbox,
schedules a wake, closes SQLite, reopens the database, and verifies exact
state replay.

## Real-model commands (optional, credential-gated)

Automated tests never call a real model. To run the manual paths, set:

```bash
export OREN_MODEL_PROVIDER=<pi-ai provider id>
export OREN_MODEL_ID=<model id>
# plus the provider's standard API key env var (e.g. ANTHROPIC_API_KEY)
```

- `npm run smoke` — full vertical slice (message → immediate read → durable
  increment → wait → receipt → new episode → scheduled wake → restart replay)
  against the configured model.
- `npm run eval` — behavioral scenario suite; `OREN_EVAL_RUNS` (default 3)
  runs per scenario, overall and per-scenario pass rate must reach
  `OREN_EVAL_THRESHOLD` (default 0.9).

Both commands print setup instructions and exit 0 when unconfigured.

## 记忆（Phase 3）

- Oren 从生命事件史投影可召回记忆：用户消息、Oren 的表达、线索推进自动入库；
  模型可通过 `Remember` / `ReviseBelief` / `Forget` 提议经营记忆。
- 召回默认使用向量检索（需配置 embedding 凭据）；未配置时自动降级为
  结构化检索（类型/线索/时间过滤 + 关键词 + 时近排序），离线测试全部走降级或假 embedder。
- 启用真实向量召回（可选，手动路径）：

  ```bash
  export OREN_EMBEDDING_PROVIDER=openai
  export OREN_EMBEDDING_MODEL=text-embedding-3-small
  export OPENAI_API_KEY=sk-...
  # 或任意 OpenAI 兼容端点：
  # export OREN_EMBEDDING_PROVIDER=openai-compatible
  # export OREN_EMBEDDING_BASE_URL=https://your-endpoint/v1
  # export OREN_EMBEDDING_API_KEY=...
  ```

- 「忘记」只降低可召回性，生命史与索引行都不会删除；记忆索引可随时从事件史重建。

## Architecture boundaries

- `LifeActor` is the only writer of life-state events.
- `SqliteLifeRepository` atomically appends events and their effect/schedule
  side tables; durable claims use leases and idempotency keys.
- Cognition depends on the generic `CognitionPort`. Pi and TypeBox imports are
  isolated to `packages/pi-cognition`; integration tests use fake streams.
- Extensions receive capability invocations, not SQLite or model credentials.
  Persistent capability calls end an episode and resume through a new,
  correlated Inbox episode.
- `LifeRuntime.drain()` drives due schedules, effect reconciliation, Inbox
  claims, actor transitions, and cognition to a bounded durable fixed point.
