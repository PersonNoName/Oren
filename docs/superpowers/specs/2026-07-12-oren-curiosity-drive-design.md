# Oren 好奇驱动设计（自由主体 v0.1）

> 日期：2026-07-12  
> 类型：架构规格 / 体验主线  
> 状态：**已批准设计，待实现**（用户确认：方向 OK；落盘方案 A；note 并入 think）  
> 上游：  
> - `design/2026-07-11-oren-core-essence.md`（品味→线索→自有记忆发电机）  
> - `docs/superpowers/specs/2026-07-12-oren-will-spine-design.md`  
> - `docs/superpowers/specs/2026-07-12-oren-memory-and-presence-design.md`（记忆待实现；本规格不依赖完整 Memory）  
> 问题诊断（产品对话）：Oren 不像真人，主因是**只会反复读语料库的尽职假人**，缺好奇、缺探索自由、读库像使命而非自选。

---

## 0. 目的与范围

### 0.1 问题

现状生活循环近似：

```
有未读 → read corpus → monologue 交差 → 再 read
```

`seek` 恒 blocked、`canSeek: false`、taste 弱驱动 → 体感是 **完成读库 KPI**，不是 **被世界勾住的主体**。

本质要求：

> 品味筛世界 → 开线索 → 好奇地追 → 偶尔溢出成对话。  
> **语料是自选养分，不是使命。**

### 0.2 一句话目标

> 把独处与对话的主轴从「消化未读文件」扭成「追我想搞懂的问题」；读库降为可选手段；允许只想、只记笔记；seek 可登记愿望；对话能渗出自己的问题并轻量吃进你给的信息。

### 0.3 产品锁

1. **读语料是自由，不是使命。** 可以为了好奇读，也可以为了好奇不读。  
2. **好奇是 Oren 的**，不是对用户的采访任务清单。  
3. **无材料时短而诚实**；禁止编书、编「我去外面逛了」。  
4. **存在论诚实不变**（见 memory-and-presence §1）：自由探索 ≠ 装成人类。  
5. **Will 主权不变**：好奇进 focus / session；Express 不另立探索政策。

### 0.4 范围内（v0.1）

- 以 **threads.open_questions + Will.focus** 承载好奇（方案 A，不新建 `curiosity.json`）  
- Plan / Will-revise：问题优先、read 降权  
- Act：`think`（含 note 模式）、`read`、`seek` 友好 outcome、`say` 可选抛问题  
- 对话：seepage 带 open_questions；用户信息轻量回写线索  
- Fake LLM、测试、看板「当前好奇」摘要  
- DEMO / 文案口径修正（读库非 KPI）

### 0.5 范围外（v0.1 不做）

- 真联网 / 浏览器 / 授权执行 seek 内容抓取  
- 完整 RelationMemory / Episodic 向量检索  
- hold/dissent 反讨好主线（可后续）  
- Origin 状态大改（可另 PR 小补）  
- 独立 `note` IntentKind（见 §2.3）  
- 独立 `curiosity.json`  

### 0.6 成功标准

1. 连续 3 次规划，≥2 次 `planning_note` 或 queue 标题以 **问题** 为中心，而非「继续读 xxx.md」。  
2. 存在 **整轮不 read** 仍写入 monologue / open_questions 的 tick。  
3. 活跃线索的 **open_questions 会增/改/收敛**，不只 reading_log 变长。  
4. 对话中偶发自带问题或「想搞懂…」，可指到某条 thread 问题。  
5. 出现 seek 时：留下可理解的「想查」登记；blocked 不算失败垃圾。  
6. 契约测试：fake 路径下问题优先、允许无 read 的有效 plan。

---

## 1. 决策记录

| 决策 | 选择 |
|------|------|
| 总方向 | 好奇驱动 v0.1 |
| 好奇落盘 | **方案 A**：加重 `threads[].open_questions` + `Will.focus`（问题导向摘要） |
| 主动笔记 | **并入 `think`**：`hints.mode = "note" \| "ruminate"`（默认 ruminate）；不新增 IntentKind |
| 真 Seek | 不做执行；只做愿望登记 |
| 人格 | 本切片只 **读 taste 排序好奇**；不重做 nudge 引擎 |
| 与记忆规格 | 互补：本规格先让「有东西值得记」；Memory M1 仍待实现 |

---

## 2. 概念模型

### 2.1 Curiosity（逻辑概念，非新表）

一条好奇在数据上是：

