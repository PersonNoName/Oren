# Phase 5 设计：消息渠道与生活面板

> 日期：2026-07-26
> 类型：阶段设计（spec）
> 状态：已确认
> 上游：`docs/superpowers/specs/2026-07-26-oren-roadmap-design.md` §6、概念设计 §8.7 / §8.8 / §2.3、`design/2026-07-22-oren-implementation-spine.md`
> 基线：Phase 4 Web 阅读已完成（`main` @ `eea5883`）
> 分支：`feat/phase5-channel-panel`

---

## 1. 目标与边界

为闭环补上**主动分享的出口**与**可协作表面**：一个本地面板同时承担消息投递与生活面板；打扰边界入史可回放；最小共同承诺可展示、可纠错、可被自主推进。

**范围内**：

1. `packages/channel`：`ChannelPort`、假适配器、面板收件箱适配器；
2. `packages/panel`：loopback HTTP + 轻量单页；读投影 + 有限写 API；
3. 内核：打扰策略状态与事件；投递结果事件；最小承诺 Proposal/事件/`LifeState.commitments`；
4. 运行时：`ExpressToUser` 接受后按策略自动投递或延后；面板写路径只走受控 runtime 方法；
5. prompts / evals：主动分享与安静延后、承诺推进场景；离线测试默认不启监听。

**范围外**：

IM / 邮件 / 推送等第二渠道；购买、日历、复杂浏览器自动化；完整设置中心、记忆编辑器、任意事件注入；硬静音（丢弃消息）；多用户 / 非 loopback 暴露；Phase 6 长期生命模拟与双重验收本身。

## 2. 核心决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 用户可见表面 | 本地 Web 面板，兼投递与协作表面 |
| 投递触发 | 运行时在接受 `ExpressToUser` 后自动投递（不新增业务投递 Proposal） |
| 打扰边界 | 用户策略配置 + 事件入史；安静时段延后、主动分享频率帽 |
| 共同承诺 | 最小承诺模型（goal / status / nextStep / mayAdvanceAutonomously） |
| 面板写操作 | 有限纠错面：发消息、改策略、撤权、改承诺状态 |
| 落位 | 方案 A：`@oren/channel` + `@oren/panel`，镜像 web/memory |

## 3. 架构与数据流

| 位置 | 职责 |
|------|------|
| `packages/kernel` | 打扰策略状态；`MessageDelivered` / `MessageDeferred` / `MessageDeliveryFailed`；`ReachabilityPolicyUpdated`；承诺 Proposal/事件/`commitments[]`；`GrantRevoked` |
| `packages/channel`（新） | `ChannelPort.deliver`；`ScriptedChannelAdapter`；`PanelInboxAdapter` |
| `packages/panel`（新） | loopback server；`GET /api/snapshot`；有限写 API；轻量静态页 |
| `packages/app` | `ExpressToUser` → 策略门控 → channel；延后调度；挂载 panel；受控写方法 |
| `packages/pi-cognition` / `evals` | 分享/承诺纪律；行为场景 |
| `packages/memory`（轻触） | 可选：投递成功表达式与公开日记投影对齐（首版可用 `MessageDelivered` 直接进面板，不强制改记忆 schema） |

### 3.1 主动分享数据流

```text
Cognition 提出 ExpressToUser
  → LifeActor 接受（嵌入 CognitionCompleted；与今日行为一致，不另产表达事件）
  → LifeRuntime 判定 reachability
       ├─ 可达 → ChannelPort.deliver → commit MessageDelivered
       └─ 不可达 → commit MessageDeferred + 排队至 deferUntil
  → 到期再 deliver → MessageDelivered（同一 deliveryId）
  → 面板收件箱 / 时间线展示
```

### 3.2 硬约束

- 自动测试离线；默认不启 HTTP 监听。
- 面板只绑定 `127.0.0.1`；`OREN_PANEL=1` 或显式 `LifeRuntime` options 才监听。
- 写 API 禁止直写 SQLite；一律经 `LifeRuntime` 受控方法 → `LifeActor` / repository。
- 外部投递能力不做成模型必调的业务 Proposal；`ExpressToUser` 保持认知提案语义。
- 承诺属生命内核最小扩展（类比 Phase 3 记忆），不是第三方业务能力。

---

## 4. 事件、策略与承诺契约

### 4.1 打扰策略（`LifeState.reachability`）

```text
reachability: {
  quietHours: { start: "HH:MM", end: "HH:MM", timezone: "local" } | null
  maxProactivePerDay: number    // 默认 3
  deferWhenQuiet: true          // 首版固定 true；不做硬静音丢弃
}
```

- `createInitialLifeState`：提供合理默认（如 `quietHours: 22:00–08:00`、`maxProactivePerDay: 3`）。
- 旧快照缺字段时：加载路径填入上述默认（与「安全默认」一致：有边界，而非无限主动打扰）。

事件：

```text
ReachabilityPolicyUpdated {
  policy: <完整 reachability 快照>
  reason: string
}
```

**判定规则（运行时，非模型）**：

