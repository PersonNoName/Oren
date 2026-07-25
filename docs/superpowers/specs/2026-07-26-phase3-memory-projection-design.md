# Phase 3 设计：记忆投影

> 日期：2026-07-26
> 类型：阶段设计（spec）
> 状态：已确认
> 上游：`docs/superpowers/specs/2026-07-26-oren-roadmap-design.md` §4、`design/2026-07-22-oren-implementation-spine.md` §9、§12、概念设计 §8.2
> 基线：Phase 2 真实认知已完成（`main`，离线测试全绿）
> 分支：`feat/phase3-memory-projection`

---

## 1. 目标与边界

为闭环补上**跨时间的连续理解**：从核心事件史建立可召回的记忆投影，让模型能在 episode 内召回过往判断与线索脉络，并通过 `Remember` / `ReviseBelief` / `Forget` 主动经营自己的记忆。

**范围内**：

1. 记忆条目模型与从核心事件的自动投影；
2. 内核新增 `Remember` / `ReviseBelief` / `Forget` 三个 Proposal 及对应核心事件；
3. `packages/memory` 新包：`MemoryPort` 接口 + SQLite 实现 + 可替换 `EmbeddingPort`；
4. `memory.recall` 即时能力（episode 内返回结果）；
5. 记忆钉自动注入 `LifeFrame`，prompts 增加记忆纪律；
6. 离线测试、smoke 扩展与 2–3 个记忆行为评估场景。

**范围外**：

Web 阅读与来源（Phase 4）、消息渠道与面板（Phase 5）、记忆摘要压缩与遗忘策略调优、跨 Oren 记忆共享、用户隐私删除流程（保留接口语义：走明确的数据删除流程，不经 `Forget`）。

## 2. 核心决策（已与用户确认）

| 决策点 | 选择 |
|--------|------|
| 读写接入方式 | 混合：读 = `memory.recall` 即时能力（episode 内工具调用）；写 = 核心 Proposal → 核心事件 → 投影更新 |
| 自动投影来源 | 保守：`UserMessageReceived`、`ExpressToUser`、`ThreadAdvanced`，其余靠显式 `Remember` |
| 检索机制 | 向量检索为主（EmbeddingPort 可替换、凭据门控），无凭据时自动降级为结构化检索 |
| 进入 LifeFrame 的方式 | 自动记忆钉（每次唤醒 ≤5 条）+ 模型主动 `memory.recall` |
| 落位 | 方案 A：新建 `packages/memory` 包定义 `MemoryPort`；kernel 只加 3 个 Proposal + 3 个事件，保持零依赖 |

## 3. 记忆条目模型

```text
MemoryEntry {
  memoryId          // 稳定 ID；自动投影时从来源事件派生（可重建一致），显式 Remember 时取事件内生成的 ID
  orenId
  kind              // user_statement | external_fact | oren_judgment | oren_expression
  text              // 记忆正文
  sourceEventId     // 可追溯到核心事件
  occurredAt        // 来源事件时间
  confidence        // 0–1；oren_judgment 必填，其余可空
  reviewCondition   // 复查条件，可空（如「等用户下次提到工作再确认」）
  threadId          // 关联线索，可空
  recallability     // active | lowered
}
```

语义约定：

- `user_statement`：用户说过的话（是「用户这么说过」的事实，不代表内容为真）；
- `external_fact`：带来源的外部事实（Phase 3 只能经显式 `Remember` 产生；Phase 4 的 Web 观察将接入此类型）；
- `oren_judgment`：Oren 的推测与判断，必须带 `confidence`，观点不得伪装成事实；
- `oren_expression`：Oren 对用户表达过的内容（用于「我说过什么」的自我一致性）；
- `Forget` 只把 `recallability` 降为 `lowered`：默认不出现在召回与记忆钉中，除非查询显式要求包含；生命史与索引行都不删除。

## 4. 内核协议扩展

kernel 保持零依赖，只扩协议与校验：

**新增 Proposal（`packages/kernel/src/protocol.ts`）**：

```text
Remember     { text, kind, confidence?, reviewCondition?, threadId? }
ReviseBelief { memoryId, revisedText?, confidence, reason }
Forget       { memoryId, reason }
```

**新增核心事件**：

```text
MemoryRemembered { memoryId, kind, text, confidence?, reviewCondition?, threadId? }
BeliefRevised    { memoryId, revisedText?, confidence, reason }
MemoryForgotten  { memoryId, reason }
```

**Guard 校验**：`text` 非空且有长度上限；`kind` 合法；`confidence` 在 [0,1]；`oren_judgment` 必带 `confidence`；`ReviseBelief` / `Forget` 必带非空 `reason`。校验失败按既有 Proposal 拒绝路径处理。

kernel 零依赖，Guard 不查记忆索引：`ReviseBelief` / `Forget` 引用的 `memoryId` 是否存在由投影层处理——引用未知 `memoryId` 时事件照常入史，投影侧记为无效引用并跳过（不抛错、不中断投影），召回行为不受影响。

**Reducer**：三类事件只入生命史，不改变 `LifeState`（记忆是投影不是核心状态，`LifeState` 体积上限不动）。`memoryId` 由 LifeActor 在接受 Proposal 时生成并写入事件，保证重放一致。

## 5. packages/memory 新包

### 5.1 MemoryPort