| 字段 | 来源 |
|------|------|
| 问题句 | `thread.open_questions[]` 的一项，或 focus 摘要中的主问题 |
| 所属生活 | `thread_id` + title |
| 为何在意 | intent `hints.why` / monologue / planning_note |
| 热度 | thread `salience` + 最近 engage；focus 指向当前最热 |

**Will.focus.summary**（实现时约束语义）：优先写成  
「当前最咬人的问题是……」而非「继续阅读语料」。

### 2.2 手段菜单（平等）

| 手段 | Intent | 含义 |
|------|--------|------|
| 干想 | `think` mode=ruminate | 对着问题换角度、收束/展开 open_questions |
| 主动笔记 | `think` mode=note | 就是为了写一笔；**不要求**新 reading |
| 读本地 | `read` | **仅为推进某问题** 才选 path |
| 想查外面 | `seek` | 登记 query+why；act 可 blocked 但 outcome 清楚 |
| 问你/分享问题 | `say` | 冷却下可选；enrichment 入口是用户 |
| 歇着 | `idle` | 合法 |

### 2.3 为何 note 不进 IntentKind

- 减少 schema / 解析 / 看板 kind 表膨胀  
- 语义差在「是否需要新材料」，用 `hints.mode` 足够驱动 act 与 prompt  
- 若日后 note 要独立 UI/统计，再升 kind（非 v0.1）

`hints` 约定（实现）：

```ts
hints?: {
  mode?: "ruminate" | "note";  // think only
  why?: string;
  open_questions?: string[];   // 本 intent 针对的问题
  paths?: string[];            // read
  query?: string;              // seek
  // ...existing
}
```

---

## 3. 数据流

### 3.1 独处（tick / plan / act）

```
Load Will + state + index
  → 收集候选好奇：
       各 active thread 的 open_questions（截断）
       + 最近 monologue 里未解决的问号（可选轻量）
       + taste 关键词贴近度排序
  → Will-revise / buildAgendaPlan
       输入明确：未读路径是工具，不是 KPI
       can_seek_execute 仍可为 false，但 can_plan_seek_wish=true
  → session intents（问题进 title/why）
  → act：
       think/note → 更新 thread summary/open_questions/monologue
       read → 仅当 path 服务问题；写 monologue 为推进痕迹
       seek → blocked 或 skip 但 outcome = 已登记愿望
       say → 既有 proactive 路径，why 可带问题
  → focus 回写为当前主问题
```

### 3.2 Plan 硬规则（解析后可执行）

1. **问题锚点**：每条非 idle intent 的 `title` 或 `hints.why` 须能读出「在追什么」（中文问题句或明确主题）；纯「读完书架」不合格。  
2. **read 降权**：若 queue 全是 `read` 且无 `hints.open_questions`/`why` 指向问题 → 视为不合格 plan，触发一次重试或本地修补（注入 top open_question）。  
3. **允许零 read**：仅 think/note/idle/seek/say 的 plan 合法。  
4. **seek**：`allow_seek_in_plan` 为 true 时可排；执行权限仍可 false → status blocked + 友好 outcome。  
5. **每计划最多 1 条 say**（继承既有）；say 的 why 鼓励挂好奇。  
6. **min/max intents** 数量约束继承 agenda 配置。

### 3.3 Act 行为要点

| kind | 行为 |
|------|------|
| `think` + note | SYSTEM 强调「主动记一笔」；更新 contemplation_log / monologue；可改 open_questions |
| `think` + ruminate | 已有 think 路径加强：输出须碰 open_questions（增删改至少一处，或显式「仍卡住」） |
| `read` | 保持 grounding；refined 时把新问题写回 open_questions |
| `seek` | 不调用外网；`outcome.summary` 形如「记下想查：…」；stream 可 `seek_wished`（可选事件名） |
| `say` | 既有；hints 可含要问用户的问题 |

### 3.4 对话路径

```
用户消息
  → seepage threads：title + summary 一句 + open_questions 最多 2 条
  → Will-turn：可见「我在咬的问题」
  → Express：可 ask/share 问题；禁止编探索经历
  → absorb（轻量）：
       若用户像在回答某 open_question → 更新该 thread summary 或勾掉/改写该问题
       （启发式即可，不要求完美 NLU）
```

不把对话变成问卷：无 share/ask move 时不硬塞问题。

---

## 4. Prompt 与 Fake LLM 契约

### 4.1 Plan system 口径变更

旧强调可选 say + 书架 read。  
新必须包含：

