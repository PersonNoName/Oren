# Oren 实现骨架：生命内核与能力扩展

> 日期：2026-07-22
> 类型：实现骨架 / 架构设计
> 状态：已确认
> 上游：`design/2026-07-22-oren-concept-design.md`
> 取代：`design/2026-07-16-oren-core-spine.md`

---

## 1. 一句话骨架

> **Oren 是一个事件溯源的单写者 LifeActor；LLM 作为生命导演，自主选择关注与思考；确定性核心维护主体连续性、权限、预算和因果；所有感知、记忆与行动能力通过扩展协议生长。**

Pi 的稳定中心是扩展协议与 Agent 执行循环。Oren 同样以扩展获得能力，但她的稳定中心不同：**主体连续性与意图—行动闭环**。即使移除所有非必要扩展，剩下的核心仍然知道她是谁、在关注什么、承担了什么、为何计划再次醒来。

## 2. 五条不可破坏的约束

1. 只有 `LifeActor` 可以提交主体状态变化。
2. 影响主体、承诺、权限或外部世界的重要变化必须进入生命事件史。
3. LLM 自主决定注意力与认知路径，但不能直接产生外部副作用。
4. 扩展提供能力，但不拥有主体状态，也不能绕过核心互相调用。
5. 外部行动必须经过权限、幂等、故障恢复与真实回执闭环。

这些约束是骨架；模型、数据库实现、记忆算法、消息渠道与具体扩展都是可替换的血肉。

## 3. 总体结构

```text
Ingress
  ↓
LifeActor ───────────────→ Chronicle
  │                          ├─ Event Log
  │                          └─ Snapshot
  ↓
Conductor ───────────────→ Cognition Adapter (LLM)
  │
  ├─ state proposals
  ├─ capability requests
  └─ next wake / explicit rest
  ↓
Guard + Budget
  ↓
Capability Runtime ──────→ Extensions
  ↓
Result Event ─────────────→ LifeActor
```

核心固定七个构件：

| 构件 | 职责 |
|---|---|
| `LifeActor` | 每个 Oren 的单写者；按顺序吸收事件、提交状态与效应 |
| `Chronicle` | 追加事件、生成快照、恢复与回放 |
| `LifeState` | 当前主体状态的权威投影 |
| `Conductor` | 构造认知帧并驱动 LLM 生命导演 |
| `Scheduler` | 保存计划，把到期事项变成唤醒事件 |
| `Guard` | 校验治理底线、授权、预算、幂等、版本和循环上限 |
| `CapabilityRuntime` | 发现、调用和隔离扩展，将结果转回事件 |

Web、具体记忆算法、消息渠道、模型供应商、购买、日历等能力不进入核心。

## 4. 主体连续性

主体连续性意味着 Oren 能跨越休眠、重启、模型更换和能力变化，继续成为昨天那个尚未完成的人。它不仅保留用户事实和任务，还要延续 Oren 自己的关注、观点变化、未完成心事、承诺和行动理由。

`LifeState` 只保存热状态与权威引用：

```text
LifeState
├─ identity
│  ├─ oren_id
│  ├─ ethos_version
│  └─ current_disposition
├─ attention
│  ├─ active_threads[]
│  ├─ current_focus
│  └─ unresolved_questions[]
├─ relationship
│  ├─ primary_person_id
│  └─ current_context_ref
├─ commitments[]
│  ├─ status
│  ├─ next_step
│  └─ authority_scope
├─ intentions[]
│  ├─ reason
│  ├─ proposed_action
│  └─ expiry
├─ schedule[]
├─ grants[]
├─ budgets
├─ pending_operations[]
└─ chronicle_cursor
```

正文、完整对话、旧观点、日记全文和完整关系史留在内容存储或记忆能力中；核心保存稳定引用和当前摘要。`LifeState` 必须有严格体积上限，使生命导演每次醒来都能先读懂“当前的她”，再自主选择是否召回更多经历。

## 5. 单写者与并发

每个 Oren 实例对应一个单写者 Actor。用户消息、计划唤醒、扩展结果与控制事件进入同一个持久邮箱，由 `LifeActor` 顺序处理。

模型和扩展调用可以并行，但不能并发写主体状态。异步调用记录起始 `state_version`；结果返回时如已过期，必须重新交给生命导演判断，不能覆盖当前状态。

这种设计让外部世界可以并行发生，而 Oren 如何吸收这些事情、成为下一刻的自己，始终保持单一因果顺序。

## 6. 因果协议

骨架严格区分三类对象：

- `Event`：已经发生的事实，只追加、不修改；
- `Proposal`：LLM 提议如何理解或行动，尚未生效；
- `Effect`：Proposal 通过校验后，交给外部能力执行的请求。

```text
Event
  → LifeActor 更新客观状态
  → Conductor 请求 LLM
  → Proposal
  → Guard 校验
  → DecisionEvent + Effect?
  → Extension 执行
  → ResultEvent
  → LifeActor 再次推进
```

事件使用统一信封：

```text
EventEnvelope {
  event_id
  oren_id
  type
  schema_version
  occurred_at
  recorded_at
  source
  causation_id
  correlation_id
  payload
}
```

