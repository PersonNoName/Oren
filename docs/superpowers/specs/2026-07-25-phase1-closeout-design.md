# Phase 1 Closeout Design

> 日期：2026-07-25  
> 状态：已确认方向，待实现  
> 分支：`feat/oren-life-kernel`  
> 上游：`design/2026-07-22-oren-implementation-spine.md` §16–17、`docs/superpowers/plans/2026-07-23-oren-life-kernel.md`

---

## 1. 目标

把 Phase 1 生命内核收口为**可正式验收**的状态：自动测试、类型检查、构建与确定性 demo 全部通过；不引入真实模型、记忆、Web 或新业务扩展。

## 2. 当前缺口

`packages/app/test/effect-dispatcher.test.ts` 要求：runtime 开始关闭后，`EffectDispatcher` 不得再开始新的外部 dispatch。

现有实现缺口：

- `EffectDispatcherOptions` 只有 `now` / `claimLimit`，没有关闭闸门。
- `LifeRuntime` 已用 `runtimeGate.closed` 挡住认知侧即时能力调用，但未接到 Effect 调度器。
- 因此同一次 `runOnce()` 批内，若第一行执行过程中进入 closing，后续已 claim 的行仍会被 invoke。

表现：1 个失败测试；`typecheck` / `build` 因未知的 `acceptingWork` 属性失败；demo 依赖 build，未能作为门禁跑通。

## 3. 设计决策

在 `EffectDispatcher` 上增加可选闸门，并与 `LifeRuntime` 的关闭语义对齐。

### 3.1 `acceptingWork` 契约

```ts
export interface EffectDispatcherOptions {
  readonly now?: () => number;
  readonly claimLimit?: number;
  readonly acceptingWork?: () => boolean;
}
```

语义：

- 缺省（未提供）时视为始终接受工作，保持既有单测与独立用法不变。
- 提供时：在处理**每一个**已 claim 的 outbox 行**之前**调用；返回 `false` 则跳过该行（不 `resolve`、不 `invoke`、不 `query`、不 `finishEffect`）。
- 跳过的行保留其 durable lease；之后由租约过期 / 恢复路径重新 claim，不得在关闭路径上盲目补发或伪造终端结果。
- 闸门检查发生在 `processClaimedEffect` 入口之前；已进入 `processClaimedEffect` 的进行中调用允许跑完并持久化终态（与「不开始新的外部工作」一致）。

### 3.2 `runOnce` 行为

```ts
for (const row of claimed) {
  if (this.acceptingWork && !this.acceptingWork()) break;
  results.push(await this.processClaimedEffect(row));
}
```

使用 `break` 而非 `continue`：一旦拒绝接受工作，同批后续行一律不再开始。已 claim 未处理的行依赖 lease 恢复，与 Phase 1 恢复契约一致。

### 3.3 `LifeRuntime` 接线

创建 `EffectDispatcher` 时传入与认知侧相同的关闭门闩：

```ts
const dispatcher = new EffectDispatcher(
  repository,
  registry,
  `life-runtime:${nextId()}`,
  {
    now: () => Date.parse(now()),
    acceptingWork: () => !runtimeGate.closed,
  },
);
```

`close()` 已将 `runtimeGate.closed = true`，并停止 `drainToFixedPoint` 循环。闸门保证：若 `close()` 与进行中的 `dispatcher.runOnce()` 交错，批内后续行不会再开新的外部 dispatch / reconciliation query。

## 4. 明确不做

- 不改 outbox schema、claim SQL 或 lease 时长。
- 不新增真实模型 smoke、生产 Prompt、记忆、Web、消息渠道。
- 不重构 `LifeRuntime` / `EffectDispatcher` 的整体结构。
- 不在关闭时把未处理 claim 强制写成 `failed` / `uncertain`（那会伪造外部世界事实）。

## 5. 验收标准

1. `npm test` 全部通过（含 “does not begin another external dispatch after the runtime starts closing”）。
2. `npm run typecheck` 通过。
3. `npm run build` 通过。
4. `node --enable-source-maps dist/packages/app/src/demo.js` 成功跑通重启回放。
5. 在 `docs/superpowers/plans/2026-07-23-oren-life-kernel.md` 的 Phase 1 Completion Checklist 勾选已满足项；计划文档中的 checkbox 步骤历史可保持原样（它们记录的是实现过程，不是当前验收状态）。

## 6. 风险与回归

- **Lease 堆积：** 关闭瞬间跳过的行会短暂占住 lease；现有 recovery 测试已覆盖过期回收，本收口不新增恢复路径。
- **默认行为：** 未传 `acceptingWork` 时行为与今日完全一致，避免波及其他单测。
- **与认知闸门一致：** 两边都读 `runtimeGate.closed`，避免「认知已拒、Effect 仍发」的分裂窗口。
