# Phase 4 设计：Web 阅读与来源

> 日期：2026-07-26
> 类型：阶段设计（spec）
> 状态：已确认
> 上游：`docs/superpowers/specs/2026-07-26-oren-roadmap-design.md` §5、`design/2026-07-22-oren-implementation-spine.md` §8（即时通道与 Observation）、概念设计 §8.2
> 基线：Phase 3 记忆投影已完成（`main` @ `5f3d4ef`）
> 分支：`feat/phase4-web-reading`

---

## 1. 目标与边界

为闭环补上**值得分享的世界输入**：受限 Web 检索与阅读，经预算校验，留下带来源的观察，并投影为可召回的外部事实；观点不得伪装成事实。

**范围内**：

1. `packages/web`：`WebPort`、假/真适配器、URL 安全与截断、`web.search` / `web.read` 内置扩展；
2. 内核：`ObservationRecorded` 核心事件 + `budgets.webQuotaRemaining`；
3. 运行时：调用前配额校验、成功后写观察并扣配额；即时通道（`read_only` + `replay_safe` + `billable`）；
4. 记忆投影：`ObservationRecorded` → `external_fact`；
5. prompts「来源与事实」纪律；离线测试 + 可选真实网络 smoke/评估场景。

**范围外**：

浏览器自动化、登录态抓取、无限滚动、购买/邮件/日历、多搜索供应商智能路由、Observation 复杂去重合并、消息渠道与面板（Phase 5）。

## 2. 核心决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 数据来源 | 脚本假源 + 可选真实 HTTP（凭据门控） |
| 观察入史 | 核心事件 `ObservationRecorded`（非仅靠模型 Remember、非旁路库） |
| 预算 | `LifeState.budgets.webQuotaRemaining`（按次） |
| 能力表面 | `web.search` + `web.read` 两个即时能力 |
| 受限策略 | 严格限额（条数、截断、禁私网、仅 http(s)） |
| 落位 | 方案 A：`packages/web` + 内置扩展，镜像 memory 模式 |

## 3. 架构与数据流

| 位置 | 职责 |
|------|------|
| `packages/kernel` | `ObservationRecorded`；`webQuotaRemaining`；reducer 扣配额；预算校验辅助 |
| `packages/web`（新） | `WebPort`、Scripted/Http 适配器、安全校验、截断、`createWebExtension` |
| `packages/memory` | 投影 `ObservationRecorded` → `external_fact` |
| `packages/app` | 注册扩展、注入适配器、成功路径写观察+扣配额 |
| `packages/pi-cognition` / `evals` | 来源纪律 prompts；行为场景 |

典型流程：

```text
模型 → web.search(query)
  → 配额 > 0？→ WebPort.search → ≤5 条结果
  → commit ObservationRecorded（整次搜索 1 条观察）+ webQuotaRemaining -= 1
  → 结果回 episode

模型 → web.read(url)
  → 安全校验 + 配额 → WebPort.read → 截断正文
  → ObservationRecorded + 扣 1
  → 模型据此 Remember / ReviseBelief（判断须标置信度）
```

通道由 traits 决定：`read_only` + `replay_safe` + `billable` 仍走**即时通道**（与骨架一致：`billable` 不强制持久通道）。LLM 不能选择绕过。真实网络仅发生在凭据门控的 Http 适配器内。

## 4. 事件、预算与能力契约

### 4.1 预算

```text
budgets.webQuotaRemaining: number
```

- `createInitialLifeState` / runtime `initialize`：demo 与常规初始化显式设为 **8**。
- 旧快照缺少该字段时，加载/校验路径按 **0** 处理（安全默认），避免静默赠送配额。
- `hasValidLifeStateBudgets` 要求该字段为非负安全整数（有字段时）。

### 4.2 `ObservationRecorded`

```text
ObservationRecorded {
  observationId: string
  kind: "web_search_result" | "web_page"
  sourceUrl: string
  title?: string
  excerpt: string
  retrievedAt: string   // ISO instant
  query?: string        // search 时必填语义；read 可省略
  confidence: number    // [0,1]；抓取默认建议 0.7（来源可信度，非 Oren 判断）
}
```

- Reducer：事件合法且 `webQuotaRemaining >= 1` 时写入史并将配额减 1；否则拒绝该事件（不得部分提交）。
- **一次成功的 search 或 read 只产生一条观察、扣 1 次配额**。search 多条结果折叠进同一条 `excerpt`（结构化摘要），避免一次搜索耗尽配额。
- 调用失败（安全拒绝、网络失败、适配器 failed）：**不**写观察、**不**扣配额。
- 调用前若 `webQuotaRemaining < 1`：拒绝，`reason: "web_quota_exhausted"`，不发起适配器调用。

### 4.3 能力

