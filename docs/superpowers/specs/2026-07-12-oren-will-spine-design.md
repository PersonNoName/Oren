# Oren Will 脊柱设计（方案 2）

> 日期：2026-07-12  
> 类型：架构规格 / 主体性收束  
> 状态：已批准（brainstorming 对话确认）  
> 上游：  
> - `design/2026-07-11-oren-core-essence.md`  
> - `docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`  
> - 现状：agenda plan/act、dialogue reply（stance/share 当场决策）

## 0. 目的与范围

### 0.1 问题

Oren 的本质是**持续在场的独立主体**；陪伴与行动是溢出。当前实现已有半截意志层（`agenda`），但**意图主权被拆成多张嘴**：

| 能力 | 今日决策中心 |
|------|----------------|
| 独处读/想/整理 | agenda |
| 主动 `say` | agenda |
| 对话追问、换题、stance、share | `reply` 当场 LLM |
| 冷热调制 | relation + prompt |

用户体感接近「会聊天的人 + 后台日程」，而非「一个人先有打算，说话是打算的外溢」。

### 0.2 目标

1. **单一意图主权：Will**（持续落盘状态，不是 system prompt 本身）。  
2. **对话收束**：追问、换题、分享、主动开口均可在 Will / turn moves 上解释。  
3. **中核本人**：Will + threads + taste + 体验循环；渠道与未来 tool 为扩展。  
4. **干活 / tool 第二**：本规格只留扩展挂点，不实现多步 tool runtime。

### 0.3 范围内

- Will 模型、存储、读写与审计事件  
- 独处路径：Will 修订 + session queue 执行（承接 agenda）  
- 对话路径：Will-turn → Express 两段；express 不得另立政策  
- 迁移、配置、测试、实现分期  

### 0.4 范围外

- Tool 多步 agent loop、Pi monorepo 集成  
- 伤口/愈合/依恋改写品味  
- 多用户、云同步、完整对话景观图  
- 用户四条记忆流全量实现  

### 0.5 成功标准

- 任意一次换题 / 追问 / 主动 share / 主动 say，stream 或 Will 快照可见对应意图，而不仅是最终文案。  
- 独处与对话读写**同一** Will 真相源。  
- 关掉对话扩展后，Core 仍能 tick（读/想/整理/idle）自洽。  
- replan 不丢 deferred 日历关心。  

---

## 1. 架构与主权

### 1.1 一句话

**Oren 的本人 = 中核（Will + 线索 + 品味 + 体验循环）。**  
对话、看板、未来 tool 都是扩展；**意图只出自 Will**；扩展只负责输入通道与执行/表达。

### 1.2 逻辑分层

```
┌─────────────────────────────────────────────┐
│ CORE（本人）                                 │
│  Will          当前意志 / 取向 / 开放 moves   │  ← 唯一意图主权
│  threads       自有记忆（在追什么）            │
│  taste         内在性（筛什么值得）            │
│  life loop     perceive → 修订 Will → 执行 → 回写 │
│  relation      冷热/缺席纹理（调制油门，不夺权） │
└────────────────────┬────────────────────────┘
                     │ 投影 / 调用
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
 session queue    dialogue        (later) tools
 (原 agenda)      通道 + 表达       工作臂
```

### 1.3 硬规则（产品锁）

1. **单一主权**：追问、换题、分享、主动开口、独处读想——意图必须能在 Will 上解释；禁止 reply 黑盒另立政策。  
2. **规划管意图，不管台词**：Will / moves 是 want；utterances 是表达层。  
3. **Agenda = 投影**：3–7 的 session queue 是 Will 的可执行展开，不是第二人格。  
4. **用户在场**：暂停重独处（长读 / 重规划节流）；对话走 Will→表达，不换成客服循环。  
5. **干活第二**：tool 仅扩展挂点。  
6. **内容主权**：用户冷淡 → 调 relation / 减弱 share·ask drives；不删 threads、不弯 taste（渗透动力学另规格）。  

### 1.4 与现状映射

| 现在 | 之后 |
|------|------|
| `agenda` plan/act | Will 修订 + session queue 执行 |
| `reply` 内 stance/share | Will-turn 定 moves → Express 生成 |
| seepage | 保留：表达层输入，非第二主权 |
| `chooseMode` 遗留 | 仅兼容 / force；常态走 Will |
| dashboard / CLI | 扩展；应展示 Will 摘要 |

### 1.5 参考 Pi 的边界

