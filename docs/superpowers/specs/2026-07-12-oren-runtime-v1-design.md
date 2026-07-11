# Oren Runtime v1 技术设计

> 日期：2026-07-12  
> 类型：技术设计 / 最小可活体（D 切片）  
> 状态：待用户审阅  
> 上游概念：  
> - `design/2026-07-11-oren-core-essence.md`  
> - `discussion/2026-07-10-oren-agent-design.md`

## 0. 目的与成功路线

本文把 Oren 的产品本质收敛为**可实现的 v1 技术架构**。v1 不追求「感觉有灵魂」，而追求**机制上可审计的持续在场**。

成功路线（已确认）：

1. **D — 最小可活体**：体验循环 + 自有记忆 + 品味 stub + 本地语料，端到端可跑  
2. **B — 机制可演示**：多 tick 无人值守，线索与 stream 可解释增长  
3. **A — 现象学成功**：长期使用中用户感到持续存在（v1 之后）

v1 交付以 **D** 为准，架构必须能自然长到 **B**。

---

## 1. 关键决策摘要

| 决策 | 选择 | 理由 |
|------|------|------|
| 与 Pi 的关系 | **参考架构 + 依赖 `pi-ai`；不 fork/修改 Pi monorepo** | Pi 是回合制 coding harness；Oren 是生命调度。混为一体会造成状态与语义污染 |
| 产品壳 | **无 UI runtime** | 先证明「不被观察也在过」 |
| 外部输入 | **本地语料库** `data/corpus`（md/txt） | 可控、可复现；`InputSource` 接口便于日后换 RSS |
| 语言栈 | **TypeScript + `@earendil-works/pi-ai`** | 复用成熟 LLM 流式/多厂商层 |
| 持久化 | **本地目录 JSON / JSONL** | 无 UI 时文件即审计界面 |
| 心跳 | **`oren tick` 单次一轮后退出** | tick = durable boundary；cron/launchd 调度 |
| 内部架构 | **阶段流水线（方案 2）** | 确定性阶段可测；LLM 只做沉思/可选整理 |
| 事件日志 | **`stream.jsonl` append-only** | 预留 becoming 史，不做完整 CQRS |

### 1.1 与 Pi 的边界

```
允许：
  @earendil-works/pi-ai

不允许（v1）：
  依赖 pi-coding-agent
  修改本地 pi 源码
  用 Pi session/transcript 作为生命状态主键
```

关系模型：

```
Oren TickEngine  ──沉思/整理时──►  pi-ai (single completion)
       │
       └── 状态 ──►  data/life/*.json(l)
```

Pi = 回合执行所需的 LLM 神经系统零件。  
OrenRuntime = 心脏与主观时间（生命调度）。

---

## 2. 逻辑包边界

物理目录 v1 可扁平，但逻辑必须可分：

| 逻辑单元 | 职责 |
|----------|------|
| CLI | `oren init` / `oren tick` / `oren status` |
| TickEngine | 编排流水线、模式分支、锁 |
| LifeStore | 读写 `data/life`、原子写、stream append |
| CorpusIndex / CorpusRetriever | 扫描语料、规则打分取段 |
| ContemplationService | 组 prompt、调 LLM、解析 ThoughtArtifact |
| OrganizeService | 规则整理（LLM 可选，默认关） |
| LlmCompleter | 对 pi-ai 的薄封装；测试可 fake |

---

## 3. 目录与状态模型

### 3.1 数据根

默认相对于 `OREN_HOME`（默认 `.`）：

```
data/
├── corpus/                    # 主食：只读输入（用户投放）
│   ├── README.md
│   └── ...                    # .md / .txt
│
└── life/                      # 自我：读写
    ├── meta.json
    ├── config.json            # 运行配置；init 生成（唯一权威路径）
    ├── taste.json
    ├── affect.json
    ├── threads/
    │   └── <thread-id>.json
    ├── index/
    │   └── corpus-index.json
    ├── stream.jsonl
    ├── ticks/
    │   └── <tick-id>.json
    └── .lock
```

原则：

- **corpus 只读**；Oren 永不改写 corpus  
- **当前真相** = 各 JSON 文件  
- **成为史** = `stream.jsonl` + `ticks/*`  
- 人无需 DB 即可审计

### 3.2 Schema 意图

**meta.json**

- `oren_id`, `schema_version`, `created_at`, `last_tick_at`, `tick_count`