| 能力 | 输入 | 输出 | traits | permissions |
|------|------|------|--------|-------------|
| `web.search` | `{ query, limit? }`（limit 默认 3、硬顶 5） | `{ results: [{ title, url, snippet }] }` | `read_only`, `replay_safe`, `billable` | `[]` |
| `web.read` | `{ url }` | `{ url, title?, text }`（text 截断） | 同上 | `[]` |

首版不依赖 grant 模式匹配；约束靠配额 + 安全校验（与 `memory.recall` 同哲学）。

### 4.4 记忆投影

`ObservationRecorded` → `MemoryEntry`：

- `kind: "external_fact"`
- `text`：由 title + excerpt 组成的可读陈述（标明来自网页/搜索）
- `sourceEventId` / `occurredAt`：观察事件
- `confidence`：沿用事件
- `memoryId`：确定性派生（如 `mem:${eventId}`），保证 rebuild 一致

## 5. `packages/web`

### 5.1 `WebPort`

```text
WebPort {
  search(input: { query: string; limit: number }): Promise<SearchResult>
  read(input: { url: string }): Promise<ReadResult>
}
```

### 5.2 安全（假源与真源共用）

- 仅 `http:` / `https:`
- 拒绝 localhost、链路本地、私网（含 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`::1` 等）
- search `limit` 硬顶 5；read 正文截断 **8192** 字符；fetch 超时建议 **10s**，并限制响应体积
- 域名黑名单：首版空列表，接口预留

### 5.3 适配器

- **ScriptedWebAdapter**：测试注入固定响应；仍走同一安全/截断路径。
- **HttpWebAdapter**（凭据门控）：
  - 搜索供应商首版锁定 **一家**（实现计划在 Tavily / Brave 中选定并写死配置键）；未配置则不得在生产路径静默调用网络。
  - 阅读：受限 `fetch` + 粗抽取（去除 script/style 等后取文本）。
- **注册策略**：单元/集成测试与 demo 注入 Scripted；未配置真实凭据时 **不注册** web 扩展（或仅测试显式注入）。smoke 在配置齐全时可跑真实 search+read。

### 5.4 扩展

`createWebExtension(port: WebPort): OrenExtension`，manifest id `"web"`，暴露上述两能力。

### 5.5 配置（真实路径）

环境变量形态（实现计划给出最终键名）：供应商、模型/引擎 id（若需要）、API key；解析失败 → `unconfigured` / `invalid`，与 Phase 2/3 门控模式一致。**解析阶段不发网络请求。**

## 6. 运行时接入

- `LifeRuntime` 持有可选 `WebPort`（默认测试用 Scripted；选项可覆盖）。
- 在 capability 调用成功且能力名为 `web.search` / `web.read` 时：由运行时（非扩展自身）生成 `observationId`，提交 `ObservationRecorded`（从而扣配额）。扩展只返回工具结果，**不拥有**观察写入权。
- 配额预检：在 invoke 包装层读取当前 `LifeState.webQuotaRemaining`，不足则直接 `rejected`。
- `prepare-dist.mjs` 增加 `web` 包符号链接；`packages/app` 依赖 `@oren/web`。

## 7. Prompts 与评估

- system prompt 增加「来源与事实」：引用网页须带来源；搜索/阅读结果是观察不是结论；判断用 `oren_judgment` + confidence；不得把 snippet 说成亲历核实。
- evals：至少 2 个场景——（1）需要外部信息时调用 search（及必要时 read），表达中体现来源；（2）配额耗尽时不继续硬调 web，缩小行动或说明受限。
- smoke（可选真实）：配置 web + 模型凭据后，跑「围绕线索 search → read → 观察入史 → 可召回」。

## 8. 测试与验收

**离线（进 `npm test`）**：

1. 配额耗尽 → 拒绝，无观察、无网络；
2. search/read 成功 → 一条 `ObservationRecorded`、配额 -1、记忆可召回 `external_fact`；
3. 私网/非法 scheme URL 被拒；
4. limit 封顶与正文截断；
5. Scripted 垂直切片：search → read → 后续 Remember/ReviseBelief 可用；
6. 重启后观察与投影记忆仍在；
7. 索引 rebuild 后与增量投影一致（含 Observation 派生条目）。

**手动**：真实 Http 适配器凭据门控；不进入 CI 完成标准。

**门槛**：`npm test` / `typecheck` / `build` 全绿且完全离线。

## 9. 涉及包（预期）

| 位置 | 变更 |
|------|------|
| `packages/kernel` | 事件、state 预算、reducer、validation、actor/runtime 辅助 |
| `packages/web`（新） | 端口、安全、适配器、扩展 |
| `packages/memory` | Observation → external_fact 投影 |
| `packages/app` | 接线、配额预检、观察提交、测试 |
| `packages/pi-cognition` | 来源纪律 |
| `packages/evals` | web 行为场景 |
| `scripts/prepare-dist.mjs` / lockfile / README | 包链接与用法 |