```text
MemoryPort {
  project(envelopes)   // 消费核心事件，增量更新索引（含 revise / forget）
  recall(query)        // { text?, kinds?, threadId?, since?, until?, limit, includeLowered? } → 排序后的 MemoryEntry[]
  rebuild(allEvents)   // 清空索引后从完整事件史重建；结果与增量投影一致
}
```

### 5.2 SQLite 实现

- 与生命库**同一数据库文件**、独立表：`memory_entries`、`memory_vectors`、`memory_projection_cursor`（记录已投影到的事件 sequence）；
- 自动投影映射：
  - `UserMessageReceived` → `user_statement`；
  - `CognitionCompleted` 中的 `ExpressToUser` proposal → `oren_expression`；
  - `ThreadAdvanced` → `oren_judgment`（默认低置信度，标注为「线索推进摘要」）；
  - `MemoryRemembered` / `BeliefRevised` / `MemoryForgotten` → 显式写入 / 修订 / 降低可召回性；
- 自动投影的 `memoryId` 从来源事件 ID 确定性派生，保证 `rebuild` 与增量投影产出一致；
- 索引不是权威数据：任何时刻可从 `events` 表 + 内容重建，最坏情况是「暂时不善回忆」。

### 5.3 EmbeddingPort 与检索

```text
EmbeddingPort { embed(texts) → number[][] }
```

- **真实适配器**：走 OpenAI 兼容 embeddings 端点；配置沿用 Phase 2 model-config 模式：`OREN_EMBEDDING_PROVIDER` / `OREN_EMBEDDING_MODEL` + 供应商 API key 环境变量；未配置凭据即视为不可用，不发起网络请求；
- **假 embedder**：确定性（基于文本内容的哈希向量），供离线测试覆盖向量路径；
- **检索**：先按结构化条件过滤（kind / threadId / 时间范围 / recallability），候选集内计算余弦相似度（首版在 JS 内计算，不引入 sqlite-vec 等原生依赖），叠加时间衰减排序；
- **降级**：embedder 不可用时，`recall` 自动降级为结构化检索（过滤 + 关键词子串匹配 + 时近排序），接口与返回形状不变，调用方无感知；
- 向量在写入/投影时计算并存储；embedder 不可用期间投影照常进行（只缺向量），凭据配置后可通过 `rebuild` 补齐向量。

## 6. 运行时与认知接入

- `LifeRuntime` 创建并持有 memory 实例；每轮 drain 结束后按 `memory_projection_cursor` 增量投影新事件；启动时先补投影（崩溃恢复自动追平）；
- `memory.recall` 以内置扩展能力暴露：traits 为 `read_only` + `replay_safe`，走 immediate 通道，episode 内直接返回结果；输入 schema 对应 `recall(query)`；
- **记忆钉**：构建 `LifeFrame` 前，用触发摘要作为查询检索 ≤5 条高相关记忆，注入新增字段 `LifeFrame.memoryPins`（含 memoryId / kind / text / confidence / occurredAt）；
- **prompts 更新**（`packages/pi-cognition/src/prompts.ts`）：渲染记忆钉；新增记忆纪律——区分事实与判断（judgment 必带置信度）、修订与遗忘需引用 `memoryId` 并说明理由、`Forget` 只是降低可召回性不是删除、何时值得 `Remember`（有跨时间价值的判断与承诺，不是逐句复读）。

## 7. 测试与验收

**离线测试（假 embedder，全部进 `npm test`）**：

1. 自动投影：三类来源事件正确产出条目；
2. 显式写入：`Remember` / `ReviseBelief` / `Forget` 经 Proposal → 事件 → 投影全链路生效；
3. 召回：排序确定性；kind / thread / 时间过滤；`lowered` 默认排除、`includeLowered` 可见；
4. 降级：无 embedder 时结构化检索可用且返回形状一致；
5. 重建：`rebuild` 结果与增量投影完全一致（对应路线图验收「索引重建结果一致」）;
6. 重启：新进程从同一数据库启动后 `recall` 能召回重启前的判断（对应「重启后能召回过往判断与线索脉络」）；
7. Guard：非法 Proposal（confidence 越界、text 为空等）被拒绝。

**smoke 扩展（凭据门控，手动路径）**：真实模型跑「记住一个判断 → 重启 → 召回它并在表达中引用」。

**评估场景（`packages/evals`，新增 2–3 个）**：会在需要历史背景时主动 `memory.recall`；`Remember` 判断时带置信度、不把观点伪装成事实；对已失效判断使用 `ReviseBelief` 而非直接矛盾表达。

**跨阶段门槛不变**：`npm test` / `typecheck` / `build` 全绿且完全离线；真实 embedding 与真实模型均为凭据门控的手动路径。

## 8. 涉及包与文件（预期）

| 位置 | 变更 |
|------|------|
| `packages/kernel` | protocol / guard / life-actor / runtime-validation：3 Proposal + 3 事件 + 校验 |
| `packages/memory`（新） | MemoryPort、SQLite 索引、EmbeddingPort、假/真 embedder、检索与降级 |
| `packages/cognition` | `LifeFrame.memoryPins` 字段与 frame 构建输入 |
| `packages/pi-cognition` | prompts 渲染记忆钉与记忆纪律；proposal-schema 增加新 Proposal |
| `packages/app` | LifeRuntime 接入投影游标与记忆钉；`memory.recall` 内置能力注册；smoke 扩展 |
| `packages/evals` | 新增记忆行为场景 |
| `scripts/prepare-dist.mjs` | 增加 `memory` 包符号链接 |