- **参考**：一个主体循环 + 可挂扩展；tool / 渠道不是人格本体。  
- **不参考**：把 Oren 做成 coding harness；Pi monorepo 不 fork。  
- 未来工作臂：Will 点名 `commit_work` 类意图 → ToolRuntime 扩展执行 → 结果回写 Will / threads；本规格不展开实现。  

---

## 2. Will 状态与意图形态

### 2.1 定义

Will 是落盘的**当前时**主体状态（真相源）。

| 组件 | 时间尺度 | 角色 |
|------|----------|------|
| threads / taste | 慢 | 我是谁、我在追什么 |
| Will | 较快 | 我此刻打算怎样、对你怎样 |
| system prompt | 瞬时 | 调用时注入规则 + Will 摘要；**不是** Will 本身 |

### 2.2 字段

```
Will
├── updated_at: string (ISO)
├── focus: { thread_id?: string, summary: string }
├── solitude: {
│     mode_bias: "read" | "think" | "organize" | "idle" | "mixed"
│     note?: string
│   }
├── toward_user: {
│     posture: "engage" | "soft_check" | "quiet" | "care"
│     share_drive: "low" | "mid" | "high"   // 或 0–1，实现二选一写死
│     ask_drive: "low" | "mid" | "high"
│   }
├── open_moves: Move[]      // 可跨回合挂起
├── session: {              // 原 agenda 投影
│     id, created_at, updated_at
│     horizon: "session" | "day" | "open"
│     status: "open" | "closed"
│     queue: string[]
│     intents: Record<id, Intent>
│     planning_note?: string
│     actions_since_plan: number
│   }
└── last_reason?: string
```

**Move / Intent 共用骨架（概念）：**

```
{
  id, kind, status, title,
  thread_id?, hints?, source, created_at,
  outcome?, blocked_reason?,
  due_start?, due_end?, care_count?, max_care?   // deferred care
}
```

`status`: `pending | active | done | skipped | blocked | deferred`  
`source`: `plan | during_action | dialogue | system | will_turn`

**实现约定（消歧）：** `toward_user.*_drive` 采用 `"low" | "mid" | "high"` 三档，避免浮点调参歧义；若内部需要数值，仅在模块内映射，不暴露双口径。

### 2.3 Kind 集合

#### 独处向（session queue 主执行）

| kind | 含义 |
|------|------|
| `read` | 读本地语料 |
| `think` | 纯想线索/问题 |
| `organize` | 整理记忆 |
| `idle` | 刻意发呆 |
| `seek` | 外读/查询（默认可 blocked） |
| `say` | 主动开口（无用户消息） |

#### 对话向（Will-turn 主产出，Express 消费）

| kind | 含义 |
|------|------|
| `follow` | 顺着用户当前话题 |
| `ask` | 追问/澄清 |
| `weave` | 接住 + 轻带一点自己的 |
| `lead` | 以自己焦点为主（换题或主导） |
| `share` | 打开内心一块 |
| `care` | 关心/日历向轻问 |
| `curt` | 少说、收束 |
| `acknowledge` | 只接住，不推进 |

旧 `stance: follow | weave | lead` 并入上述 moves，**不再**由 Express 单独发明政策。

### 2.4 生命周期

```
pending → active → done | skipped | blocked
deferred →（到期 promote）→ pending
```

- 新想法只进队尾。  
- replan：修订 Will + 重投影 session；**保留** deferred / 未完成 care。  
- 对话 moves 可 **turn-local**（本回合 done）；值得跨回合则升入 `open_moves` 或 deferred。  

### 2.5 写权限

| 来源 | 可写 |
|------|------|
| 独处 Will-revise | focus、solitude、session、可选 toward_user / say |
| 沉思 integrate | 可建议 focus / open_moves；taste 走原 nudge 策略 |
| 对话 Will-turn | toward_user、turn moves、open_moves 升降级 |
| 对话 Express | **只读**；禁止改意图 |
| relation 吸收冷热 | 压低/回调 share_drive、ask_drive；不删 focus/threads |
| Tool 扩展（未来） | 仅任务投影字段；本规格不写 |

### 2.6 刻意不做

伤口/愈合、完整情绪环、Will 版本史 UI（stream 足够）、tool runtime。

---

## 3. 数据流

### 3.1 共同前置