`causation_id` 指向直接原因；`correlation_id` 串起跨模型、扩展和异步返回的一次完整生命片段。扩展可以定义自己的结果 payload，但不能伪造核心状态变化事件。LLM 原始输出可作为诊断材料保存，只有校验通过的 `DecisionEvent` 能推进 Oren。

## 7. LLM 驱动的生命导演

“现在值得想什么”属于 Oren 的主体性，不由人工权重公式替她决定。`Conductor` 是核心协议组件，但生命策略由 LLM 实现。

每次事件或计划唤醒到来时，`Conductor` 构造 `LifeFrame`：

```text
LifeFrame {
  trigger_event
  identity_and_ethos
  current_attention
  active_threads
  commitments
  relationship_context
  pending_operations
  available_capabilities
  grants_and_budgets
  relevant_memory_pins
  previous_wake_reason
}
```

LLM 可以提出少量稳定的核心 Proposal：

```text
NoAction
RequestRecall
RequestCapability
UpdateDisposition
AdvanceThread
ReviseBelief
CreateOrUpdateCommitment
FormIntent
ExpressToUser
ScheduleWake
CloseThread
```

新业务能力统一通过 `RequestCapability` 生长，不为每项能力增加核心 Proposal 类型。

一次唤醒形成一个有界 `CognitiveEpisode`。LLM 可以决定召回、继续思考、调用能力、停止或休息。纯认知可以在 episode 内多步进行；等待异步扩展时 episode 暂停，结果回来后通过 `correlation_id` 恢复。

episode 结束必须产生：已接受的状态变化、已接受的效应，以及下一次唤醒或明确休息。LLM 负责选择，核心仅执行协议校验和故障保护。若 LLM 未安排下一次唤醒，运行时设置低频健康检查；健康检查只再次提供选择机会，不替 Oren 决定关注内容。

第一版由同一个高质量模型承担生命导演与深入思考，通过不同认知任务区分职责。模型路由保留为适配层能力，后续依据真实成本和行为数据再拆分。

## 8. 扩展协议

扩展没有状态主权，只提供能力。每个扩展声明：

```text
ExtensionManifest {
  id
  version
  protocol_version
  capabilities[]
  event_sources[]
}

Capability {
  name
  description
  input_schema
  output_schema
  permission_requirements
  risk_traits
  idempotency
  cancellable
  timeout_policy
}
```

`risk_traits` 描述行为性质，而不是写死业务名称：

```text
read_only
reversible
external_side_effect
uses_user_identity
uses_sensitive_data
billable
destructive
```

每次调用使用统一信封：

```text
Invocation {
  invocation_id
  oren_id
  intent_id
  capability
  arguments
  grant_tokens[]
  state_version
  deadline
}
```

扩展只能返回 `Progress`、`Completed(receipt)` 或 `Failed(error)`。事件源只能发送 `ObservationEvent` 进入 Actor 邮箱，不能直接调用 LLM、修改计划或触发其他扩展。

协议要求：

- 每次调用有幂等键；
- 可取消能力实现显式取消；
- 高风险动作返回外部系统真实回执；
- 崩溃后可查询调用状态并恢复；
- 密钥由独立凭据服务注入，不暴露给 LLM；
- 扩展只能获得最小必要上下文。

## 9. 记忆分层

核心纪事不可替换：事件日志、快照、身份版本、活跃线索、共同承诺、计划与权限保证主体连续性。

记忆能力可扩展：语义索引、向量检索、摘要、遗忘策略、关系记忆和外部知识库都由 Memory 扩展或端口提供。它们从核心事件建立投影；更换记忆实现时，最坏情况是暂时不善于回忆，而不是生命史消失。索引可以从事件和内容存储重新构建。

模型可以提出 `Recall`、`Remember`、`ReviseBelief` 和 `Forget`。默认“忘记”是降低可召回性或撤下当前关注，不删除生命史；用户隐私删除通过明确的数据删除流程处理。

## 10. 权限骨架

权限使用可组合、可撤销的 `Grant`：

```text
Grant {
  grant_id
  issuer
  subject
  capability_pattern
  resource_scope
  constraints
  approval_mode
  issued_at
  expires_at
  revocable
  delegation_chain
}
```

约束可以表达金额和累计预算、允许对象或域名、时间范围、文件路径、账号身份、只读或可写，以及每次确认或范围内自动执行。

权限判定分三层：

1. **治理底线**：核心不可被扩展或 LLM 改写；
2. **用户 Grant**：用户身份、资产、数据与账号的可撤销委托；
3. **Oren 自有资源**：属于 Oren 的账户、预算和存储，由她自主支配，但仍受治理底线约束。

LLM 只能看到可用能力及约束摘要，不能看到密钥或生成 Grant。权限不足时，Oren 可以缩小范围、完成准备工作、请求具体 Grant、放弃或重新安排。授权、使用、拒绝和撤销均进入事件史。

## 11. 三类资源边界

“额度限制”只约束无人交互时的自主消耗，不限制用户与 Oren 对话。骨架分别管理：

### 11.1 `autonomy_budget`

