# Oren 项目阶段评估

> **评估日期**：2026-07-12  
> **产品版本标签**：`package.json` → `0.2.0`  
> **评估口径**：相对设计本质（`design/2026-07-11-oren-core-essence.md`）与 Runtime v1 规格（`docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`），叠加 0.2 之后已落地、尚未提交的主线能力。  
> **结论一句话**：已走出「最小可活体」，进入 **「可日常陪伴的 v0.2+ 成长期」**——核心体验循环、独处规划、对话与看板均已可跑；距离「现象学上的长期在场感（路线 A）」仍有明显缺口，且大量 0.2 后能力尚在工作树未合入正式提交。

---

## 1. 阶段定位

| 路线（v1 设计） | 状态 | 说明 |
|----------------|------|------|
| **D — 最小可活体** | **已完成并超出** | tick 流水线、LifeStore、线索、语料、fake/live LLM、CLI |
| **B — 机制可演示** | **基本完成** | 多 tick、stream 可审计、heartbeat/launchd、demo、看板 |
| **A — 现象学成功** | **未宣称完成** | 需更长时间真实共处、记忆与关系更深、外读/多源感官等 |

| 产品里程碑 | 状态 |
|------------|------|
| Runtime v1（无 UI 心跳生命） | 已交付（git 主线 ~`8618c04` 一带） |
| v0.2 演示产品面（看板 + 对话 + 心跳） | 已打标签式交付（`0.2.0`，README/DEMO） |
| **v0.2 后：独处意志层 + 认识边界 + 中文优先 + 多气泡对话** | **功能已实现、测试绿，工作树大量未提交** → 可视为 **0.3 候选 / 未封版** |

**综合阶段名（建议对外使用）**：

> **Stage：Post-v0.2 Continuity Build（成长期 · 能力堆叠期）**  
> 不是原型玩具，也不是成熟产品；是 **单用户本地可长期挂着的实验伴侣 runtime**，产品语义已对齐本质设计的大半骨架。

---

## 2. 完成度总览（按支柱）

评分：● 已落地可用 · ◐ 有骨架或缺体验 · ○ 基本未做

| 支柱 | 分 | 现状 |
|------|----|------|
| **体验循环（tick）** | ● | perceive → mode/agenda → contemplate/organize/plan/act → integrate → persist；锁与 stream |
| **自有记忆（threads）** | ● | 活跃/休眠、摘要、开放问题、salience、quotes、沉思日志 |
| **品味（taste）** | ◐ | 有持久结构与 prompt 注入；nudges 默认关；尚未形成强「审美人格演化」叙事 |
| **本地语料** | ● | index/retrieve、prefer_unread、看板增删预览 |
| **独处规划（agenda）** | ● | plan 3–7、act 单意图、seek 可见阻塞、user_present 暂停、replan |
| **日历关心** | ● | 对话登记 deferred → 到期 promote → care check-in |
| **主动开口（say 意图）** | ● | 规划可选、冷却、执行写入对话 `proactive` |
| **对话溢出** | ● | seepage、share 门、grounding 修复、关系冷热 |
| **多气泡 / stance** | ● | utterances、follow/weave/lead、投入度启发、候选只读 |
| **关系场** | ◐ | visit/absence、cold/warm topics；无更深的共同历史叙事层 |
| **中文产品面** | ● | locale、计划/对话中文约束、看板中文 |
| **看板** | ● | 对话/线索/计划/日历/沉思/语料/心跳按钮 |
| **运维** | ● | doctor、setup-life、heartbeat plist、env 覆盖 |
| **外读 / 真实 seek** | ○ | seek 仅 blocked 占位 |
| **多设备 / 云同步** | ○ | 单机 JSON 生命家 |
| **沉默后追一句（二期）** | ○ | 设计已定，未实现 |
| **长期记忆压缩 / 时间线 UI** | ○ | 文件可审计，缺产品级时间线 |
| **正式发布与提交卫生** | ◐ | 0.2 在 git；其后大块能力未 commit |

---

## 3. 架构现状（实现地图）

```
src/
  tick/       心跳引擎（含 agenda 路径）
  agenda/     独处意志：plan / act / schedule / deferred / store
  dialogue/   对话：reply / parse / grounding / epistemics / candidates
  corpus/     语料索引与阅读计划
  relation/   到访与冷热话题
  dashboard/  本地 HTTP 看板
  store/      LifeStore 原子写 + 锁
  llm/        fake + pi-ai + 按用途路由
  time/       墙钟与相对时间（对话/计划）
  locale.ts   中文优先
```