1. Load：meta / config / taste / threads / affect / relation / **Will**  
2. Perceive：gap、语料变更、线索显著性、上次用户接触、stream 尾  
3. 按触发源分支：独处（tick）或对话（say）——**同一人格，不是两套系统**  

落盘：校验 → 原子写 → stream append →（对话则 dialogue append）。

### 3.2 独处路径（`oren tick` / heartbeat）

```
Load → Perceive
  → 用户在场？（last contact < user_present_ms）
       ├─ 是：不重 plan / 不重 act 独处
       │      可选极轻 Will 修订（缺席、promote deferred）
       │      presence/idle 事件 → Persist
       └─ 否：
            Promote due deferred
            → 需 Will-revise？（queue 空 / replan_after_actions / force）
                 ├─ 是 → Will-revise（LLM）→ session 投影
                 └─ 否 → 用当前 Will
            → 取下一条可执行 session intent
            → SessionAct 一刀
            → Integrate + Will outcome 回写
            → Persist
```

| 现在 | 之后 |
|------|------|
| `decideAgendaTick` | 读 Will + session + user_present |
| `buildAgendaPlan` | Will-revise |
| `actOnIntent` | SessionAct |
| `chooseMode` | 兼容/force only |

`say` 一刀：写 proactive dialogue → 冷却 → 可下调 share_drive。

### 3.3 对话路径（`oren say` / dashboard）

```
Load → Perceive（含 user text）
  → record visit / absence
  → Will-turn（意图，非台词）
       输入：user text、Will 摘要、seepage threads、
             relation、dialogue 尾、日历线索
       输出：turn_moves[]、will_patch、share_allowed、care 建议
  → 应用 will_patch（先意图后嘴）
  → Express（冻结 moves）
       硬约束：
         · moves 含 curt → 少气泡、不 lead
         · 无 share 且 share_allowed=false → 禁止 share.opened
         · 无 lead → 不得强行无关换题
         · READ 须 grounding
  → 解析 / grounding 修复
  → absorb relation → 可轻触 drives
  → dialogue + stream（will_turn / expressed）
  → Persist
```

**时序锁死：先 Will、后嘴。** Express 只读本回合已提交 moves。

### 3.4 共享存储关系

```
            will.json（真相源）
             ▲          │
  独处/对话回写          │ 读摘要
             │          ▼
       stream 审计    prompt 注入小节
       dialogue 仅话语
```

用户在场时：对话可走；session queue 中的 read/think 等待不在场再 act。

### 3.5 失败与降级

| 情况 | 行为 |
|------|------|
| Will-turn LLM 失败 | 默认 `follow` + `acknowledge`；极短敷衍可用 `curt`；不 lead/share；`will_turn_failed` |
| Express 失败 | 不写假成功对话；**保留**已应用 will_patch；对话标 failed |
| Express 违反 moves | 裁剪 / 重试 1 次 / 安全短句 |
| 锁冲突 | exit 2（同现网） |
| 空 corpus 的 read | 降级 think/idle 或 blocked；不刷失败心跳 |
| will.json 损坏 | doctor 报错；可自 agenda/threads 重建；不静默空成功 |

### 3.6 LLM 预算

| 步骤 | 调用 | 路由建议 |
|------|------|----------|
| Will-revise | 0–1 | `OREN_WILL_LLM` |
| SessionAct read/think | 0–1 | `OREN_TICK_LLM` |
| Will-turn | 1（短 JSON） | `OREN_WILL_LLM` |
| Express | 1（+ 可选 grounding 修复） | `OREN_SAY_LLM` |

---

## 4. 组件、存储、迁移与测试

### 4.1 逻辑组件

| 组件 | 职责 | 不做什么 |
|------|------|----------|
| WillStore | 读写 will、默认值、迁移合成 | 不调 LLM |
| WillRevise | 独处修订 + session 投影 | 不对用户写台词 |
| WillTurn | 对话意图 → moves + patch | 不写多气泡正文 |
| Express | 冻结 moves 下生成话语 | 不改 Will 政策 |
| SessionAct | 执行一条 queue intent | 不自由聊 |
| TickEngine | 编排独处、锁、persist | 不内嵌长 prompt |
| DialogueFacade | CLI/HTTP → WillTurn → Express | 不含第二人格 |
| LifeStore / corpus / threads / taste | 记忆与养分 | 无意图主权 |
| Relation | 调制 drives | 不单独决定 lead/share |
| ToolRuntime | **占位边界 only** | 本规格不实现 |

文件归宿（渐进）：