| 条件 | 行为 |
|------|------|
| `proactive: false`（会话内回复） | **立即**走 `ChannelPort.deliver`，豁免安静时段与频率帽 |
| `proactive: true` 且处于安静时段且 `deferWhenQuiet` | `MessageDeferred`，`cause: "quiet_hours"` |
| `proactive: true` 且当日已投递主动分享 ≥ `maxProactivePerDay` | `MessageDeferred`，`cause: "frequency_cap"`，`deferUntil` 为次日可投窗口起点 |
| `proactive: true` 且可达 | `ChannelPort.deliver` → `MessageDelivered` |

`proactive` 定义：本次认知的 `triggerKind === "foreground_user"` → `proactive: false`；其它触发（`scheduled_wake`、`commitment_due`、`effect_result`、`health_check` 等）→ `proactive: true`。  
策略判定的「当前时间」必须可注入（测试传入 `now`），不得依赖不可控的墙钟，以保证离线可测与回放。

### 4.2 投递结果事件

```text
MessageDelivered {
  deliveryId: string
  text: string
  reason: string
  channel: "panel"
  proactive: boolean
}

MessageDeferred {
  deliveryId: string
  text: string
  reason: string
  deferUntil: string   // ISO instant
  cause: "quiet_hours" | "frequency_cap"
}
```

- 由 `LifeRuntime` 在接受含 `ExpressToUser` 的认知结果后提交；一次表达对应一个 `deliveryId`（`nextId()`）。
- 同一认知若含多条 `ExpressToUser`：各生成独立 `deliveryId`，各自过策略。
- 延后到期：**必须**走持久调度——提交 `WakeScheduled`（`purpose` 约定为 `deliver:<deliveryId>`，payload/关联通过 runtime 侧 pending-delivery 表或从事件史按 `deliveryId` 重载 `MessageDeferred` 文本）。到点 `WakeDue` → 再 `deliver` → `MessageDelivered`（同一 `deliveryId`）。禁止仅内存 `setTimeout`。
- `ChannelPort.deliver` 失败：提交 `MessageDeliveryFailed`，**不得**写 `MessageDelivered`：

```text
MessageDeliveryFailed {
  deliveryId: string
  text: string
  reason: string
  code: string
}
```

### 4.3 最小承诺

**Proposal**（认知可提）：

```text
UpsertCommitment {
  commitmentId?: string          // 省略则由 LifeActor 分配
  goal: string                   // 非空
  status: "active" | "paused" | "done"
  nextStep: string               // 非空
  mayAdvanceAutonomously: boolean
}

UpdateCommitmentStatus {
  commitmentId: string
  status: "active" | "paused" | "done"
  nextStep?: string
  reason: string                 // 非空
}
```

**CoreEvent**：

```text
CommitmentUpserted { commitmentId, goal, status, nextStep, mayAdvanceAutonomously }
CommitmentStatusChanged { commitmentId, status, nextStep?, reason }
```

**`LifeState.commitments`**：

```text
commitments: ReadonlyArray<{
  commitmentId: string
  goal: string
  status: "active" | "paused" | "done"
  nextStep: string
  mayAdvanceAutonomously: boolean
}>
```

- Reducer：upsert 按 id 替换或追加；status 变更更新对应项；未知 `commitmentId` 的 `CommitmentStatusChanged`：**事件可入史，reducer 跳过状态变更**（与记忆未知 id 哲学一致：kernel 不查外部索引，但承诺在核心状态内——未知 id 则 no-op 且不抛，避免毒化回放）。校验层仍要求字段形状合法。
- `commitment_due` 触发：首版用 `ScheduleWake` + `purpose` 约定（如 `commitment:<id>`）唤醒即可，不另建承诺调度表。
- `budgets.commitmentRemaining`：首版可继续保持按 id 的 map，不在本 Phase 强制扣减语义；若未使用则保持空对象。

### 4.4 授权撤销

```text
GrantRevoked {
  grantId: string
  reason: string
}
```

- `LifeRuntime.revokeGrant(grantId, reason)`：repository 标记 `revoked_at` + 提交 `GrantRevoked`；并从 `LifeState.grantIds` 移除（若存在）。
- 已撤销的 grant 不可再用于 Guard。

### 4.5 面板写操作映射

| 用户动作 | Runtime 方法 | 事件 / 效果 |
|---------|--------------|-------------|
| 发消息 | `receiveUserMessage` | `UserMessageReceived` + 认知 |
| 改打扰策略 | `updateReachabilityPolicy` | `ReachabilityPolicyUpdated` |
| 撤销授权 | `revokeGrant` | `GrantRevoked` |
| 改承诺状态 | `updateCommitmentStatus` | `CommitmentStatusChanged` |

不做：手工改预算、编辑任意记忆、注入任意核心事件。

---

## 5. `packages/channel`

### 5.1 `ChannelPort`

```text
ChannelPort {
  deliver(input: {
    deliveryId: string
    text: string
    reason: string
    proactive: boolean
  }): Promise<{ ok: true, deliveredAt: string } | { ok: false, code: string, message: string }>
}
```

### 5.2 适配器

