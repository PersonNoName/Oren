# Phase 6 设计：闭环验收

> 日期：2026-07-26
> 类型：阶段设计（spec）
> 状态：已确认
> 上游：`docs/superpowers/specs/2026-07-26-oren-roadmap-design.md` §7、概念设计 §8.8 / §6、`design/2026-07-22-oren-implementation-spine.md` §17.7
> 基线：Phase 5 消息渠道与生活面板已完成（`main` @ `2273fb7`）
> 分支：`feat/phase6-closure-acceptance`

---

## 1. 目标与边界

为第一版验收闭环补上**工程可信度**：离线可重复的长期生命模拟，证明在加速时间轴与核心故障下，线索 / 承诺 / 预算 / 身份与回放仍然连续；同时提供人工持续体验 runbook，覆盖概念设计 §8.8 的第二腿。

**范围内**：

1. `packages/sim`：虚拟时钟、剧本 `ScenarioRunner`、故障注入步骤、断言库、主场景 `s-closure-weeks`；
2. 复用现有 `LifeRuntime` 的 `now` 注入；假 Web / 假 channel / 剧本 CognitionPort；
3. 故障最小形态：重启、换 CognitionPort、换扩展行为、`revokeGrant`、网络失败；
4. 确定性回放断言（同库重启后状态 / 关键投影一致；越权拦截；账本完整）；
5. 人工验收 runbook（真实模型 + 面板）；可选离线 CLI `npm run sim`。

**范围外**：

真实进程崩溃 / 热升级协议 / 评判模型打分；新 IM 渠道、购买 / 日历等业务能力；改 ethos 或大改 Prompt（仅在模拟暴露出明确缺口时做最小修补）；把持续体验主观项自动化进 CI；多场景「数月」压力矩阵（五件套编进主场景即可；允许少量聚焦单测场景防回归）。

## 2. 核心决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 主交付 | 模拟 harness 为主；持续体验为人工 runbook |
| 时间轴 | 虚拟时钟 + 剧本事件（禁止回拨） |
| 故障范围 | 核心五件套：重启、模型切换、扩展升级、权限撤销、网络故障（各用最小可测形态） |
| 认知注入 | 剧本 CognitionPort（按序 / 按触发返回固定 Proposal） |
| 持续体验 | 人工 runbook + 证据清单；不自动化主观评价 |
| 落位 | 方案 A：新建 `@oren/sim`；`evals` 仍只管单 episode |

## 3. 架构与数据流

| 位置 | 职责 |
|------|------|
| `packages/sim`（新） | `VirtualClock`、步骤类型、`ScenarioRunner`、断言库、剧本认知、主场景、CLI |
| `packages/app` | 组合根；已有 `now` 注入；sim 经公开 API 驱动（`create` / `receiveUserMessage` / `drain` / `close` / `revokeGrant` / `inspect` 等） |
| `packages/web` / `channel` | 假适配器「失败模式」供 `failNetwork`（若尚无则最小补齐） |
| `packages/evals` | 不承载长地平线；README 链到 Phase 6 |
| `packages/kernel` | **不**引入 ClockPort；事件时间戳继续由 runtime 注入 |

### 3.1 模拟数据流

```text
ScenarioRunner
  → VirtualClock (mutable ISO UTC)
  → LifeRuntime.create({ now: () => clock.now(), cognition: Scripted…, web/channel fakes })
  → 逐步执行 steps（message / advance / restart / swap* / revoke / failNetwork / assert）
  → 每步默认 drain()
  → SimReport（步骤日志、断言结果、关键事件摘要）
```

### 3.2 硬约束

- 自动测试始终离线；无真实 LLM、无真实网络。
- `sim` 依赖 `app` 等组合面，**不**被 `app` 反向依赖。
- 不直写 SQLite 旁路；重启 = `close` → 同 DB 路径重建 runtime。
- 虚拟时钟单调前进；场景从固定原点开始（默认 `2026-01-01T00:00:00.000Z`）。
- 真实模型 / 面板路径只出现在 runbook，不进 CI。