**taste.json**（内在性 = 品味，非兴趣清单）

- `values: [{ id, statement, weight }]`  
- `aesthetics: [{ id, statement, weight }]`  
- `notes?: string`  
- `updated_at`

**threads/\<id\>.json**（自有记忆 = 进行中的线索）

- `id`, `title`  
- `status: active | dormant | archived`  
- `opened_at`, `last_engaged_at`  
- `sources: [{ path, chunk_id? }]`  
- `summary`, `open_questions: string[]`  
- `reading_log`, `contemplation_log`  
- `links: { forked_from?, related: [] }`  
- `salience: 0-1`

**affect.json**（v1 极简占位）

- `mode_bias`  
- `absence: { last_user_contact_at?: null }`  
- `updated_at`  

v1 **不实现**伤口/愈合动力学。

**stream.jsonl**

每行：`{ ts, tick_id, type, payload }`。  
已知 `type` 见 §7.3；未知 type 读取时忽略。

**ticks/\<tick-id\>.json**

单次 tick 审计：perception 摘要、reading_plan、raw/parsed artifact、applied_patch、结果状态。

### 3.3 与本质文档映射

| 本质（Tier 0） | v1 落点 |
|----------------|---------|
| 体验循环 | Tick 流水线 |
| 工作记忆 | 单 tick 内存 Perception |
| 自有记忆 | `threads/*` |
| 内在性 / 品味 | `taste.json` |
| 沉思 | contemplate + ThoughtArtifact |
| 自选外部输入 | `data/corpus` + retriever |
| 用户记忆 / 主动联系 | **不做** |
| 伤口 / 核心渗透 | **不做**（affect 占位） |

---

## 4. Tick 流水线与模式

### 4.1 定义

一次 `oren tick`：进程内完整执行「感知 → 选模式 → 行动 → 整合 → 落盘」后退出。  
落盘成功 = 本 tick 的 **durable boundary**。中途崩溃则下次从上次成功状态继续。

### 4.2 阶段顺序

```
0. Bootstrap   解析 OREN_HOME，校验 schema_version
1. Load        读 meta / taste / affect / threads / stream 尾
2. Perceive    确定性：gap、语料变更、线索显著性、open_questions
3. ChooseMode  规则为主；支持 --force-mode
4. Act         按 mode 分支；仅 organize/contemplate 可调 LLM
5. Integrate   校验并应用 TickPatch；软遗忘；taste 限幅
6. Persist     JSON 原子写 → stream append → tick 快照 → 更新 meta
7. Report      stdout 摘要 + exit code
```

硬规则：

1. Load～ChooseMode、Integrate～Persist **默认不调 LLM**  
2. Act 产出 **TickPatch**，不直接改文件；仅 Integrate+Persist 写盘  
3. Persist 使用 tmp + rename；`tick_finished` 仅在状态写成功后 append  
4. 失败：不推进 `last_tick_at` / `tick_count`（可写 `tick_failed`），exit ≠ 0  
5. **`data/life/.lock`**：并发第二实例 exit 2

### 4.3 三种清醒模式

| 模式 | 行为 | LLM |
|------|------|-----|
| `idle` | 记录空白在场与 gap；可选轻微 salience 衰减 | 否 |
| `organize` | 合并/休眠/整理 open_questions；默认纯规则 | 可选，默认关 |
| `contemplate` | 检索语料 → pi-ai 沉思 → 更新线索 | 是（单次 completion） |

v1 **无**对用户的行动溢出。

### 4.4 ChooseMode 启发式（可配置）

输入：`gap_ms`、距上次 contemplate 次数、active 线索、corpus 是否有变更、`recent_modes`。

默认倾向：

- 沉思是主旋律  
- 必须能进入 idle（避免恒定轰鸣）  
- 线索膨胀时 organize  
- 连续 contemplate ≥ N 且无新料 → idle 或 organize  
- **选模式不调 LLM**

### 4.5 TickPatch（契约）

```
TickPatch = {
  mode, reason,
  thoughts?: [{ content, thread_id?, source_refs? }],
  thread_ops?: [
    { op: "create", ... } | { op: "update", id, fields } | { op: "dormant", id }
  ],
  taste_ops?: [{ op: "nudge", ... }],   // 默认 config 可关闭应用
  affect_ops?: [],
  stream_events: [...]
}
```

Integrate 拒绝非法 op；限制单 tick 对 taste 的最大改动；active 线索数设上限（建议 20），超额强制 dormant/organize。