| 适配器 | 用途 |
|--------|------|
| `ScriptedChannelAdapter` | 离线测试：记录调用；可预设成功/失败 |
| `PanelInboxAdapter` | 将消息写入面板收件箱（进程内队列或经 panel 模块 API） |

策略门控**不**在 adapter 内；只在 `LifeRuntime`。

首版**不**向模型暴露 `message.deliver` 能力；投递由 runtime 驱动。若实现扩展仅为内部对称，也不得出现在默认 `LifeFrame` 能力列表。

---

## 6. `packages/panel`

### 6.1 Server

```text
createPanelServer({
  getSnapshot: () => PanelSnapshot | Promise<PanelSnapshot>
  postMessage / updateReachability / revokeGrant / updateCommitment
  host: "127.0.0.1"
  port: number
})
```

- 仅 `127.0.0.1`；拒绝非 loopback bind。
- 默认不启动；`options.enablePanel === true` 或 `useProcessPanelEnv && OREN_PANEL=1` 时由 `LifeRuntime` 启动。
- 静态轻量单页 + JSON API。

### 6.2 读：`GET /api/snapshot`

一次返回：

| 区块 | 来源 |
|------|------|
| inbox | `MessageDelivered` / `MessageDeferred` / 失败记录（近期） |
| attention | `LifeState.attention` + 近期线程摘要 |
| schedules | schedules 表（due / purpose） |
| commitments | `LifeState.commitments` |
| grants | repository grants（含 revoked 标记） |
| budgets | `LifeState.budgets` |
| actionLedger | 近期 Effect* + Observation* 摘要 |
| publicDiary | 近期 `MessageDelivered`（投递成功的分享即公开日记，首版） |

### 6.3 写 API

| 方法 | 路径 | 行为 |
|------|------|------|
| POST | `/api/message` | `{ text }` → `receiveUserMessage` |
| POST | `/api/reachability` | 策略快照 → `updateReachabilityPolicy` |
| POST | `/api/grants/:id/revoke` | `{ reason }` → `revokeGrant` |
| POST | `/api/commitments/:id` | `{ status, nextStep?, reason }` → `updateCommitmentStatus` |

### 6.4 UI

一屏信息架构：收件箱/最新分享 → 承诺与线索 → 授权/预算 → 行动账本。纠错控件贴在对应区块。轻量、非仪表盘堆砌；不引入第二视觉主题实验。

---

## 7. 运行时集成

`LifeRuntime`：

1. 接受认知结果后扫描 `ExpressToUser`；对每条执行策略门控与投递/延后。
2. 持有 `ChannelPort`（测试注入 scripted；面板模式用 `PanelInboxAdapter`）。
3. 暴露 `updateReachabilityPolicy` / `revokeGrant` / `updateCommitmentStatus` / `getPanelSnapshot`。
4. 可选启动 `createPanelServer`，shutdown 时关闭。
5. 延后投递与现有 scheduler/inbox 对齐，保证重启后仍可投递（事件史 + 持久调度，不得只靠内存）。

`prepare-dist.mjs` 增加 `channel`、`panel` 包 symlink。

---

## 8. Prompts 与评估

- System prompt：主动分享须有思考增量；尊重打扰边界（模型侧软约束 + 运行时硬门控）；承诺推进须更新 `nextStep` / status。
- Eval 场景（至少）：
  1. 主动分享 → 断言出现 `MessageDelivered`（或测试注入「可达」策略下的 delivered）；
  2. 安静时段 / 频率帽 → 断言 `MessageDeferred` 且未调用成功 deliver（或 scripted 无成功记录）；
  3. 承诺推进 → 断言 `UpsertCommitment` 或 `UpdateCommitmentStatus` / 对应事件。

---

## 9. 测试与验收

**离线必须**：

- channel scripted 单测；
- 策略门控（安静、频率、foreground 豁免）单测；
- 承诺 upsert/status、未知 id no-op；
- 撤权后 Guard 拒绝；
- runtime：`ExpressToUser` → delivered/deferred；
- panel：可不启服务器做 snapshot 纯函数测；可选 loopback 短集成测（无外网）。

**验收**：

- 用户能在面板收到有思考增量的分享；
- 面板呈现可协作、可授权、可纠错表面（策略、撤权、承诺状态）。

**跨阶段**：`npm test` / `typecheck` / `build` 全绿；真实面板监听为开关门控手动路径。

---

## 10. 非目标与风险

见 §1 范围外。主要风险：

| 风险 | 对策 |
|------|------|
| `ExpressToUser` 刷屏 | 频率帽 + 安静延后；foreground 豁免 |
| 面板写路径绕过 LifeActor | 只调 runtime 受控方法 |
| 承诺模型膨胀 | 字段与状态枚举锁定 |
| HTTP 测试变脆 | 默认 scripted、不监听 |
| 与「不为业务加 Proposal」表面冲突 | 投递走 runtime+事件；承诺属生命内核 |

Phase 6 将依赖本 Phase 的 channel/panel 表面做长期模拟与持续体验验收；本 Phase 不实现模拟层本身。