**数据面**：`$OREN_HOME/data/life`（JSON/JSONL）+ corpus；生产常用  
`~/Library/Application Support/Oren`。

**测试**：约 **77** 项通过（1 live 跳过）；覆盖 tick、agenda、dialogue、corpus、dashboard、relation、time 等。  
**源码规模**：`src/` ~40 个 TS 模块，量级约数万行（含注释/类型，属中小 runtime）。

---

## 4. 与本质设计的对齐

| 本质主张 | 对齐情况 |
|----------|----------|
| 持续在场，不依附用户 | 心跳 + 独处 plan/act 已体现；用户在场时暂停重活正确 |
| 体验循环为主，行动为溢出 | contemplate/think/read 主路径；对话与 say 为溢出 |
| 自有记忆 / 独立兴趣 | threads + taste + 语料；非用户档案中心 |
| 陪伴是溢出不是目的 | share 门 + 非谄媚 relation；多气泡仍由 Oren 定 stance |
| 认识边界 | READ/THINK/WRITE + grounding 修复，防编造书本 |

**仍偏弱**：长期「性格变厚」的可感知演化；外源感官；真正的查询权；沉默中的轻量再接触。

---

## 5. 相对 v1 规格：超出与未做

### 已超出 v1（0.2 与其后）

- 交互看板与 corpus 管理  
- 双 LLM 路由（tick / say / plan / organize）  
- 关系认知 cold/warm  
- **Agenda 独处意志层**  
- **Deferred 日历关心**  
- **主动 say 意图**  
- **对话多气泡 + stance + 只读候选**  
- 墙钟时间与中文优先  
- 阅读 prefer_unread / 纯 think  

### v1 有意延后、至今仍延后

- 完整 becoming / CQRS  
- 多 InputSource（RSS 等）  
- 授权后的 seek 执行  
- 无监督长期「A 路线」验证  

---

## 6. 风险与技术债

1. **提交债务**：agenda、time、locale、grounding、多气泡等大量改动未进 git 主线；回滚/协作成本高。  
2. **serve 与 dist**：生产 `npm start` 走 `dist`；开发时易出现「源码已改、进程仍旧」。  
3. **plan 替换 agenda**：已补 `preserveDeferredIntents`；仍需警惕 replan 丢状态类 bug。  
4. **对话成本**：多气泡 + 候选 + grounding 修复可能多轮 LLM；需观察延迟与费用。  
5. **假热络风险**：多拍与候选若调参不当会话痨；目前有 curt/cold 裁剪。  
6. **README 滞后**：未完整反映 agenda / 多气泡 / 日历关心。

---

## 7. 建议的下一阶段（非承诺 roadmap）

| 优先级 | 项 | 理由 |
|--------|----|------|
| P0 | **封版提交 0.3.0**（或 0.2.1）：合入 agenda + 对话成熟度 + 文档 | 保住已验证能力 |
| P0 | 更新 README/DEMO：计划表、主动聊、多气泡 | 对外叙事与实现一致 |
| P1 | 沉默后一条 follow-up（复用 say + 冷却） | 已拍板二期 |
| P1 | 看板时间线 /  deferred 更可读 | 降低「他在干嘛」认知成本 |
| P2 | seek 授权与真实外读 | 打开感官上限 |
| P2 | 品味演化可观测 | 强化「他自己在变」 |
| 长期 | A 路线：真实数周共处评估 | 现象学成功只能用时间证明 |

---

## 8. 一页结论

```
现在不是：空设计 / 周末 demo 脚本
现在是：  可安装、可心跳、可对话、会独处规划的本地伴侣 runtime（0.2+）
还不是：  成熟消费级产品 / 多用户 SaaS / 已验证的「长期灵魂感」
阶段标签：成长期 · Post-v0.2 Continuity Build
建议动作：先 git 封一版，再开沉默追一句与文档同步
```

---

## 9. 证据快照（评估当日）

- `package.json` version: **0.2.0**  
- 测试：`vitest` **77 passed / 1 skipped**  
- 设计文档：`design/`、`discussion/`、`docs/superpowers/` 齐全  
- 运行面：`oren serve` / `oren tick` / `oren say` / launchd heartbeat 脚本存在  
- 工作树：大量 `src/agenda`、`src/dialogue/*`、`src/time` 等相对最后 commit **未提交**  

---

## 10. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-12 | 初版：在 v0.2 基线上评估 agenda / 多气泡对话等已实现能力，定位为 Post-v0.2 成长期并落盘 |