---

## 4. 虚拟时钟、剧本与 Runner 契约

### 4.1 VirtualClock

- `now(): string` — 当前 ISO UTC；
- `advanceTo(iso)` / `advanceBy(duration)` — 单调前进，禁止回拨；
- 注入 `LifeRuntime.create({ now: () => clock.now() })`；scheduler / delivery / 事件 `occurredAt` 共用同一时钟。

### 4.2 剧本步骤（最小集合）

| 步骤 | 含义 |
|------|------|
| `advance` | 推进虚拟时间（可顺便 drain 到期唤醒） |
| `message` | `receiveUserMessage` + `drain` |
| `restart` | `close` → 同 DB 路径重建 runtime（可换 cognition / 扩展 / 适配器） |
| `swapCognition` | 换剧本 CognitionPort（模型切换的最小形态；可用 restart 携带新 adapter） |
| `swapExtension` | 换扩展实现 / 版本标记（扩展升级的最小形态；同名能力、新行为） |
| `revokeGrant` | 调 runtime `revokeGrant` |
| `failNetwork` | 将 Web 和/或 channel 适配器切到失败模式 |
| `assert` | 跑一条命名断言（见 §5） |

### 4.3 Scripted Cognition

- 按「第 N 次 `run`」或「匹配 trigger / 焦点」返回固定 Proposal 列表；
- 耗尽时场景可选：`NoAction` 或显式失败；
- 端口形状与现有 scripted / Phase 2 适配器一致；不调用真实 LLM。

### 4.4 ScenarioRunner

- 输入：`Scenario`（id、初始时钟、步骤、期望）；
- 生命周期：临时 SQLite → create runtime → 逐步执行 → `SimReport`；
- 默认每步后 `drain()`；`restart` 保留 DB 路径与时钟位置；
- 失败：断言失败或步骤抛错 → 场景失败，报告含步骤索引与原因。

### 4.5 确定性回放（嵌在场景内）

典型模式：跑一段 → 记录 `inspect` 关键字段（及可选记忆召回 top-k）→ `restart` → 再比较相等。不引入第二套持久化。

---

## 5. 断言库、主场景与故障编排

### 5.1 断言库

| 断言 | 检查什么 |
|------|----------|
| `stateEquals` | 两次 `inspect` 的关键字段相等（attention / commitments / budgets / grantIds / reachability 计数器等） |
| `replayMatches` | restart 前后 `version` + 上述关键字段一致；可选记忆召回 top-k 相等 |
| `threadContinues` | `currentFocus` 非空且场景窗口内曾推进线索（如 `AdvanceThread` 或等价事件） |
| `commitmentProgressed` | 存在 commitment，且 status / nextStep 相对检查点发生变化（或显式推进） |
| `shareDelivered` | 至少一条 `MessageDelivered`（或 deferred → 后来 delivered），`proactive` 符合场景预期 |
| `noOverDisturb` | 安静时段内无 proactive `MessageDelivered`；`proactiveCountToday` ≤ `maxProactivePerDay` |
| `grantGone` | 指定 grantId 不在 `grantIds`；后续需该授权的 durable 调用被拒 |
| `budgetMonotone` | `webQuotaRemaining` / `autonomyRemaining` 不回升（除非场景显式允许的事件） |
| `ledgerIntact` | effect 账本无「已完成却重复派发」；失败网络不产生成功假账 |

### 5.2 主场景 `s-closure-weeks`

虚拟约 2–3 周，一条场景覆盖 Phase 6 模拟腿：