### 4.6 时间（v1 工程含义）

- 记录 `gap_ms` 与 `last_tick_at`  
- idle 也写在场事件（证明 gap 被度过）  
- `felt_intensity` 与模式密度用于日后记忆疏密；v1 只记录不解释

---

## 5. 语料、沉思与 ThoughtArtifact

### 5.1 索引

`CorpusIndex` 扫描 `data/corpus`：path、hash、mtime、preview；大文件按标题/空行确定性切 chunk。  
v1 **不做** embedding。

### 5.2 检索（确定性）

优先级：

1. **延续**：高 salience + open_questions 的线索 → 其 sources 邻近/未读 chunk  
2. **品味过滤**：preview 与 values/aesthetics 词面重叠打分  
3. **探索配额**：每 N 次 contemplate 强制一篇低相关新/changed chunk  
4. **预算**：`max_chunks`（默认 1–2）、`max_chars`（默认约 6000）

输出 `ReadingPlan`：items（含 `score`、`reason`）、可选 `thread_id`。

`reason` 示例：`continue-thread:<id>` / `taste-match` / `explore` — 必须进 stream/tick 审计。

开线规则（调 LLM 前）：

- 有 thread_id 且 active → continue  
- 与所有线索弱相关 → create  
- v1 **不自动 merge**；最多 `related` 弱链

### 5.3 pi-ai 调用

```
interface LlmCompleter {
  complete(prompt: string): Promise<string>
}
```

- 生产：`@earendil-works/pi-ai` 单次 completion（可用 stream 收集全文）  
- **无** tool-call agent loop  
- 超时/空响应/provider 错误 → tick 失败（不静默假沉思）  
- JSON 解析失败：允许 **1 次**重试，仍失败则 `tick_failed`

### 5.4 Prompt 原则

System 固定强调：

- Oren 是独立主体，本次是精神生活，不是服务用户  
- 禁止助手腔与对用户问候  
- 必须输出指定 JSON

动态注入：taste 摘要、当前线索、ReadingPlan 正文。  
不注入：用户画像、全量 threads、完整 stream。

### 5.5 ThoughtArtifact

```
{
  monologue: string,
  refined_summary?: string,
  open_questions?: string[],
  suggest_new_thread?: { title, seed_question },
  taste_nudges?: [{ dimension: "value" | "aesthetic", statement, reason }],
  felt_intensity?: number  // 0-1
}
```

Integrate 要求：`refined_summary` 与 `open_questions` **至少一个**实质非空，否则拒绝该沉思（防空转）。  
`taste_nudges`：v1 默认 `apply_nudges: false`。

---

## 6. v1 范围、配置与 CLI

### 6.1 明确不做

- 用户对话通道（chat/HTTP）  
- 用户四条记忆流、主动联系、对话景观  
- 伤口/愈合/依恋改写品味的完整动力学  
- 常驻 daemon、向量库、云同步、多用户  
- 修改 Pi monorepo、依赖 coding-agent  
- 完整线索自动分叉/融合、完整 event-sourcing 投影

### 6.2 配置（示意）

```json
{
  "corpus_dir": "data/corpus",
  "life_dir": "data/life",
  "model": "anthropic:claude-sonnet-4-20250514",
  "contemplate": {
    "max_chunks": 2,
    "max_chars": 6000,
    "explore_every_n": 5
  },
  "mode": {
    "idle_probability": 0.15,
    "max_consecutive_contemplate": 4
  },
  "taste": {
    "apply_nudges": false,
    "max_nudges_per_tick": 1
  },
  "organize": {
    "use_llm": false
  }
}
```

环境变量：`OREN_HOME`、`OREN_MODEL`、各厂商 API key（不入库）、`OREN_LOG_LEVEL`。

### 6.3 CLI

| 命令 | 行为 |
|------|------|
| `oren init` | 建目录、种子 taste、config、corpus README |
| `oren tick` | 完整流水线 |
| `oren tick --force-mode <mode>` | 调试 |
| `oren status` | last_tick、模式统计、活跃线索、最近 stream |

### 6.4 退出码

| Code | 含义 |
|------|------|
| 0 | 成功落盘 |
| 1 | 通用失败 |
| 2 | 锁冲突 |
| 3 | 未 init / schema 不匹配 |
| 4 | 保留 |