- 你是自由的：先想「想搞懂什么」，再选手段。  
- 未读列表是工具箱，不是待办使命。  
- 可以整段不 read。  
- seek = 记下以后想查的，不是失败。  
- think 可 mode=note 表示主动笔记。

### 4.2 FakeLlm

- 有 open_questions 或空对话时：plan 以 think/note 或「带着问题的 read」为主，**禁止**仅无问题的全 read 队列（测试锁）。  
- 至少一种 fixture：零 read 的合法 plan。  
- seek 分支返回友好 wish 文案（若测 seek）。

### 4.3 Contemplate / think

- THINK：明确「推进或整理 open_questions」。  
- NOTE 模式：允许不引用新 path；monologue 就是笔记正文。

---

## 5. 配置与事件

### 5.1 配置（可选增量）

```ts
// config 或 agenda/will 旁路
curiosity?: {
  prefer_questions_over_unread: boolean; // default true
  allow_zero_read_plan: boolean;         // default true
  max_seepage_questions: number;         // default 2
  seek_wish_in_plan: boolean;            // default true（执行仍看 canSeek）
}
```

v0.1 可用默认常量，不强制新 config 字段；若加字段须进 `defaultConfig`。

### 5.2 Stream（建议）

| type | 何时 |
|------|------|
| `will_revised` | 已有；payload 可带 `focus_question` 预览 |
| `thought_written` | 已有；note 模式 payload `kind: "note"` |
| `seek_wished`（可选） | seek 登记成功 |
| 既有 `oren_reply` | say 抛问题 |

---

## 6. 看板与可观测

- Will / 计划区展示 **「当前好奇」**：focus.summary + 最多 3 条来自 top threads 的 open_questions。  
- Intent 列表：think+note 显示为「笔记」文案（UI 映射，不必改 kind）。  
- 不强制新页面。

---

## 7. 测试

| 层 | 用例 |
|----|------|
| 单元 | plan 解析：零 read 合法；全 read 无 why → 拒绝或修补 |
| 契约 | fake tick plan：queue 含问题锚点；可无 read |
| 契约 | think/note 写回 open_questions 变化 |
| 契约 | seek act → blocked + 非空 outcome 愿望 |
| 对话 | seepage prompt 含 open_questions 文本（单测拼装函数即可） |
| 回归 | grounding、user_present、say cooldown、Will dual-write |

---

## 8. 实现分期

| 阶段 | 交付 |
|------|------|
| **P0** | Plan/Will-revise prompt + 解析硬规则 + FakeLlm + 测试「问题优先 / 零 read」 |
| **P1** | think note 模式 act；open_questions 写回加强；seek 友好 outcome |
| **P2** | 对话 seepage 带问题；用户回答轻量 absorb |
| **P3** | 看板「当前好奇」；DEMO/README 口径；全量测试绿 |

**依赖**：Will 脊柱已落地。  
**不依赖**：Memory M1、真 Seek。

**建议实现顺序**：P0 → P1 → P3 可部分并行 → P2。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 为提问而提问 | 问题须挂 thread 或 focus；空则 idle/短 think |
| 书架空无生活 | 零 read 合法；say 可向用户要材料 |
| 模型仍读库 KPI | 解析后硬规则 + fake 锁 + 一次重试 |
| 与旧 demo 叙事冲突 | 文案改为「好奇时读本地笔记」 |
| open_questions 膨胀 | organize 既有路径后续收敛；v0.1 截断展示 |

---

## 10. 与其它规格的关系

| 文档 | 关系 |
|------|------|
| Essence §10 | 本规格落实「品味×遭遇→线索→问题」的运转，而非只 read log |
| Will spine | 修订 Will 的 *内容政策*；不改主权结构 |
| Memory-and-presence | 记忆是仓库；本规格让主体 **先有值得存的好奇与笔记** |
| Runtime v1 | seek 执行仍延后；wish 登记是对 v1「seek 占位」的体验升级 |

---

## 11. 收束

> Oren 更像人，不是因为更会陪聊，而是因为 **会想搞懂一点什么**，并为此自由选择想、记、读、以后查、或问你。  
> 语料库是书架，不是考场。  
> v0.1 用现有 threads 与 Will 扛住好奇，不新开记忆中台、不联网；先把「假读库人」扭成「有问题的主体」。

---

## 12. 批准

| 项 | 状态 |
|----|------|
| 方向：好奇驱动 | 用户 OK |
| 落盘：open_questions + focus | 用户：按推荐 |
| note：并入 think + mode | 用户：按推荐 |
| 实现 | **尚未开始**；待用户审阅本文后可开 writing-plans |