- `agenda/plan.ts` → WillRevise  
- `agenda/act.ts` → SessionAct  
- `agenda/schedule.ts` → engine 调度读 Will  
- `dialogue/reply.ts` → WillTurn + Express  
- `dialogue/grounding.ts` → Express 之后  

### 4.2 存储

```
data/life/   # 或 OREN_HOME 生命根
  will.json
  agenda.json   # 过渡期可双写；目标态内嵌 will.session
  threads/
  taste.json
  relation.json
  dialogue.jsonl
  stream.jsonl
  …
```

**迁移：**

1. 无 `will.json` → 自 agenda + affect + 活跃 threads **合成**默认 Will，首次 tick/say 写回。  
2. 过渡期可选 **Will.session ↔ agenda.json 双写**。  
3. 目标态：agenda 文件可废弃；`schema_version` bump 时 doctor 提示。  

**Stream 事件（名称固定如下）：**

- `will_revised`  
- `will_turn`  
- `expressed`  
- `will_turn_failed`  

### 4.3 配置增量

```json
{
  "will": {
    "enabled": true,
    "user_present_ms": 120000,
    "replan_after_actions": 3,
    "say_cooldown_ms": 14400000,
    "max_open_moves": 12,
    "min_session_intents": 3,
    "max_session_intents": 7
  }
}
```

未配置时：从现有 `config.agenda` 映射默认值，行为不回退到「无 Will」。

### 4.4 测试

| 层 | 内容 |
|----|------|
| 单元 | 迁移合成；无 share move → share 拒绝；curt 裁剪；deferred 保留 |
| 契约 | fake LLM：tick 修订 Will 并 act；say 含 will_turn + expressed |
| 行为 | 「嗯」不 lead；预置 share 可开；user_present 不重 act 独处 |
| 回归 | grounding、relation cold、care、lock/exit codes |
| Live | 可选 `OREN_LIVE_LLM=1` 一次 will_turn+express |

### 4.5 实现分期

| 阶段 | 交付 |
|------|------|
| P0 | WillStore + 迁移合成；tick 读 Will；session 双写 |
| P1 | 对话拆 WillTurn + Express；硬约束 + 测试 |
| P2 | plan → WillRevise 命名收束；status/doctor/看板 Will 摘要 |
| P3 | 去双写、事件稳定、README 对齐；tool 仍仅挂点 |

### 4.6 风险

| 风险 | 缓解 |
|------|------|
| 双 LLM 延迟/成本 | Will-turn 短 JSON + 可快模型；fake 路径保 CI |
| Will 变成装饰 | 硬约束在 Express 服务端强制，不只靠 prompt |
| replan 丢日历 | 单测 preserve deferred（继承现 agenda 修复） |
| 半截升级 | 迁移合成 + 可选双写 |
| 主体被未来 tool 吸走 | 产品锁：接任务须 Will；ToolRuntime 无最终主权 |

---

## 5. 决策记录（brainstorming）

| 决策 | 选择 |
|------|------|
| 规划栖息层 | **B** 持续 Will 状态（非仅 session 队列、非每句硬 replan） |
| Core 边界 | **中核 B**：Will + threads + taste + 体验循环；渠道/tool 扩展 |
| 干活/tool 优先级 | **第二**：在场与主体优先 |
| 本规格范围 | **脊柱 + 对话收束**（非整包 tool 蓝图） |
| 实现路径 | **方案 2**：Will 真相源；agenda/对话为投影 |
| Will vs prompt | Will 落盘状态；prompt 仅摘要投影 |
| drive 口径 | 三档枚举 low/mid/high |

---

## 6. 与本质文档对齐摘要

| 本质主张 | 本规格 |
|----------|--------|
| 独立主体，陪伴溢出 | Will 主权；对话/say 为溢出执行 |
| 体验循环主旋律 | 独处路径仍以 read/think/organize/idle 为主 |
| 自有记忆 / 品味 | 留在 Core，不降为 tool 状态 |
| 渗入 + 分享闸门 | seepage 保留；share 须 moves / share_allowed |
| 冷淡→关系认知不改兴奋 | relation 调 drives；不删 threads |
| 主动联系 | session `say` + Will toward_user |
| 认识边界 | Express 后 grounding 保留 |

---

## 7. 下一步

1. 用户审阅本 spec。  
2. 批准后进入 `writing-plans`：按 P0→P3 拆实现计划。  
3. 不在本对话直接改行为代码，直至计划批准。  