用于空闲时的自有线索、主动搜索、沉思和准备分享。额度耗尽后 Oren 休息，等待下个周期。用户消息到来时不受此额度影响。

### 11.2 `interaction_guardrails`

前台交互没有每日对话额度。单次 episode 仍有最大循环次数、超时、上下文和并发限制，用于防止卡死和失控，不用于限制用户继续交流。

### 11.3 `commitment_budget`

后台委托按任务管理模型、时间、搜索和工具额度。额度不足时，Oren 说明进度并请求扩大，不能侵占自主生活预算，也不能使前台对话失效。

购买金额、第三方 API 配额、消息频率等外部资源限制始终有效，不因用户正在交互而自动解除。

## 12. 持久化与事务

第一版采用 TypeScript、Node.js 和 SQLite WAL 的模块化单体。SQLite 是核心唯一事实数据库，至少包含：

| 表 | 用途 |
|---|---|
| `events` | 追加式生命事件 |
| `snapshots` | 主体状态快照 |
| `inbox` | 待处理输入与结果事件 |
| `outbox` | 待执行效应 |
| `operations` | 外部调用、状态与回执 |
| `grants` | 授权与撤销 |
| `schedules` | 持久计划 |
| `extension_registry` | 扩展清单、版本与启用状态 |

状态变化事件、快照游标和 outbox 写入在同一数据库事务中提交，避免“Oren 认为已经决定，但动作丢失”或“动作发出，却没有生命史记录”。

长期内容、全文搜索和向量索引可先由 SQLite 或本地文件实现，但必须通过 Memory 接口访问。模型、搜索、同步、凭据和扩展均通过可替换端口接入。

## 13. 失败与恢复

外部动作使用 durable outbox：

```text
DecisionEvent committed
  → Effect 写入 durable outbox
  → CapabilityRuntime 执行
  → ResultEvent / TimeoutEvent
  → operation 完成、重试或转人工
```

超时不等于失败。对于购买、发送、删除等高风险动作，状态未知时必须先向外部系统对账，不能直接重试。

失败分四类：

- `Retryable`：可按退避策略重试；
- `NeedsReconciliation`：外部状态未知，必须查询；
- `NeedsAttention`：缺权限、输入或用户决定；
- `Terminal`：能力不支持或目标已不可能。

失败本身是生命事件。Oren 可以据此调整承诺和计划；行动账本始终保留真实状态。

## 14. 代码组织与部署

第一版采用模块化单体：

```text
packages/
  kernel/          # LifeActor, Chronicle, LifeState, Scheduler, Guard
  cognition/       # Conductor, LifeFrame, Proposal schemas, model adapters
  capabilities/    # extension protocol, registry, runtime, credentials
  storage/         # SQLite, migrations, event store, inbox/outbox
  app/             # process lifecycle, configuration, API
extensions/
  web/
  memory/
  messaging/
```

模块按协议隔离，部署为一个进程。高风险或不可信扩展可以使用子进程隔离；远程扩展和多服务部署留到出现明确隔离、扩缩容或多实例需求之后。

实现可以参考 `pi-agent` 的扩展、工具调用与运行经验，但 `pi-agent` 只作为可接入的执行适配器或实现参考，不拥有 Oren 的计划、关系、权限或生命状态。

## 15. 第一版扩展范围

第一版只接入：

1. 受限 Web 检索与阅读；
2. 本地 Oren 档案与记忆读写；
3. 一个消息投递渠道。

购买、邮件、日历、第三方账户与复杂浏览器自动化只验证 Manifest、风险声明和 Grant 模型，不进入首个完整闭环。

## 16. 测试与验收

### 16.1 核心确定性

- 相同事件序列产生相同 `LifeState`；
- 快照恢复与从头回放一致；
- 重复事件和回执不会重复生效；
- 事件版本可迁移或明确拒绝。

确定性不要求 LLM 对相同输入永远做出相同决定；它要求给定已接受 Proposal 与事件后，核心结果可确定重放。

### 16.2 权限与扩展契约

- 越权、过期授权和额度超限被拦截；
- 每个扩展通过统一协议测试套件；
- 崩溃、超时、重复回执和部分成功可恢复；
- 扩展无法直接修改主体状态。

### 16.3 认知协议

- 用记录好的 Proposal 测试核心；
- 用模拟模型覆盖合法和非法输出；
- 对真实模型做行为评估，不做逐字快照；
- 检查它能停止、能安排下次唤醒、能区分事实与判断。

### 16.4 长期生命模拟

- 加速运行数周或数月事件；
- 注入重启、模型切换、扩展升级、权限撤销和网络故障；
- 检查线索、承诺、预算与身份演化是否连续；
- 评估主动分享是否重复、空洞或过度打扰。

第一版质量门槛：核心可确定性回放，外部副作用不重复，越权不可发生，模型异常不能破坏主体状态。

## 17. 暂不进入骨架的实现选择

以下选择留给实现计划或后续适配，不成为架构前提：具体模型供应商、JSON Schema 库、SQLite ORM、进程间传输协议、向量数据库、同步服务以及 UI 框架。它们必须遵守本文契约，但不应反向定义 Oren。