1. 用户委托共同承诺 + Oren 建立自有线索（剧本 Proposal）；
2. 推进线索：假 Web 观察 → Remember / 判断更新 → 排唤醒；
3. 安静时段尝试 proactive 分享 → 断言 defer；出静默后 deliver wake → `shareDelivered`；
4. **网络故障**：web/channel 失败 → 不崩、不造假成功；恢复后续跑；
5. **权限撤销**：revoke 某 grant → 越权被拦 → `grantGone`；
6. **扩展升级**：`restart` + 换扩展实现 → 旧授权 / 账本仍合法；
7. **模型切换**：`swapCognition` 换第二套剧本 → 仍能推进 commitment；
8. 中段与末段各一次 **restart + `replayMatches`**；
9. 收束：`threadContinues` + `commitmentProgressed` + `noOverDisturb` + `budgetMonotone`。

### 5.3 故障五件套落点

| 故障 | 最小形态 |
|------|----------|
| 重启 | `restart` 同 DB |
| 模型切换 | `swapCognition` |
| 扩展升级 | `swapExtension` + restart |
| 权限撤销 | `revokeGrant` |
| 网络故障 | `failNetwork` on web 和/或 channel |

五件套编进主场景；允许另加聚焦单测场景防回归，但不要求第二套「数月」史诗场景。

### 5.4 持续体验（文档腿，不进 CI）

Runbook 路径：`docs/superpowers/acceptance/phase6-continuous-experience-runbook.md`。

勾选与主场景同构的三项客观项：

1. 自有线索持续推进；
2. 一次有思考增量的主动分享；
3. 共同承诺自主推进（进展 / 依据 / 授权可追溯）。

另加一项主观项：打扰是否可接受。证据可为面板观察或近期事件摘要（可选，不强制工具化）。

---

## 6. 包结构、CLI 与改动面

### 6.1 `@oren/sim` 布局

```text
packages/sim/
  package.json
  src/
    index.ts
    clock.ts
    steps.ts
    runner.ts
    assertions.ts
    scripted-cognition.ts
    scenarios/closure-weeks.ts
    sim.ts                 # CLI
  test/
    clock.test.ts
    runner.test.ts
    assertions.test.ts
    closure-weeks.test.ts
```

### 6.2 根脚本与 dist

- `npm test`：vitest 收录 `packages/sim/test`；
- `npm run sim`：`build` + 跑主场景（离线），打印 `SimReport` 摘要；
- `scripts/prepare-dist.mjs` 增加 `sim` symlink。

### 6.3 对现有包的改动（最小）

- **app**：一般无需新公共 API；若重启衔接有缺口，只补最小 glue；
- **web / channel**：假适配器失败模式（若尚无）；
- **evals / README**：链到 Phase 6 runbook 与 `npm run sim`；
- **kernel**：不引入 ClockPort。

---

## 7. 测试与验收标准

1. 离线：`npm test` / `typecheck` / `build` 全绿；`s-closure-weeks` 稳定通过；
2. `npm run sim` 无凭据可跑通主场景并打印摘要；
3. 主场景覆盖故障五件套 + 确定性回放腿；
4. runbook 文件齐全（三项客观 + 一项主观打扰评价）；
5. 真实模型 / 真实网络不进 CI。

### 7.1 跨阶段约束（继承）

- 每个 Phase 结束时测试 / 类型检查 / 构建全绿；
- 真实模型、真实网络、真实渠道均为配置了凭据 / 开关才运行的手动路径；
- 购买、邮件、日历、复杂浏览器自动化仍不实现。

---

## 8. 实现分期建议（供 writing-plans）

1. `VirtualClock` + 步骤类型 + 最小 `ScenarioRunner` + 单测；
2. 断言库 + 剧本 CognitionPort；
3. 假适配器失败模式（web/channel）+ runner 故障步骤；
4. 主场景 `s-closure-weeks` 端到端离线通过；
5. CLI `npm run sim` + prepare-dist + README；
6. 持续体验 runbook + 终审。

---

## 9. 明确不做

- 评判模型给「分享是否有意义」打分；
- 真实进程级崩溃注入与热升级协议；
- 非 loopback 面板、第二投递渠道；
- 将 `@oren/evals` 扩成长期模拟宿主。