**空 corpus 且本应 contemplate：** 降级为 idle，stream 记警告（避免 cron 刷失败），不使用 exit 4 作为主路径。

### 6.5 演进接口（实现时留下）

- `InputSource`（LocalCorpus 唯一实现）  
- `LifeStore`（FsJsonLifeStore）  
- `schema_version` 于 meta 与 artifact  
- stream `type` 开放联合

---

## 7. 验收与测试

### 7.1 D — 最小可活体 DoD

| # | 标准 |
|---|------|
| D1 | `oren init` 后目录符合 §3 |
| D2 | corpus ≥1 篇后 `tick --force-mode contemplate` exit 0 |
| D3 | stream 含 `thought_written` |
| D4 | 至少一条 thread 被 create/update，summary 或 open_questions 非空 |
| D5 | tick 快照含 reading_plan.reason 与 applied_patch |
| D6 | idle 不成功依赖 LLM，仍写 presence 类事件 |
| D7 | 锁冲突 exit 2 |
| D8 | corpus 内容 hash 不变 |

### 7.2 B — 机制可演示（D 之后）

连续多 tick（如 20 次）期望：

- 模式不全是同一种  
- 同一 thread 可被多次 engage  
- 低活跃线索可 dormant  
- 多篇 corpus 时出现 `explore` reason  
- 人工间隔后 `gap_ms > 0`  
- kill -9 后状态仍合法、可继续

### 7.3 stream 最小事件集

`tick_started` · `mode_chosen` · `corpus_read` · `thought_written` · `thread_created` / `thread_updated` · `presence_blank` · `tick_finished` / `tick_failed`

### 7.4 测试分层

| 层 | 内容 | CI |
|----|------|-----|
| 单元 | index、retriever、ChooseMode、Integrate、lock、parse | 默认，无 key |
| 契约 | fixture corpus + fake LLM 金样结构 | 默认 |
| 集成 | 真 pi-ai 一次 contemplate | 仅 `OREN_LIVE_LLM=1` |

所有 LLM 调用经 `LlmCompleter` 注入。

### 7.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| 非 JSON 输出 | 1 次重试 + 失败 tick |
| 空转 monologue | Integrate 要求 summary/questions |
| 线索爆炸 | active 上限 + organize/dormant |
| 费用 | idle 比例 + 用户控制 cron 频率 |
| 助手腔 | system 禁令 + 抽查 |
| 隐私 | corpus 本机；仅 LLM API 出网 |

---

## 8. 建议实现顺序

1. LifeStore + lock + `oren init`  
2. CorpusIndex + Retriever（fixture 单测）  
3. TickEngine 骨架 + idle 全链路  
4. Fake LLM contemplate + Integrate  
5. 接 pi-ai  
6. ChooseMode + 规则 organize  
7. `oren status` + cron/launchd 文档  

（实现计划在 design 批准后由 writing-plans 展开，本文不代替任务分解。）

---

## 9. 开放问题（刻意留到实现或 v2）

以下不影响 v1 开工，但实现中若被迫选择，应写回 ADR：

1. tick 快照是否外置超大 `raw_model_text` 侧车文件  
2. `schema_version` 迁移策略（v1 可拒绝不匹配并要求 reinint）  
3. monologue 语言：严格跟随 corpus 还是 config.locale  
4. 从 tick CLI 升常驻 daemon 时的调度复用方式  

---

## 10. 文档关系

| 文档 | 角色 |
|------|------|
| `discussion/2026-07-10-oren-agent-design.md` | 早期全景设计空间（部分已被本质文档推翻） |
| `design/2026-07-11-oren-core-essence.md` | 概念本质与分层（权威产品语义） |
| **本文** | v1 技术架构与范围；实现与验收的依据 |

本质冲突时：**概念以 essence 为准，工程以本文 v1 砍掉范围为准**（先机制后现象学）。

---

## 11. 批准记录

| 节 | 内容 | 讨论结论 |
|----|------|----------|
| 架构取向 | 方案 2 流水线 | 已确认 |
| §1 状态模型 | 目录与 schema | 已确认 |
| §2 流水线 | 模式与 TickPatch | 已确认 |
| §3 沉思 | 语料/pi-ai/Artifact | 已确认 |
| §4 边界 | 配置与 CLI | 已确认（继续） |
| §5 验收 | DoD 与测试 | 已确认 |

**书面 spec 审阅：** 待用户阅读本文件后确认，方可进入 implementation plan。
