# Oren

Oren is a restartable, event-sourced life-kernel slice. The Phase 1 runtime
persists user input, cognition requests, effects, receipts, Inbox work, and
scheduled wakes in SQLite, then rehydrates the same `LifeState` after restart.

## Install and verify

```bash
npm install
# If NODE_ENV=production, install still needs TypeScript for build/smoke:
#   npm install --include=dev
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

Automated tests never call a real model. To run the manual paths:

1. Copy `oren.json.example` → `oren.json` and set `model.provider` / `model.id`
   (API keys must **not** go in this file).
2. Put the provider key in a local `.env` (see `.env.example`), then load it
   without pasting into chat/history, e.g. `set -a && source .env && set +a`.
   Prefer a secrets manager / direnv in shared environments. If a key was ever
   pasted into a terminal transcript, rotate it.

DeepSeek example:

```bash
# oren.json: { "model": { "provider": "deepseek", "id": "deepseek-v4-pro" } }
# .env: DEEPSEEK_API_KEY=...
npm run smoke
```

Anthropic example:

```bash
# oren.json: { "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" } }
# .env: ANTHROPIC_API_KEY=...
```

Env overrides (optional): `OREN_MODEL_PROVIDER` / `OREN_MODEL_ID` override the
file when set. `OREN_CONFIG` points at an alternate config path. If the
configured provider's key is missing but another provider's key is present,
`resolveModelConfig` prints a mismatch hint.

- `npm run smoke` — full vertical slice (message → immediate read → durable
  increment → wait → receipt → new episode → scheduled wake → restart replay)
  against the configured model.
- `npm run eval` — behavioral scenario suite; `OREN_EVAL_RUNS` (default 3)
  runs per scenario, overall and per-scenario pass rate must reach
  `OREN_EVAL_THRESHOLD` (default 0.9).

Both commands print setup instructions and exit 0 when unconfigured.

## Daily use

Keep a local life running with the loopback panel API (real model required):

```bash
set -a && source .env && set +a
npm run start
```

The process prints `http://127.0.0.1:7465/` (API + legacy HTML). Recommended UI:

```bash
npm run panel-ui
```

Open `http://localhost:3000`. Point `PANEL_URL` at a non-default panel port if needed (e.g. `PANEL_URL=http://127.0.0.1:9001 npm run panel-ui`). Ctrl+C stops each process cleanly. Database defaults to `~/.oren/life.db` (`OREN_DB` to override).

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

- 「忘记」只降低可召回性，生命史与索引行都不会删除；记忆索引可随时从事件史重建：
  运维/操作者调用 `LifeRuntime.rebuildMemory()`（清空索引后从完整事件史重新投影，
  结果与增量投影一致），例如在更换 embedding 配置后为历史条目补齐向量。
- 自动化测试（`npm test`）永远离线：`LifeRuntime.create` 默认不读取
  `OREN_EMBEDDING_*` / 相关 API key 环境变量，即便它们在 shell 中已导出。
  只有显式传入 `embedder`，或显式设置 `useProcessEmbeddingEnv: true`
  （`npm run smoke` 对真实模型路径会这样做）时才会解析真实 embedding 凭据。

## Web 阅读（Phase 4）

- `web.search` / `web.read`：受限检索与阅读；成功后写入 ObservationRecorded 并消耗 webQuotaRemaining。
- 离线默认不注册真实 web；测试注入 ScriptedWebAdapter。
- 启用真实路径：

  ```bash
  export OREN_WEB_SEARCH_PROVIDER=tavily
  export TAVILY_API_KEY=...
  # LifeRuntime 需 useProcessWebEnv: true（smoke 在配置齐全时开启）
  ```

- 自动化测试（`npm test`）永远离线：`LifeRuntime.create` 默认不读取
  `OREN_WEB_SEARCH_PROVIDER` / `TAVILY_API_KEY`，即便它们在 shell 中已导出。
  只有显式传入 `webPort`，或显式设置 `useProcessWebEnv: true`
  （`npm run smoke` 在 web 凭据齐全时会对真实模型路径这样做）时才会解析真实 web 凭据。

## 消息渠道与生活面板（Phase 5）

- `ExpressToUser` 由运行时自动投递或延后：`MessageDelivered` / `MessageDeferred` /
  `MessageFailed` 写入生命史；主动分享受安静时段与每日频率帽门控（默认 UTC 22:00–08:00、
  每日最多 3 次主动分享）；foreground 用户消息回应不受安静时段限制。
- 最小共同承诺（`UpsertCommitment` / `UpdateCommitmentStatus`）可展示与纠错；
  面板与 runtime 共享同一 `LifeState` 投影。
- 面板默认不启动；仅 `127.0.0.1` loopback 监听。启用方式：

  ```bash
  export OREN_PANEL=1
  # LifeRuntime 需 useProcessPanelEnv: true（smoke 在配置齐全时开启）
  # 或显式 enablePanel: true
  ```

- 写 API（经面板 JSON 路由，均委托 `LifeRuntime` 受控方法）：

  | 方法 | 路径 | 行为 |
  |------|------|------|
  | POST | `/api/message` | `{ text }` → `receiveUserMessage` |
  | POST | `/api/reachability` | 策略快照 → `updateReachabilityPolicy` |
  | POST | `/api/grants/:id/revoke` | `{ reason }` → `revokeGrant` |
  | POST | `/api/commitments/:id` | `{ status, nextStep?, reason }` → `updateCommitmentStatus` |

- 读：`GET /api/snapshot` 一次返回 inbox、attention、schedules、commitments、grants、
  budgets、actionLedger、publicDiary。
- 自动化测试（`npm test`）永远离线：默认不监听 HTTP；测试注入 `ScriptedChannelAdapter`
  或 `enablePanel` 短集成测，不依赖外网。

## 闭环验收与模拟（Phase 6）

- `npm run sim` — 离线多周闭环回放（`s-closure-weeks`）：自有线索、主动分享、
  共同承诺、安静时段门控、网络故障注入；输出 `SimReport` JSON，`ok: true` 即通过。
  无需模型凭据，CI 可跑。
- 持续体验人工验收清单：
  [`docs/superpowers/acceptance/phase6-continuous-experience-runbook.md`](docs/superpowers/acceptance/phase6-continuous-experience-runbook.md)
  （需真实模型 + 可选 `OREN_PANEL=1`，不进 CI）。
- 与 Phase 5 面板关系：sim 使用 `PanelInboxAdapter` 与脚本化 cognition 在内存中
  验证闭环；人工 runbook 在真实模型 + 面板下勾选同等体验目标。

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
