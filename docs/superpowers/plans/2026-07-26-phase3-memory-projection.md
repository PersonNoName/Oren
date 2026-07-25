# Phase 3 记忆投影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从核心事件史建立可召回的记忆投影：模型可在 episode 内 `memory.recall`，可通过 `Remember` / `ReviseBelief` / `Forget` 三个新 Proposal 经营记忆，每次唤醒自动注入 ≤5 条记忆钉。

**Architecture:** 读 = `memory.recall` 即时能力（episode 内工具调用）；写 = 核心 Proposal → 核心事件 → 投影更新。新建 `packages/memory` 包实现 `MemoryPort`（SQLite，同一数据库、独立表、可从事件史重建）；向量检索经可替换 `EmbeddingPort`（真实为凭据门控的 OpenAI 兼容端点，无凭据自动降级为结构化检索）。kernel 只扩协议保持零依赖。

**Tech Stack:** TypeScript (ES2024, NodeNext, strict + exactOptionalPropertyTypes), node:sqlite, vitest, npm workspaces。

**Spec:** `docs/superpowers/specs/2026-07-26-phase3-memory-projection-design.md`

## Global Constraints

- `npm test` / `npm run typecheck` / `npm run build` 全绿且**完全离线**；真实 embedding 与真实模型均为凭据门控的手动路径。
- kernel 保持零依赖；记忆事件**不改变 LifeState**（reducer 对新事件走 default 分支只递增版本）。
- `Forget` 只把 `recallability` 降为 `lowered`，不删除任何行或事件。
- 自动投影的 `memoryId` 从来源事件 ID 确定性派生（`mem:${eventId}`），保证 rebuild 与增量投影一致；显式 `Remember` 的 `memoryId` 由 LifeActor 用 `nextId()` 生成并写入事件。
- `ReviseBelief` / `Forget` 引用未知 `memoryId`：事件照常入史，投影侧跳过，不抛错。
- 测试文件放各包 `test/` 目录，命名 `*.test.ts`（vitest 全局 API 可用）。
- 每个任务结束时该任务的测试与 `npm run typecheck` 必须通过再提交。

---

### Task 1: kernel 记忆协议（Proposal、事件、校验、LifeActor 映射）

**Files:**
- Modify: `packages/kernel/src/protocol.ts`
- Modify: `packages/kernel/src/runtime-validation.ts`
- Modify: `packages/kernel/src/life-actor.ts`
- Test: `packages/kernel/test/memory-protocol.test.ts`

**Interfaces:**
- Consumes: 现有 `Proposal` / `CoreEvent` 联合类型、`canonicalizeProposal` / `canonicalizeCoreEvent`、`LifeActor.acceptCognition`。
- Produces（后续任务依赖，签名精确如下）:
  - `export type MemoryKind = "user_statement" | "external_fact" | "oren_judgment" | "oren_expression"`（从 `@oren/kernel` 导出）
  - Proposal 新成员：`{ type: "Remember"; text: string; kind: MemoryKind; confidence?: number; reviewCondition?: string; threadId?: ThreadId }`、`{ type: "ReviseBelief"; memoryId: string; revisedText?: string; confidence: number; reason: string }`、`{ type: "Forget"; memoryId: string; reason: string }`
  - CoreEvent 新成员：`{ type: "MemoryRemembered"; memoryId: string; kind: MemoryKind; text: string; confidence?: number; reviewCondition?: string; threadId?: ThreadId }`、`{ type: "BeliefRevised"; memoryId: string; revisedText?: string; confidence: number; reason: string }`、`{ type: "MemoryForgotten"; memoryId: string; reason: string }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/test/memory-protocol.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  canonicalizeProposal,
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  type CognitionJob,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";

describe("memory proposals", () => {
  it("canonicalizes a valid Remember proposal and preserves optional fields", () => {
    expect(canonicalizeProposal({
      type: "Remember",
      text: "用户在准备一场关于城市步行系统的演讲",
      kind: "user_statement",
    })).toEqual({
      type: "Remember",
      text: "用户在准备一场关于城市步行系统的演讲",
      kind: "user_statement",
    });
    expect(canonicalizeProposal({
      type: "Remember",
      text: "判断：用户最近的低落与工作压力有关",
      kind: "oren_judgment",
      confidence: 0.6,
      reviewCondition: "下次用户主动谈到工作时复查",
      threadId: "thread-1",
    })).toMatchObject({ type: "Remember", confidence: 0.6, threadId: "thread-1" });
  });

  it("rejects invalid Remember proposals", () => {
    // oren_judgment 必须带 confidence
    expect(canonicalizeProposal({
      type: "Remember", text: "判断", kind: "oren_judgment",
    })).toBeUndefined();
    // confidence 越界
    expect(canonicalizeProposal({
      type: "Remember", text: "x", kind: "oren_judgment", confidence: 1.5,
    })).toBeUndefined();
    // 空文本 / 非法 kind / 多余键
    expect(canonicalizeProposal({ type: "Remember", text: "", kind: "user_statement" }))
      .toBeUndefined();
    expect(canonicalizeProposal({ type: "Remember", text: "x", kind: "diary" }))
      .toBeUndefined();
    expect(canonicalizeProposal({ type: "Remember", text: "x", kind: "user_statement", extra: 1 }))
      .toBeUndefined();
  });

  it("canonicalizes ReviseBelief and Forget with mandatory reasons", () => {
    expect(canonicalizeProposal({
      type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "用户已决定留下",
    })).toEqual({ type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "用户已决定留下" });
    expect(canonicalizeProposal({
      type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "",
    })).toBeUndefined();
    expect(canonicalizeProposal({ type: "Forget", memoryId: "m1", reason: "已无跨时间价值" }))
      .toEqual({ type: "Forget", memoryId: "m1", reason: "已无跨时间价值" });
    expect(canonicalizeProposal({ type: "Forget", memoryId: "", reason: "r" }))
      .toBeUndefined();
  });

  it("canonicalizes the three memory core events", () => {
    expect(canonicalizeCoreEvent({
      type: "MemoryRemembered", memoryId: "m1", kind: "external_fact", text: "事实",
    })).toMatchObject({ type: "MemoryRemembered", memoryId: "m1" });
    expect(canonicalizeCoreEvent({
      type: "MemoryRemembered", memoryId: "m1", kind: "oren_judgment", text: "判断",
    })).toBeUndefined(); // judgment 缺 confidence
    expect(canonicalizeCoreEvent({
      type: "BeliefRevised", memoryId: "m1", confidence: 0.1, reason: "r",
    })).toMatchObject({ type: "BeliefRevised" });
    expect(canonicalizeCoreEvent({
      type: "MemoryForgotten", memoryId: "m1", reason: "r",
    })).toMatchObject({ type: "MemoryForgotten" });
  });

  it("memory events advance the version without changing LifeState shape", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const envelope: EventEnvelope = {
      eventId: "e1", orenId: "oren-1", schemaVersion: 1,
      occurredAt: "2026-07-26T00:00:00.000Z", recordedAt: "2026-07-26T00:00:00.000Z",
      source: "test", causationId: null, correlationId: "c1",
      payload: { type: "MemoryForgotten", memoryId: "m1", reason: "r" },
    };
    const next = reduceLifeState(state, envelope);
    expect(next.version).toBe(1);
    expect(next.attention).toEqual(state.attention);
  });
});

describe("LifeActor memory proposal mapping", () => {
  function makeActor(committed: EventEnvelope[][]): {
    actor: LifeActor; job: CognitionJob;
  } {
    let ids = 0;
    const state: { current: LifeState } = {
      current: { ...createInitialLifeState("oren-1", "person-1"), version: 7 },
    };
    const actor = new LifeActor(
      {
        loadState: () => state.current,
        commit: (_orenId, events) => { committed.push([...events]); },
        commitIfVersion: () => true,
        commitInbox: () => true,
      },
      () => `id-${ids += 1}`,
      () => "2026-07-26T00:00:00.000Z",
    );
    const job: CognitionJob = {
      orenId: "oren-1", episodeId: "ep-1", baseStateVersion: 7,
      triggerKind: "foreground_user", correlationId: "corr-1",
    };
    return { actor, job };
  }

  it("maps Remember/ReviseBelief/Forget to memory events with generated memoryId", () => {
    const committed: EventEnvelope[][] = [];
    const { actor, job } = makeActor(committed);
    const result = actor.acceptCognition(job, [
      { type: "Remember", text: "判断：早跑改善了状态", kind: "oren_judgment", confidence: 0.7 },
      { type: "ReviseBelief", memoryId: "m-old", confidence: 0.1, reason: "已失效" },
      { type: "Forget", memoryId: "m-noise", reason: "无跨时间价值" },
    ]);
    expect(result.accepted).toBe(true);
    const payloads = committed[0]!.map(({ payload }) => payload);
    const remembered = payloads.find((payload) => payload.type === "MemoryRemembered");
    expect(remembered).toMatchObject({
      kind: "oren_judgment", text: "判断：早跑改善了状态", confidence: 0.7,
    });
    expect(remembered && "memoryId" in remembered && remembered.memoryId.length > 0).toBe(true);
    expect(payloads).toContainEqual({
      type: "BeliefRevised", memoryId: "m-old", confidence: 0.1, reason: "已失效",
    });
    expect(payloads).toContainEqual({
      type: "MemoryForgotten", memoryId: "m-noise", reason: "无跨时间价值",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/kernel/test/memory-protocol.test.ts`
Expected: FAIL（`canonicalizeProposal` 对 `Remember` 返回 undefined；类型错误先于运行时错误也算失败）。

- [ ] **Step 3: 实现协议扩展**

`packages/kernel/src/protocol.ts` — 在 `TriggerKind` 之后新增：

```typescript
export type MemoryKind =
  | "user_statement"
  | "external_fact"
  | "oren_judgment"
  | "oren_expression";
```

`Proposal` 联合类型追加三个成员：

```typescript
  | {
      readonly type: "Remember";
      readonly text: string;
      readonly kind: MemoryKind;
      readonly confidence?: number;
      readonly reviewCondition?: string;
      readonly threadId?: ThreadId;
    }
  | {
      readonly type: "ReviseBelief";
      readonly memoryId: string;
      readonly revisedText?: string;
      readonly confidence: number;
      readonly reason: string;
    }
  | { readonly type: "Forget"; readonly memoryId: string; readonly reason: string };
```

`CoreEvent` 联合类型追加三个成员：

```typescript
  | {
      readonly type: "MemoryRemembered";
      readonly memoryId: string;
      readonly kind: MemoryKind;
      readonly text: string;
      readonly confidence?: number;
      readonly reviewCondition?: string;
      readonly threadId?: ThreadId;
    }
  | {
      readonly type: "BeliefRevised";
      readonly memoryId: string;
      readonly revisedText?: string;
      readonly confidence: number;
      readonly reason: string;
    }
  | { readonly type: "MemoryForgotten"; readonly memoryId: string; readonly reason: string };
```

`packages/kernel/src/runtime-validation.ts` — 顶部常量区新增：

```typescript
const MEMORY_KINDS = new Set<unknown>([
  "user_statement",
  "external_fact",
  "oren_judgment",
  "oren_expression",
]);
const MAX_MEMORY_TEXT_LENGTH = 4_000;

function hasKeysWithin(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isConfidence(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonemptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMemoryText(value: JsonValue | undefined): value is string {
  return isNonemptyString(value) && value.length <= MAX_MEMORY_TEXT_LENGTH;
}
```

导入处补 `MemoryKind` 类型（`import type { ..., MemoryKind } from "./protocol.js"`）。

`canonicalizeProposal` 的 switch 新增三个 case（放在 `ScheduleWake` case 之后、`default` 之前）：

```typescript
    case "Remember": {
      if (
        !hasKeysWithin(proposal, ["type", "text", "kind"], ["confidence", "reviewCondition", "threadId"])
        || !isMemoryText(proposal.text)
        || !MEMORY_KINDS.has(proposal.kind)
        || (proposal.confidence !== undefined && !isConfidence(proposal.confidence))
        || (proposal.kind === "oren_judgment" && proposal.confidence === undefined)
        || (proposal.reviewCondition !== undefined && !isNonemptyString(proposal.reviewCondition))
        || (proposal.threadId !== undefined && !isNonemptyString(proposal.threadId))
      ) {
        return undefined;
      }
      return {
        type: "Remember",
        text: proposal.text,
        kind: proposal.kind as MemoryKind,
        ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
        ...(proposal.reviewCondition !== undefined
          ? { reviewCondition: proposal.reviewCondition }
          : {}),
        ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
      };
    }
    case "ReviseBelief": {
      if (
        !hasKeysWithin(proposal, ["type", "memoryId", "confidence", "reason"], ["revisedText"])
        || !isNonemptyString(proposal.memoryId)
        || !isConfidence(proposal.confidence)
        || !isNonemptyString(proposal.reason)
        || (proposal.revisedText !== undefined && !isMemoryText(proposal.revisedText))
      ) {
        return undefined;
      }
      return {
        type: "ReviseBelief",
        memoryId: proposal.memoryId,
        confidence: proposal.confidence,
        reason: proposal.reason,
        ...(proposal.revisedText !== undefined ? { revisedText: proposal.revisedText } : {}),
      };
    }
    case "Forget":
      return hasExactKeys(proposal, ["type", "memoryId", "reason"])
        && isNonemptyString(proposal.memoryId)
        && isNonemptyString(proposal.reason)
        ? { type: "Forget", memoryId: proposal.memoryId, reason: proposal.reason }
        : undefined;
```

`canonicalizeCoreEvent` 的 switch 新增三个 case（放在 `WakeDue` case 之后、`default` 之前）：

```typescript
    case "MemoryRemembered": {
      if (
        !hasKeysWithin(
          event,
          ["type", "memoryId", "kind", "text"],
          ["confidence", "reviewCondition", "threadId"],
        )
        || !isNonemptyString(event.memoryId)
        || !MEMORY_KINDS.has(event.kind)
        || !isMemoryText(event.text)
        || (event.confidence !== undefined && !isConfidence(event.confidence))
        || (event.kind === "oren_judgment" && event.confidence === undefined)
        || (event.reviewCondition !== undefined && !isNonemptyString(event.reviewCondition))
        || (event.threadId !== undefined && !isNonemptyString(event.threadId))
      ) {
        return undefined;
      }
      return {
        type: "MemoryRemembered",
        memoryId: event.memoryId,
        kind: event.kind as MemoryKind,
        text: event.text,
        ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
        ...(event.reviewCondition !== undefined
          ? { reviewCondition: event.reviewCondition }
          : {}),
        ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      };
    }
    case "BeliefRevised": {
      if (
        !hasKeysWithin(event, ["type", "memoryId", "confidence", "reason"], ["revisedText"])
        || !isNonemptyString(event.memoryId)
        || !isConfidence(event.confidence)
        || !isNonemptyString(event.reason)
        || (event.revisedText !== undefined && !isMemoryText(event.revisedText))
      ) {
        return undefined;
      }
      return {
        type: "BeliefRevised",
        memoryId: event.memoryId,
        confidence: event.confidence,
        reason: event.reason,
        ...(event.revisedText !== undefined ? { revisedText: event.revisedText } : {}),
      };
    }
    case "MemoryForgotten":
      return hasExactKeys(event, ["type", "memoryId", "reason"])
        && isNonemptyString(event.memoryId)
        && isNonemptyString(event.reason)
        ? { type: "MemoryForgotten", memoryId: event.memoryId, reason: event.reason }
        : undefined;
```

`packages/kernel/src/life-actor.ts` — `acceptCognition` 的 `flatMap` switch 中，在 `ScheduleWake` case 之后新增：

```typescript
        case "Remember":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "MemoryRemembered",
            memoryId: this.nextId(),
            kind: proposal.kind,
            text: proposal.text,
            ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
            ...(proposal.reviewCondition !== undefined
              ? { reviewCondition: proposal.reviewCondition }
              : {}),
            ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
          })];
        case "ReviseBelief":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "BeliefRevised",
            memoryId: proposal.memoryId,
            confidence: proposal.confidence,
            reason: proposal.reason,
            ...(proposal.revisedText !== undefined
              ? { revisedText: proposal.revisedText }
              : {}),
          })];
        case "Forget":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "MemoryForgotten",
            memoryId: proposal.memoryId,
            reason: proposal.reason,
          })];
```

注意：reducer（`packages/kernel/src/reducer.ts`）**不改**——三类新事件落入 `default` 分支，只递增版本，符合「记忆是投影不是核心状态」。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/kernel && npm run typecheck`
Expected: 全部 PASS（kernel 既有测试不回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): add Remember/ReviseBelief/Forget proposals and memory core events"
```

---

### Task 2: packages/memory — 投影与结构化召回（无向量）

**Files:**
- Create: `packages/memory/package.json`
- Create: `packages/memory/src/index.ts`
- Create: `packages/memory/src/types.ts`
- Create: `packages/memory/src/memory-index.ts`
- Modify: `scripts/prepare-dist.mjs`
- Test: `packages/memory/test/memory-index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MemoryKind` 与三类记忆事件；`EventEnvelope`（`@oren/kernel`）。
- Produces（后续任务依赖）:
  - `interface MemoryEntry { memoryId: string; orenId: string; kind: MemoryKind; text: string; sourceEventId: string; occurredAt: string; confidence: number | null; reviewCondition: string | null; threadId: string | null; recallability: "active" | "lowered" }`
  - `interface RecallQuery { orenId: string; text?: string; kinds?: readonly MemoryKind[]; threadId?: string; since?: string; until?: string; limit?: number; includeLowered?: boolean }`
  - `interface EventRecord { sequence: number; envelope: EventEnvelope }`
  - `interface MemoryPort { project(records: readonly EventRecord[]): Promise<void>; recall(query: RecallQuery): Promise<readonly MemoryEntry[]>; rebuild(loadAll: () => readonly EventRecord[]): Promise<void>; cursor(): number }`
  - `interface EmbeddingPort { embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>> }`（本任务只定义类型，Task 3 实现）
  - `class SqliteMemoryIndex implements MemoryPort`，构造 `new SqliteMemoryIndex(db: DatabaseSync, options?: { embedder?: EmbeddingPort; now?: () => number })`

- [ ] **Step 1: 包脚手架**

`packages/memory/package.json`：

```json
{
  "name": "@oren/memory",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/kernel": "*"
  }
}
```

`scripts/prepare-dist.mjs` 的 `packages` 数组中、`["kernel", "packages/kernel"]` 之后插入一行：

```javascript
  ["memory", "packages/memory"],
```

`packages/memory/src/index.ts`：

```typescript
export * from "./types.js";
export * from "./memory-index.js";
```

（Task 3、4 会向 index.ts 追加导出。）

- [ ] **Step 2: 写失败测试**

`packages/memory/test/memory-index.test.ts`：

```typescript
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CoreEvent, EventEnvelope } from "@oren/kernel";
import { SqliteMemoryIndex, type EventRecord } from "@oren/memory";

let eventCounter = 0;

function record(
  sequence: number,
  payload: CoreEvent,
  occurredAt = "2026-07-20T00:00:00.000Z",
): EventRecord {
  eventCounter += 1;
  const envelope: EventEnvelope = {
    eventId: `evt-${eventCounter}`,
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt,
    recordedAt: occurredAt,
    source: "test",
    causationId: null,
    correlationId: "corr-1",
    payload,
  };
  return { sequence, envelope };
}

function makeIndex(): SqliteMemoryIndex {
  return new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
    now: () => Date.parse("2026-07-26T00:00:00.000Z"),
  });
}

describe("SqliteMemoryIndex projection", () => {
  it("projects user messages, expressions, and thread advances", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "UserMessageReceived", personId: "p1", text: "我在准备一场演讲" }),
      record(2, {
        type: "CognitionCompleted",
        episodeId: "ep1",
        baseStateVersion: 1,
        proposals: [
          { type: "ExpressToUser", text: "听起来很重要，主题是什么？", reason: "回应" },
          { type: "NoAction", reason: "-" },
        ],
      }),
      record(3, { type: "ThreadAdvanced", threadId: "t1", summary: "了解演讲主题" }),
    ]);
    const entries = await index.recall({ orenId: "oren-1", limit: 10 });
    expect(entries).toHaveLength(3);
    expect(entries.map(({ kind }) => kind).sort()).toEqual(
      ["oren_expression", "oren_judgment", "user_statement"],
    );
    expect(index.cursor()).toBe(3);
  });

  it("projects explicit memory events and applies revise/forget", async () => {
    const index = makeIndex();
    await index.project([
      record(1, {
        type: "MemoryRemembered", memoryId: "m1", kind: "oren_judgment",
        text: "判断：用户可能换工作", confidence: 0.7,
      }),
    ]);
    await index.project([
      record(2, {
        type: "BeliefRevised", memoryId: "m1", confidence: 0.1,
        revisedText: "判断已修订：用户决定留下", reason: "用户明确表态",
      }),
    ]);
    const [revised] = await index.recall({ orenId: "oren-1" });
    expect(revised).toMatchObject({
      memoryId: "m1", text: "判断已修订：用户决定留下", confidence: 0.1,
    });

    await index.project([
      record(3, { type: "MemoryForgotten", memoryId: "m1", reason: "已过时" }),
    ]);
    expect(await index.recall({ orenId: "oren-1" })).toHaveLength(0);
    const lowered = await index.recall({ orenId: "oren-1", includeLowered: true });
    expect(lowered[0]).toMatchObject({ memoryId: "m1", recallability: "lowered" });
  });

  it("skips revise/forget referencing unknown memoryId without throwing", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "BeliefRevised", memoryId: "ghost", confidence: 0.5, reason: "r" }),
      record(2, { type: "MemoryForgotten", memoryId: "ghost", reason: "r" }),
    ]);
    expect(await index.recall({ orenId: "oren-1", includeLowered: true })).toHaveLength(0);
    expect(index.cursor()).toBe(2);
  });

  it("filters by kind, thread, time range, and honors limit + keyword", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "UserMessageReceived", personId: "p1", text: "聊聊天气" },
        "2026-07-01T00:00:00.000Z"),
      record(2, { type: "UserMessageReceived", personId: "p1", text: "演讲的事有进展" },
        "2026-07-20T00:00:00.000Z"),
      record(3, { type: "ThreadAdvanced", threadId: "talk", summary: "演讲准备" },
        "2026-07-21T00:00:00.000Z"),
    ]);
    expect(await index.recall({ orenId: "oren-1", kinds: ["user_statement"] }))
      .toHaveLength(2);
    expect(await index.recall({ orenId: "oren-1", threadId: "talk" })).toHaveLength(1);
    expect(await index.recall({ orenId: "oren-1", since: "2026-07-10T00:00:00.000Z" }))
      .toHaveLength(2);
    const byKeyword = await index.recall({ orenId: "oren-1", text: "演讲", limit: 1 });
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0]!.text).toContain("演讲");
  });

  it("is idempotent per sequence and rebuild matches incremental projection", async () => {
    const index = makeIndex();
    const records = [
      record(1, { type: "UserMessageReceived", personId: "p1", text: "第一条" }),
      record(2, {
        type: "MemoryRemembered", memoryId: "m1", kind: "external_fact", text: "事实一",
      }),
      record(3, { type: "MemoryForgotten", memoryId: "m1", reason: "r" }),
    ];
    await index.project(records);
    await index.project(records); // 重复投影不重复写
    const incremental = await index.recall({ orenId: "oren-1", includeLowered: true });

    await index.rebuild(() => records);
    const rebuilt = await index.recall({ orenId: "oren-1", includeLowered: true });
    expect(rebuilt).toEqual(incremental);
    expect(index.cursor()).toBe(3);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/memory`
Expected: FAIL（模块 `@oren/memory` 缺 `SqliteMemoryIndex` 实现）。

- [ ] **Step 4: 实现**

`packages/memory/src/types.ts`：

```typescript
import type { EventEnvelope, MemoryKind } from "@oren/kernel";

export interface MemoryEntry {
  readonly memoryId: string;
  readonly orenId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly confidence: number | null;
  readonly reviewCondition: string | null;
  readonly threadId: string | null;
  readonly recallability: "active" | "lowered";
}

export interface RecallQuery {
  readonly orenId: string;
  readonly text?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly threadId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly includeLowered?: boolean;
}

export interface EventRecord {
  readonly sequence: number;
  readonly envelope: EventEnvelope;
}

export interface MemoryPort {
  project(records: readonly EventRecord[]): Promise<void>;
  recall(query: RecallQuery): Promise<readonly MemoryEntry[]>;
  rebuild(loadAll: () => readonly EventRecord[]): Promise<void>;
  cursor(): number;
}

export interface EmbeddingPort {
  embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>>;
}
```

`packages/memory/src/memory-index.ts`：

```typescript
import type { DatabaseSync } from "node:sqlite";
import type { EventEnvelope, MemoryKind } from "@oren/kernel";
import type {
  EmbeddingPort,
  EventRecord,
  MemoryEntry,
  MemoryPort,
  RecallQuery,
} from "./types.js";

const DEFAULT_LIMIT = 10;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const AUTO_JUDGMENT_CONFIDENCE = 0.5;

export interface SqliteMemoryIndexOptions {
  readonly embedder?: EmbeddingPort;
  readonly now?: () => number;
}

interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
}

export class SqliteMemoryIndex implements MemoryPort {
  private readonly embedder: EmbeddingPort | undefined;
  private readonly now: () => number;
  private cursorValue: number;

  public constructor(
    private readonly db: DatabaseSync,
    options: SqliteMemoryIndexOptions = {},
  ) {
    this.embedder = options.embedder;
    this.now = options.now ?? Date.now;
    this.ensureSchema();
    this.cursorValue = this.loadCursor();
  }

  public cursor(): number {
    return this.cursorValue;
  }

  public async project(records: readonly EventRecord[]): Promise<void> {
    for (const record of records) {
      if (record.sequence <= this.cursorValue) continue;
      await this.projectEnvelope(record.envelope);
      this.cursorValue = record.sequence;
      this.saveCursor();
    }
  }

  public async rebuild(loadAll: () => readonly EventRecord[]): Promise<void> {
    this.db.prepare("DELETE FROM memory_entries").run();
    this.cursorValue = 0;
    this.saveCursor();
    await this.project(loadAll());
  }

  public async recall(query: RecallQuery): Promise<readonly MemoryEntry[]> {
    const limit = query.limit !== undefined
      && Number.isSafeInteger(query.limit)
      && query.limit > 0
      ? query.limit
      : DEFAULT_LIMIT;
    const conditions = ["oren_id = ?"];
    const parameters: Array<string | number> = [query.orenId];
    if (query.includeLowered !== true) {
      conditions.push("recallability = 'active'");
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      conditions.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
      parameters.push(...query.kinds);
    }
    if (query.threadId !== undefined) {
      conditions.push("thread_id = ?");
      parameters.push(query.threadId);
    }
    if (query.since !== undefined) {
      conditions.push("occurred_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("occurred_at <= ?");
      parameters.push(query.until);
    }
    const rows = this.db.prepare(`
      SELECT memory_id, oren_id, kind, text, source_event_id, occurred_at,
             confidence, review_condition, thread_id, recallability, embedding_json
      FROM memory_entries
      WHERE ${conditions.join(" AND ")}
    `).all(...parameters);

    const queryVector = query.text !== undefined && this.embedder !== undefined
      ? (await this.embedder.embed([query.text]))[0]
      : undefined;

    const scored: ScoredEntry[] = rows.map((row) => {
      const entry = rowToEntry(row);
      const embedding = row.embedding_json === null
        ? undefined
        : JSON.parse(String(row.embedding_json)) as number[];
      let relevance: number;
      if (query.text === undefined) {
        relevance = 1;
      } else if (queryVector !== undefined && embedding !== undefined) {
        relevance = cosine(queryVector, embedding);
      } else {
        relevance = entry.text.includes(query.text) ? 1 : 0;
      }
      return { entry, score: relevance * this.recencyFactor(entry.occurredAt) };
    });

    scored.sort((left, right) =>
      right.score - left.score
      || right.entry.occurredAt.localeCompare(left.entry.occurredAt)
      || left.entry.memoryId.localeCompare(right.entry.memoryId));
    return scored.slice(0, limit).map(({ entry }) => entry);
  }

  private recencyFactor(occurredAt: string): number {
    const age = Math.max(0, this.now() - Date.parse(occurredAt));
    return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  }

  private async projectEnvelope(envelope: EventEnvelope): Promise<void> {
    const { payload } = envelope;
    switch (payload.type) {
      case "UserMessageReceived":
        await this.upsertEntry({
          memoryId: `mem:${envelope.eventId}`,
          orenId: envelope.orenId,
          kind: "user_statement",
          text: payload.text,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: null,
          reviewCondition: null,
          threadId: null,
          recallability: "active",
        });
        return;
      case "ThreadAdvanced":
        await this.upsertEntry({
          memoryId: `mem:${envelope.eventId}`,
          orenId: envelope.orenId,
          kind: "oren_judgment",
          text: `线索「${payload.threadId}」推进：${payload.summary}`,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: AUTO_JUDGMENT_CONFIDENCE,
          reviewCondition: null,
          threadId: payload.threadId,
          recallability: "active",
        });
        return;
      case "CognitionCompleted": {
        for (const [proposalIndex, proposal] of payload.proposals.entries()) {
          if (proposal.type !== "ExpressToUser") continue;
          await this.upsertEntry({
            memoryId: `mem:${envelope.eventId}:express:${proposalIndex}`,
            orenId: envelope.orenId,
            kind: "oren_expression",
            text: proposal.text,
            sourceEventId: envelope.eventId,
            occurredAt: envelope.occurredAt,
            confidence: null,
            reviewCondition: null,
            threadId: null,
            recallability: "active",
          });
        }
        return;
      }
      case "MemoryRemembered":
        await this.upsertEntry({
          memoryId: payload.memoryId,
          orenId: envelope.orenId,
          kind: payload.kind,
          text: payload.text,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: payload.confidence ?? null,
          reviewCondition: payload.reviewCondition ?? null,
          threadId: payload.threadId ?? null,
          recallability: "active",
        });
        return;
      case "BeliefRevised": {
        const existing = this.db.prepare(`
          SELECT text FROM memory_entries WHERE memory_id = ? AND oren_id = ?
        `).get(payload.memoryId, envelope.orenId);
        if (!existing) return; // 未知引用：入史不投影
        const text = payload.revisedText ?? String(existing.text);
        const embedding = await this.embeddingJson(text);
        this.db.prepare(`
          UPDATE memory_entries
          SET text = ?, confidence = ?, embedding_json = ?
          WHERE memory_id = ? AND oren_id = ?
        `).run(text, payload.confidence, embedding, payload.memoryId, envelope.orenId);
        return;
      }
      case "MemoryForgotten":
        this.db.prepare(`
          UPDATE memory_entries SET recallability = 'lowered'
          WHERE memory_id = ? AND oren_id = ?
        `).run(payload.memoryId, envelope.orenId);
        return;
      default:
        return;
    }
  }

  private async upsertEntry(entry: MemoryEntry): Promise<void> {
    const embedding = await this.embeddingJson(entry.text);
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_entries(
        memory_id, oren_id, kind, text, source_event_id, occurred_at,
        confidence, review_condition, thread_id, recallability, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.memoryId,
      entry.orenId,
      entry.kind,
      entry.text,
      entry.sourceEventId,
      entry.occurredAt,
      entry.confidence,
      entry.reviewCondition,
      entry.threadId,
      entry.recallability,
      embedding,
    );
  }

  private async embeddingJson(text: string): Promise<string | null> {
    if (this.embedder === undefined) return null;
    const [vector] = await this.embedder.embed([text]);
    return vector === undefined ? null : JSON.stringify(vector);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        memory_id TEXT PRIMARY KEY,
        oren_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        confidence REAL,
        review_condition TEXT,
        thread_id TEXT,
        recallability TEXT NOT NULL DEFAULT 'active'
          CHECK(recallability IN ('active', 'lowered')),
        embedding_json TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_entries_by_oren
      ON memory_entries(oren_id, occurred_at);
      CREATE TABLE IF NOT EXISTS memory_projection_cursor (
        id TEXT PRIMARY KEY CHECK(id = 'global'),
        last_sequence INTEGER NOT NULL
      );
    `);
  }

  private loadCursor(): number {
    const row = this.db.prepare(`
      SELECT last_sequence FROM memory_projection_cursor WHERE id = 'global'
    `).get();
    return row ? Number(row.last_sequence) : 0;
  }

  private saveCursor(): void {
    this.db.prepare(`
      INSERT INTO memory_projection_cursor(id, last_sequence) VALUES ('global', ?)
      ON CONFLICT(id) DO UPDATE SET last_sequence = excluded.last_sequence
    `).run(this.cursorValue);
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    memoryId: String(row.memory_id),
    orenId: String(row.oren_id),
    kind: String(row.kind) as MemoryKind,
    text: String(row.text),
    sourceEventId: String(row.source_event_id),
    occurredAt: String(row.occurred_at),
    confidence: row.confidence === null ? null : Number(row.confidence),
    reviewCondition: row.review_condition === null ? null : String(row.review_condition),
    threadId: row.thread_id === null ? null : String(row.thread_id),
    recallability: String(row.recallability) === "lowered" ? "lowered" : "active",
  };
}

export function cosine(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    normLeft += left[index]! * left[index]!;
    normRight += right[index]! * right[index]!;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/memory && npm run typecheck && npm run build`
Expected: 全部 PASS；build 后 `dist/node_modules/@oren/memory` 符号链接存在。

- [ ] **Step 6: Commit**

```bash
git add packages/memory scripts/prepare-dist.mjs
git commit -m "feat(memory): add SqliteMemoryIndex projection with structured recall and rebuild"
```

---

### Task 3: memory 向量层 — FakeEmbedder、向量排序与凭据门控 embedding 配置

**Files:**
- Create: `packages/memory/src/fake-embedder.ts`
- Create: `packages/memory/src/embedding-config.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/test/memory-vector.test.ts`
- Test: `packages/memory/test/embedding-config.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SqliteMemoryIndex`、`EmbeddingPort`、`cosine`。
- Produces:
  - `class FakeEmbedder implements EmbeddingPort`，构造 `new FakeEmbedder(dimensions = 64)`，确定性（同文本同向量）。
  - `EMBEDDING_PROVIDER_ENV = "OREN_EMBEDDING_PROVIDER"`、`EMBEDDING_MODEL_ENV = "OREN_EMBEDDING_MODEL"`、`EMBEDDING_BASE_URL_ENV = "OREN_EMBEDDING_BASE_URL"`
  - `type EmbeddingConfigResult = { ok: true; embedder: EmbeddingPort } | { ok: false; kind: "unconfigured" | "invalid"; reason: string }`
  - `function resolveEmbeddingConfig(env: Readonly<Record<string, string | undefined>>): EmbeddingConfigResult`（不发网络请求；仅装配）

- [ ] **Step 1: 写失败测试**

`packages/memory/test/memory-vector.test.ts`：

```typescript
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CoreEvent, EventEnvelope } from "@oren/kernel";
import { cosine, FakeEmbedder, SqliteMemoryIndex, type EventRecord } from "@oren/memory";

let counter = 0;
function userMessage(sequence: number, text: string): EventRecord {
  counter += 1;
  const payload: CoreEvent = { type: "UserMessageReceived", personId: "p1", text };
  const envelope: EventEnvelope = {
    eventId: `evt-${counter}`, orenId: "oren-1", schemaVersion: 1,
    occurredAt: "2026-07-20T00:00:00.000Z", recordedAt: "2026-07-20T00:00:00.000Z",
    source: "test", causationId: null, correlationId: "c1", payload,
  };
  return { sequence, envelope };
}

describe("FakeEmbedder", () => {
  it("is deterministic and shape-stable", async () => {
    const embedder = new FakeEmbedder();
    const [first] = await embedder.embed(["城市步行系统"]);
    const [second] = await embedder.embed(["城市步行系统"]);
    expect(first).toEqual(second);
    expect(first!.length).toBe(64);
  });

  it("scores overlapping text closer than unrelated text", async () => {
    const embedder = new FakeEmbedder();
    const [query, related, unrelated] = await embedder.embed([
      "关于演讲的进展",
      "演讲的事有进展",
      "今天的天气很好",
    ]);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });
});

describe("vector recall", () => {
  it("ranks semantically related entries first with an embedder", async () => {
    const index = new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
      embedder: new FakeEmbedder(),
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    await index.project([
      userMessage(1, "今天的天气很好"),
      userMessage(2, "演讲的事有进展"),
    ]);
    const results = await index.recall({ orenId: "oren-1", text: "关于演讲的进展", limit: 2 });
    expect(results[0]!.text).toBe("演讲的事有进展");
  });

  it("degrades to keyword + recency when no embedder is configured", async () => {
    const index = new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    await index.project([
      userMessage(1, "今天的天气很好"),
      userMessage(2, "演讲的事有进展"),
    ]);
    const results = await index.recall({ orenId: "oren-1", text: "演讲", limit: 2 });
    expect(results[0]!.text).toBe("演讲的事有进展");
  });
});
```

`packages/memory/test/embedding-config.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import {
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  resolveEmbeddingConfig,
} from "@oren/memory";

describe("resolveEmbeddingConfig", () => {
  it("reports unconfigured when provider/model are missing", () => {
    const result = resolveEmbeddingConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unconfigured");
      expect(result.reason).toContain(EMBEDDING_PROVIDER_ENV);
      expect(result.reason).toContain(EMBEDDING_MODEL_ENV);
    }
  });

  it("rejects unknown providers", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "nope",
      [EMBEDDING_MODEL_ENV]: "m",
    });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("requires the provider API key with an actionable message", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "openai",
      [EMBEDDING_MODEL_ENV]: "text-embedding-3-small",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid");
      expect(result.reason).toContain("OPENAI_API_KEY");
    }
  });

  it("returns an embedder when fully configured (no network call)", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "openai",
      [EMBEDDING_MODEL_ENV]: "text-embedding-3-small",
      OPENAI_API_KEY: "sk-test",
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/memory`
Expected: 新增两个文件 FAIL（导出不存在）。

- [ ] **Step 3: 实现**

`packages/memory/src/fake-embedder.ts`：

```typescript
import { createHash } from "node:crypto";
import type { EmbeddingPort } from "./types.js";

/**
 * 确定性假 embedder：字符 bigram 哈希词袋。共享子串越多，余弦越高。
 * 只用于离线测试与开发，不代表真实语义质量。
 */
export class FakeEmbedder implements EmbeddingPort {
  public constructor(private readonly dimensions = 64) {}

  public async embed(
    texts: readonly string[],
  ): Promise<ReadonlyArray<readonly number[]>> {
    return texts.map((text) => this.vector(text));
  }

  private vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (let index = 0; index < text.length; index += 1) {
      const gram = text.slice(index, index + 2);
      const digest = createHash("sha256").update(gram).digest();
      const bucket = ((digest[0]! << 8) | digest[1]!) % this.dimensions;
      vector[bucket]! += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}
```

`packages/memory/src/embedding-config.ts`：

```typescript
import type { EmbeddingPort } from "./types.js";

export const EMBEDDING_PROVIDER_ENV = "OREN_EMBEDDING_PROVIDER";
export const EMBEDDING_MODEL_ENV = "OREN_EMBEDDING_MODEL";
export const EMBEDDING_BASE_URL_ENV = "OREN_EMBEDDING_BASE_URL";

interface ProviderInfo {
  readonly baseUrl: string | undefined;
  readonly keyEnvVars: readonly string[];
}

const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnvVars: ["OPENAI_API_KEY"] },
  // 任何 OpenAI 兼容端点：必须提供 OREN_EMBEDDING_BASE_URL
  "openai-compatible": { baseUrl: undefined, keyEnvVars: ["OREN_EMBEDDING_API_KEY"] },
};

export type EmbeddingConfigResult =
  | { readonly ok: true; readonly embedder: EmbeddingPort }
  | { readonly ok: false; readonly kind: "unconfigured" | "invalid"; readonly reason: string };

export function resolveEmbeddingConfig(
  env: Readonly<Record<string, string | undefined>>,
): EmbeddingConfigResult {
  const provider = env[EMBEDDING_PROVIDER_ENV]?.trim();
  const model = env[EMBEDDING_MODEL_ENV]?.trim();
  if (!provider || !model) {
    const missing = [
      !provider ? EMBEDDING_PROVIDER_ENV : null,
      !model ? EMBEDDING_MODEL_ENV : null,
    ].filter((name): name is string => name !== null);
    return {
      ok: false,
      kind: "unconfigured",
      reason: `Vector recall is disabled. Set ${missing.join(" and ")} `
        + `(plus the provider's API key env var) to enable it.`,
    };
  }
  const info = PROVIDERS[provider];
  if (!info) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Unknown embedding provider "${provider}". `
        + `Known providers: ${Object.keys(PROVIDERS).join(", ")}.`,
    };
  }
  const baseUrl = env[EMBEDDING_BASE_URL_ENV]?.trim() || info.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Provider "${provider}" requires ${EMBEDDING_BASE_URL_ENV}.`,
    };
  }
  const apiKey = info.keyEnvVars.map((name) => env[name]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!apiKey) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Missing API key for embedding provider "${provider}". `
        + `Set one of: ${info.keyEnvVars.join(", ")}.`,
    };
  }
  return { ok: true, embedder: new HttpEmbedder(baseUrl, model, apiKey) };
}

class HttpEmbedder implements EmbeddingPort {
  public constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  public async embed(
    texts: readonly string[],
  ): Promise<ReadonlyArray<readonly number[]>> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.json() as {
      data?: ReadonlyArray<{ embedding?: readonly number[] }>;
    };
    const vectors = (body.data ?? []).map(({ embedding }) => embedding);
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new Error("Embedding response shape is invalid");
    }
    return vectors as ReadonlyArray<readonly number[]>;
  }
}
```

`packages/memory/src/index.ts` 追加：

```typescript
export * from "./fake-embedder.js";
export * from "./embedding-config.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/memory && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/memory
git commit -m "feat(memory): add fake embedder, vector-ranked recall, and gated embedding config"
```

---

### Task 4: memory.recall 内置扩展

**Files:**
- Create: `packages/memory/src/recall-extension.ts`
- Modify: `packages/memory/src/index.ts`
- Modify: `packages/memory/package.json`
- Test: `packages/memory/test/recall-extension.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MemoryPort` / `RecallQuery`；`OrenExtension`（`@oren/extensions`）。
- Produces: `function createMemoryRecallExtension(memory: MemoryPort): OrenExtension`——manifest id `"memory"`，能力名 `"memory.recall"`，traits `["read_only", "replay_safe"]`（即时通道），`permissionRequirements: []`（不需要 grant）。

- [ ] **Step 1: 依赖声明**

`packages/memory/package.json` 的 `dependencies` 增加：

```json
    "@oren/extensions": "*"
```

- [ ] **Step 2: 写失败测试**

`packages/memory/test/recall-extension.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { isImmediateCapability } from "@oren/kernel";
import {
  createMemoryRecallExtension,
  type MemoryEntry,
  type RecallQuery,
} from "@oren/memory";

const ENTRY: MemoryEntry = {
  memoryId: "m1", orenId: "oren-1", kind: "user_statement",
  text: "我在准备演讲", sourceEventId: "e1",
  occurredAt: "2026-07-20T00:00:00.000Z",
  confidence: null, reviewCondition: null, threadId: null, recallability: "active",
};

function makeExtension(queries: RecallQuery[]) {
  return createMemoryRecallExtension({
    project: async () => {},
    rebuild: async () => {},
    cursor: () => 0,
    recall: async (query) => { queries.push(query); return [ENTRY]; },
  });
}

describe("createMemoryRecallExtension", () => {
  it("exposes memory.recall as an immediate capability without grants", () => {
    const extension = makeExtension([]);
    const [descriptor] = extension.manifest.capabilities;
    expect(descriptor!.name).toBe("memory.recall");
    expect(descriptor!.permissionRequirements).toEqual([]);
    expect(isImmediateCapability(descriptor!)).toBe(true);
  });

  it("parses arguments into a RecallQuery scoped to the invoking oren", async () => {
    const queries: RecallQuery[] = [];
    const extension = makeExtension(queries);
    const result = await extension.invoke({
      effectId: "ef1", orenId: "oren-1", capability: "memory.recall",
      arguments: { text: "演讲", kinds: ["user_statement"], limit: 3 },
      grantIds: [], stateVersion: 1, deadline: "2026-07-26T00:00:01.000Z",
    }, new AbortController().signal);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual([expect.objectContaining({ memoryId: "m1" })]);
    }
    expect(queries[0]).toMatchObject({
      orenId: "oren-1", text: "演讲", kinds: ["user_statement"], limit: 3,
    });
  });

  it("rejects malformed arguments instead of throwing", async () => {
    const extension = makeExtension([]);
    const result = await extension.invoke({
      effectId: "ef1", orenId: "oren-1", capability: "memory.recall",
      arguments: { kinds: ["diary"] },
      grantIds: [], stateVersion: 1, deadline: "2026-07-26T00:00:01.000Z",
    }, new AbortController().signal);
    expect(result.status).toBe("failed");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/memory/test/recall-extension.test.ts`
Expected: FAIL（`createMemoryRecallExtension` 不存在）。

- [ ] **Step 4: 实现**

`packages/memory/src/recall-extension.ts`：

```typescript
import type { OrenExtension } from "@oren/extensions";
import type { JsonObject, JsonValue, MemoryKind } from "@oren/kernel";
import type { MemoryPort, RecallQuery } from "./types.js";

const MEMORY_KIND_VALUES = [
  "user_statement",
  "external_fact",
  "oren_judgment",
  "oren_expression",
] as const;
const MEMORY_KINDS = new Set<string>(MEMORY_KIND_VALUES);

export function createMemoryRecallExtension(memory: MemoryPort): OrenExtension {
  return {
    manifest: {
      id: "memory",
      version: "1.0.0",
      protocolVersion: 1,
      eventSources: [],
      capabilities: [{
        extensionId: "memory",
        name: "memory.recall",
        description: "召回过往记忆：可按语义文本、类型、线索与时间过滤；"
          + "默认不包含已降低可召回性的条目（includeLowered 可显式包含）。",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "语义查询文本" },
            kinds: {
              type: "array",
              items: { type: "string", enum: [...MEMORY_KIND_VALUES] },
            },
            threadId: { type: "string" },
            since: { type: "string", description: "ISO 时间下界" },
            until: { type: "string", description: "ISO 时间上界" },
            limit: { type: "number" },
            includeLowered: { type: "boolean" },
          },
          additionalProperties: false,
        },
        outputSchema: { type: "array" },
        permissionRequirements: [],
        traits: ["read_only", "replay_safe"],
        cancellable: true,
        timeoutMs: 5_000,
      }],
    },
    async activate() {},
    async deactivate() {},
    async invoke(invocation) {
      const query = parseQuery(invocation.orenId, invocation.arguments);
      if (query === undefined) {
        return {
          status: "failed",
          code: "invalid_arguments",
          message: "memory.recall arguments do not match the input schema",
        };
      }
      const entries = await memory.recall(query);
      return {
        status: "completed",
        output: entries as unknown as JsonValue,
        receipt: { count: entries.length },
      };
    },
  };
}

function parseQuery(orenId: string, args: JsonObject): RecallQuery | undefined {
  const allowed = new Set([
    "text",
    "kinds",
    "threadId",
    "since",
    "until",
    "limit",
    "includeLowered",
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const { text, kinds, threadId, since, until, limit, includeLowered } = args;
  if (text !== undefined && typeof text !== "string") return undefined;
  if (kinds !== undefined && (
    !Array.isArray(kinds)
    || kinds.some((kind) => typeof kind !== "string" || !MEMORY_KINDS.has(kind))
  )) {
    return undefined;
  }
  if (threadId !== undefined && typeof threadId !== "string") return undefined;
  if (since !== undefined && typeof since !== "string") return undefined;
  if (until !== undefined && typeof until !== "string") return undefined;
  if (limit !== undefined
    && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
    return undefined;
  }
  if (includeLowered !== undefined && typeof includeLowered !== "boolean") return undefined;
  return {
    orenId,
    ...(text !== undefined ? { text } : {}),
    ...(kinds !== undefined ? { kinds: kinds as readonly MemoryKind[] } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(includeLowered !== undefined ? { includeLowered } : {}),
  };
}
```

`packages/memory/src/index.ts` 追加：

```typescript
export * from "./recall-extension.js";
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/memory && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/memory
git commit -m "feat(memory): expose memory.recall as a built-in immediate extension"
```

---

### Task 5: cognition — LifeFrame.memoryPins 与异步 frame 输入

**Files:**
- Modify: `packages/cognition/src/types.ts`
- Modify: `packages/cognition/src/life-frame.ts`
- Modify: `packages/app/src/cognition-worker.ts`
- Modify: `packages/evals/src/scenarios.ts`（frame 基础字段）
- Modify: `packages/pi-cognition/test/fixtures.ts`（frame 基础字段）
- Test: `packages/cognition/test/life-frame-pins.test.ts`

**Interfaces:**
- Consumes: `MemoryKind`（`@oren/kernel`，Task 1）。
- Produces:
  - `interface MemoryPin { memoryId: string; kind: MemoryKind; text: string; confidence: number | null; occurredAt: string }`（`@oren/cognition` 导出）
  - `LifeFrame` 新增必填字段 `readonly memoryPins: readonly MemoryPin[]`
  - `CreateFrameInput` 新增可选字段 `readonly memoryPins?: readonly MemoryPin[]`（缺省 `[]`，最多取前 5 条）
  - `CognitionWorker` 构造参数 `loadFrameInput` 类型放宽为 `(job: CognitionJob) => CreateFrameInput | Promise<CreateFrameInput>`，两处调用改为 `await`

- [ ] **Step 1: 写失败测试**

`packages/cognition/test/life-frame-pins.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import { createLifeFrame, type MemoryPin } from "@oren/cognition";

const PIN: MemoryPin = {
  memoryId: "m1", kind: "oren_judgment", text: "判断：用户在准备演讲",
  confidence: 0.6, occurredAt: "2026-07-20T00:00:00.000Z",
};

describe("createLifeFrame memory pins", () => {
  it("defaults to no pins and caps pins at five", () => {
    const base = {
      state: createInitialLifeState("oren-1", "person-1"),
      correlationId: "c1",
      trigger: { kind: "foreground_user" as const, summary: "hi" },
      capabilities: [],
      maxSteps: 8,
    };
    expect(createLifeFrame(base).memoryPins).toEqual([]);
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...PIN, memoryId: `m${index}`,
    }));
    const frame = createLifeFrame({ ...base, memoryPins: many });
    expect(frame.memoryPins).toHaveLength(5);
    expect(frame.memoryPins[0]!.memoryId).toBe("m0");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cognition`
Expected: FAIL（`MemoryPin` 不存在 / `memoryPins` 字段缺失）。

- [ ] **Step 3: 实现**

`packages/cognition/src/types.ts` — import 增加 `MemoryKind`；新增类型并给 `LifeFrame` 加字段：

```typescript
export interface MemoryPin {
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly confidence: number | null;
  readonly occurredAt: string;
}
```

`LifeFrame` 中 `capabilities` 之前插入：

```typescript
  readonly memoryPins: readonly MemoryPin[];
```

`packages/cognition/src/life-frame.ts` — `CreateFrameInput` 增加：

```typescript
  readonly memoryPins?: readonly MemoryPin[];
```

（import `MemoryPin` from `./types.js`。）`createLifeFrame` 返回对象中 `capabilities` 之前插入：

```typescript
    memoryPins: (input.memoryPins ?? []).slice(0, 5).map((pin) => ({
      memoryId: pin.memoryId,
      kind: pin.kind,
      text: pin.text,
      confidence: pin.confidence,
      occurredAt: pin.occurredAt,
    })),
```

`packages/app/src/cognition-worker.ts` — 构造参数改为：

```typescript
    private readonly loadFrameInput: (
      job: CognitionJob,
    ) => CreateFrameInput | Promise<CreateFrameInput>,
```

两处调用（`const initialInput = this.loadFrameInput(activeJob);` 与 `frameInput = this.loadFrameInput(activeJob);`）分别改为：

```typescript
      const initialInput = await this.loadFrameInput(activeJob);
```

```typescript
        frameInput = await this.loadFrameInput(activeJob);
```

修复类型破坏（`LifeFrame` 增加了必填字段）——已知两处 frame 字面量构造需补 `memoryPins: []`：

1. `packages/evals/src/scenarios.ts` 的 `frame()` 帮助函数，在 `capabilities` 行之前加：

```typescript
    memoryPins: [],
```

2. `packages/pi-cognition/test/fixtures.ts` 中构造 `LifeFrame` 的地方同样加 `memoryPins: []`。

然后运行 `npm run typecheck`，如仍有其他 frame 字面量报缺 `memoryPins`，逐一补 `memoryPins: []`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS（全仓测试，确认 worker 改动无回归）。

- [ ] **Step 5: Commit**

```bash
git add packages/cognition packages/app packages/evals packages/pi-cognition
git commit -m "feat(cognition): add LifeFrame.memoryPins and async frame input loading"
```

---

### Task 6: app — LifeRuntime 接入投影、记忆钉与 recall

**Files:**
- Modify: `packages/storage/src/life-repository.ts`
- Modify: `packages/app/src/life-runtime.ts`
- Modify: `packages/app/package.json`
- Test: `packages/storage/test/event-records.test.ts`
- Test: `packages/app/test/life-runtime-memory.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 的 `SqliteMemoryIndex` / `createMemoryRecallExtension` / `resolveEmbeddingConfig` / `FakeEmbedder`；Task 5 的异步 `loadFrameInput` 与 `memoryPins`。
- Produces:
  - `SqliteLifeRepository.loadEventRecordsAfter(sequence: number): Array<{ sequence: number; envelope: EventEnvelope }>`（全库、按 sequence 升序，跳过无法 canonicalize 的行）
  - `LifeRuntimeOptions` 新增 `readonly embedder?: EmbeddingPort`
  - `LifeRuntime.recall(orenId: string, query?: Omit<RecallQuery, "orenId">): Promise<readonly MemoryEntry[]>`（先补投影再召回）

- [ ] **Step 1: 依赖声明**

`packages/app/package.json` 的 `dependencies` 增加：

```json
    "@oren/memory": "*"
```

- [ ] **Step 2: 写失败测试**

`packages/storage/test/event-records.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { createInitialLifeState, LifeActor } from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";

describe("loadEventRecordsAfter", () => {
  it("returns canonical envelopes with ascending sequences after a cursor", () => {
    const repository = new SqliteLifeRepository(
      openDatabase(":memory:"),
      () => "2026-07-26T00:00:00.000Z",
    );
    repository.initialize(createInitialLifeState("oren-1", "person-1"));
    const actor = new LifeActor(
      repository,
      (() => { let id = 0; return () => `id-${id += 1}`; })(),
      () => "2026-07-26T00:00:00.000Z",
    );
    actor.handleUserMessage("oren-1", "person-1", "你好");

    const all = repository.loadEventRecordsAfter(0);
    expect(all.length).toBe(2); // UserMessageReceived + CognitionRequested
    expect(all[0]!.sequence).toBeLessThan(all[1]!.sequence);
    expect(all[0]!.envelope.payload.type).toBe("UserMessageReceived");

    const after = repository.loadEventRecordsAfter(all[0]!.sequence);
    expect(after).toHaveLength(1);
    expect(after[0]!.sequence).toBe(all[1]!.sequence);
  });
});
```

`packages/app/test/life-runtime-memory.test.ts`：

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "@oren/memory";
import { LifeRuntime } from "@oren/app";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-memory-")), "life.db");
}

describe("LifeRuntime memory integration", () => {
  it("projects user messages into recallable memory and survives restart", async () => {
    const databasePath = tempDb();
    const first = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "请读取计数器，把它加一，然后安排一次后续查看。");
    await first.drain();
    const before = await first.recall("oren-1", { limit: 20 });
    expect(before.some(({ kind }) => kind === "user_statement")).toBe(true);
    await first.close();

    const second = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    try {
      const after = await second.recall("oren-1", { limit: 20 });
      expect(after).toEqual(before); // 重启后可召回，且与重启前一致
    } finally {
      await second.close();
    }
  });

  it("exposes memory.recall to cognition and injects memory pins", async () => {
    const databasePath = tempDb();
    const runtime = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "请读取计数器，把它加一，然后安排一次后续查看。");
      await runtime.drain();
      // memory.recall 能力已注册（不需要 grant，走即时通道）
      const entries = await runtime.recall("oren-1", { text: "计数器", limit: 5 });
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });
});
```

（记忆钉注入路径经 `loadFrameInput` 生效；其行为由本测试的 recall 路径 + Task 5 的 `createLifeFrame` 单测共同覆盖，无需侵入内部。）

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/storage/test/event-records.test.ts packages/app/test/life-runtime-memory.test.ts`
Expected: FAIL（`loadEventRecordsAfter` / `recall` / `embedder` 选项不存在）。

- [ ] **Step 4: 实现 storage 侧**

`packages/storage/src/life-repository.ts` — 在 `loadEvents` 附近新增公有方法：

```typescript
  public loadEventRecordsAfter(sequence: number): Array<{
    readonly sequence: number;
    readonly envelope: EventEnvelope;
  }> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Event record cursor must be a nonnegative safe integer");
    }
    return this.db.prepare(`
      SELECT sequence, envelope_json FROM events
      WHERE sequence > ?
      ORDER BY sequence
    `).all(sequence).flatMap((row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.envelope_json));
      } catch {
        return [];
      }
      const envelope = canonicalizeEventEnvelope(parsed);
      return envelope ? [{ sequence: Number(row.sequence), envelope }] : [];
    });
  }
```

- [ ] **Step 5: 实现 app 侧**

`packages/app/src/life-runtime.ts` 修改：

imports 增加：

```typescript
import {
  createMemoryRecallExtension,
  resolveEmbeddingConfig,
  SqliteMemoryIndex,
  type EmbeddingPort,
  type MemoryEntry,
  type MemoryPort,
  type RecallQuery,
} from "@oren/memory";
```

`LifeRuntimeOptions` 增加：

```typescript
  readonly embedder?: EmbeddingPort;
```

`create` 中数据库打开方式改为持有 `db`（`openDatabase` 已 import）：

```typescript
    const db = openDatabase(databasePath);
    const repository = new SqliteLifeRepository(db, now, nextId);
    const resolvedEmbedding = options.embedder === undefined
      ? resolveEmbeddingConfig(process.env)
      : undefined;
    const embedder = options.embedder
      ?? (resolvedEmbedding?.ok ? resolvedEmbedding.embedder : undefined);
    const memory = new SqliteMemoryIndex(db, {
      ...(embedder !== undefined ? { embedder } : {}),
      now: () => Date.parse(now()),
    });
```

扩展注册改为两个（业务扩展 + 内置 memory 扩展），并把清理路径改为数组。`create` 内：

```typescript
    let extensions: OrenExtension[] = [];
    let activatedCount = 0;
    try {
      const businessExtension = (options.extensionFactory ?? createTestCounterExtension)();
      const memoryExtension = createMemoryRecallExtension(memory);
      extensions = [businessExtension, memoryExtension];
      const registry = new ExtensionRegistry();
      for (const extension of extensions) {
        registry.register(extension);
      }
      for (const extension of extensions) {
        await extension.activate({
          extensionId: extension.manifest.id,
          reportProgress() {},
          emitObservation() {},
        });
        activatedCount += 1;
      }
      // ...（原有 actor/guard/broker/worker 构造不变，见下方 loadFrameInput 改动）
```

原 `catch (primaryError)` 清理块中，单个 `extension.deactivate()` 改为：

```typescript
      for (const extension of extensions.slice(0, activatedCount)) {
        try {
          await extension.deactivate();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
```

`CognitionWorker` 的 `loadFrameInput`（原第 208-214 行的同步闭包）改为异步并注入记忆钉：

```typescript
        async (job) => {
          const state = repository.loadState(job.orenId);
          const newRecords = repository.loadEventRecordsAfter(memory.cursor());
          if (newRecords.length > 0) await memory.project(newRecords);
          const focus = state.attention.currentFocus;
          const pins = await memory.recall({
            orenId: job.orenId,
            ...(focus !== null ? { text: focus } : {}),
            limit: 5,
          });
          return {
            state,
            correlationId: job.correlationId,
            trigger: { kind: job.triggerKind, summary: job.correlationId },
            capabilities: registry.listCapabilities(),
            maxSteps: 8,
            memoryPins: pins.map((entry) => ({
              memoryId: entry.memoryId,
              kind: entry.kind,
              text: entry.text,
              confidence: entry.confidence,
              occurredAt: entry.occurredAt,
            })),
          };
        },
```

私有构造函数与 `new LifeRuntime(...)` 调用：`extension: OrenExtension` 参数替换为 `extensions: readonly OrenExtension[]` 与 `memory: MemoryPort`（构造函数字段同名替换）。`closeOwnedResources` 中 `await this.extension.deactivate();` 改为：

```typescript
      for (const extension of this.extensions) {
        await extension.deactivate();
      }
```

`drainToFixedPoint` 的 while 循环体开头（`let activity = 0;` 之后）插入投影追平：

```typescript
      const newRecords = this.repository.loadEventRecordsAfter(this.memory.cursor());
      if (newRecords.length > 0) await this.memory.project(newRecords);
```

新增公有方法（放在 `inspect` 之后）：

```typescript
  public async recall(
    orenId: string,
    query: Omit<RecallQuery, "orenId"> = {},
  ): Promise<readonly MemoryEntry[]> {
    this.assertOpen();
    if (this.identity && this.identity.orenId !== orenId) {
      throw new Error(`LifeRuntime identity conflict: expected ${this.identity.orenId}`);
    }
    const newRecords = this.repository.loadEventRecordsAfter(this.memory.cursor());
    if (newRecords.length > 0) await this.memory.project(newRecords);
    return this.memory.recall({ ...query, orenId });
  }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS（重点确认 `packages/app/test` 既有 life-runtime 测试不回归）。

- [ ] **Step 7: Commit**

```bash
git add packages/storage packages/app
git commit -m "feat(app): wire memory projection, memory pins, and recall into LifeRuntime"
```

---

### Task 7: pi-cognition — proposal schema 与记忆纪律 prompts

**Files:**
- Modify: `packages/pi-cognition/src/proposal-schema.ts`
- Modify: `packages/pi-cognition/src/prompts.ts`
- Test: `packages/pi-cognition/test/memory-prompts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 Proposal 类型、Task 5 的 `LifeFrame.memoryPins`。
- Produces: `CommitSchema` 接受三个新 Proposal；`systemPrompt` 含记忆纪律；`userPrompt` 渲染记忆钉（含 memoryId，便于 ReviseBelief/Forget 引用）。

- [ ] **Step 1: 写失败测试**

`packages/pi-cognition/test/memory-prompts.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import type { LifeFrame } from "@oren/cognition";
import { CommitSchema, systemPrompt, userPrompt } from "@oren/pi-cognition";

const FRAME: LifeFrame = {
  orenId: "oren-1", correlationId: "c1", stateVersion: 1,
  identity: { ethosVersion: 1, disposition: "attentive" },
  attention: { focus: null, threadIds: [] },
  relationship: { primaryPersonId: "p1", contextRef: null },
  trigger: { kind: "foreground_user", summary: "hi" },
  memoryPins: [{
    memoryId: "m-pin-1", kind: "oren_judgment",
    text: "判断：用户在准备一场演讲", confidence: 0.6,
    occurredAt: "2026-07-20T00:00:00.000Z",
  }],
  capabilities: [],
  maxSteps: 8,
};

describe("memory proposals in commit schema", () => {
  it("accepts Remember/ReviseBelief/Forget", () => {
    expect(Check(CommitSchema, {
      proposals: [
        { type: "Remember", text: "事实", kind: "external_fact" },
        { type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "r" },
        { type: "Forget", memoryId: "m2", reason: "r" },
      ],
    })).toBe(true);
    expect(Check(CommitSchema, {
      proposals: [{ type: "Remember", text: "x" }],
    })).toBe(false);
  });
});

describe("memory prompts", () => {
  it("system prompt teaches memory discipline", () => {
    const prompt = systemPrompt(FRAME);
    expect(prompt).toContain("记忆纪律");
    expect(prompt).toContain("Remember");
    expect(prompt).toContain("ReviseBelief");
    expect(prompt).toContain("Forget");
    expect(prompt).toContain("memory.recall");
  });

  it("user prompt renders memory pins with memoryId", () => {
    const prompt = userPrompt(FRAME);
    expect(prompt).toContain("相关记忆");
    expect(prompt).toContain("m-pin-1");
    expect(prompt).toContain("判断：用户在准备一场演讲");
    const empty = userPrompt({ ...FRAME, memoryPins: [] });
    expect(empty).toContain("无相关记忆钉");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/pi-cognition/test/memory-prompts.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/pi-cognition/src/proposal-schema.ts` — `ProposalSchema` 的 Union 数组追加：

```typescript
  Type.Object({
    type: Type.Literal("Remember"),
    text: Type.String(),
    kind: Type.Union([
      Type.Literal("user_statement"),
      Type.Literal("external_fact"),
      Type.Literal("oren_judgment"),
      Type.Literal("oren_expression"),
    ]),
    confidence: Type.Optional(Type.Number()),
    reviewCondition: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("ReviseBelief"),
    memoryId: Type.String(),
    revisedText: Type.Optional(Type.String()),
    confidence: Type.Number(),
    reason: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("Forget"),
    memoryId: Type.String(),
    reason: Type.String(),
  }, { additionalProperties: false }),
```

`packages/pi-cognition/src/prompts.ts` 修改：

`systemPrompt` 中原句「合法的提议类型只有五种：NoAction、AdvanceThread、UpdateDisposition、ExpressToUser、ScheduleWake。」替换为：

```typescript
    "合法的提议类型只有八种：NoAction、AdvanceThread、UpdateDisposition、ExpressToUser、"
      + "ScheduleWake、Remember、ReviseBelief、Forget。",
```

在「## 停止与唤醒」段落之前插入新段：

```typescript
    "",
    "## 记忆纪律",
    "「相关记忆」一节与 memory.recall 能力是你跨时间理解的来源；需要历史背景时，先召回再判断。",
    "Remember 只记有跨时间价值的内容：判断用 kind=oren_judgment 且必须带 confidence（0 到 1）；"
      + "带来源的外部事实用 external_fact。不要逐句复读对话。",
    "观点不得伪装成事实：任何推测与判断都是 oren_judgment，并诚实给出置信度。",
    "已失效的判断用 ReviseBelief 修订（引用 memoryId 并说明理由），不要留下自相矛盾的记忆。",
    "Forget 只是降低可召回性，不删除生命史；使用时引用 memoryId 并说明理由。",
```

`userPrompt` 在「## 关系」段之后追加记忆钉渲染：

```typescript
  const pins = frame.memoryPins.length > 0
    ? frame.memoryPins.map((pin) => {
        const confidence = pin.confidence !== null ? `，置信度 ${pin.confidence}` : "";
        return `- [${pin.memoryId}] (${pin.kind}${confidence}，${pin.occurredAt}) ${pin.text}`;
      })
    : ["（无相关记忆钉；需要历史背景时可用 memory.recall 主动召回）"];
```

返回数组尾部追加：

```typescript
    "",
    "## 相关记忆",
    ...pins,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/pi-cognition && npm run typecheck`
Expected: PASS（既有 prompts/adapter 测试如断言了「五种」字样需同步更新——若失败按新文案修正断言）。

- [ ] **Step 5: Commit**

```bash
git add packages/pi-cognition
git commit -m "feat(pi-cognition): add memory proposals to commit schema and memory discipline prompts"
```

---

### Task 8: smoke 扩展、记忆评估场景与文档

**Files:**
- Modify: `packages/app/src/smoke-runner.ts`
- Modify: `packages/evals/src/scenarios.ts`
- Modify: `README.md`
- Test: `packages/evals/test/memory-scenarios.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `LifeRuntime.recall`；evals 既有 `Scenario` / `frame()` / `completedWithValidProposals` / `expressTexts`。
- Produces: smoke 在重启后断言记忆可召回；evals 新增 `s11-recall-history`、`s12-remember-judgment`、`s13-revise-belief` 三个场景。

- [ ] **Step 1: 写失败测试（evals 场景结构）**

`packages/evals/test/memory-scenarios.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { allScenarios } from "@oren/evals";

describe("memory scenarios", () => {
  const byId = new Map(allScenarios().map((scenario) => [scenario.id, scenario]));

  it("registers the three memory scenarios", () => {
    expect(byId.has("s11-recall-history")).toBe(true);
    expect(byId.has("s12-remember-judgment")).toBe(true);
    expect(byId.has("s13-revise-belief")).toBe(true);
  });

  it("s11 requires a memory.recall invocation and a grounded answer", () => {
    const scenario = byId.get("s11-recall-history")!;
    expect(scenario.frame.capabilities.some(({ name }) => name === "memory.recall"))
      .toBe(true);
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "你说过主题是城市步行系统。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [], // 没有召回调用
    );
    expect(failures.some((message) => message.includes("memory.recall"))).toBe(true);
  });

  it("s13 requires revising the outdated pinned belief", () => {
    const scenario = byId.get("s13-revise-belief")!;
    expect(scenario.frame.memoryPins).toHaveLength(1);
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "好的，明白了。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/evals`
Expected: FAIL（场景不存在）。

- [ ] **Step 3: 实现 evals 场景**

`packages/evals/src/scenarios.ts` — 常量区新增：

```typescript
const RECALL_CAPABILITY: CapabilityDescriptor = {
  extensionId: "eval",
  name: "memory.recall",
  description: "召回过往记忆（按语义文本、类型、线索与时间过滤）",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      kinds: { type: "array", items: { type: "string" } },
      threadId: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "number" },
      includeLowered: { type: "boolean" },
    },
    additionalProperties: false,
  },
  outputSchema: { type: "array" },
  permissionRequirements: [],
  traits: ["read_only", "replay_safe"],
  cancellable: true,
  timeoutMs: 5_000,
};

const RECALLED_SPEECH_MEMORY = [{
  memoryId: "mem-eval-1",
  orenId: "oren-eval",
  kind: "user_statement",
  text: "用户说：我在准备一场关于城市步行系统的演讲。",
  sourceEventId: "evt-eval-1",
  occurredAt: "2026-07-19T10:00:00.000Z",
  confidence: null,
  reviewCondition: null,
  threadId: null,
  recallability: "active",
}];
```

`allScenarios()` 返回数组末尾追加三个场景：

```typescript
    {
      id: "s11-recall-history",
      title: "需要历史背景：先召回记忆再回应",
      frame: frame({
        trigger: {
          kind: "foreground_user",
          summary: "我上周跟你说过我在准备的那场演讲，你还记得主题是什么吗？",
        },
        capabilities: [READ_CAPABILITY, INCREMENT_CAPABILITY, RECALL_CAPABILITY],
      }),
      capabilityScript: (capability) =>
        capability === "memory.recall"
          ? { kind: "completed", output: RECALLED_SPEECH_MEMORY }
          : { kind: "rejected", reason: "not needed" },
      assert: (outcome, invocations) => {
        const base = completedWithValidProposals(outcome);
        if (base.length > 0) return base;
        const failures: string[] = [];
        if (!invocations.some(({ capability }) => capability === "memory.recall")) {
          failures.push("expected a memory.recall invocation before answering");
        }
        const texts = expressTexts(outcome);
        if (texts.length === 0) {
          failures.push("expected an ExpressToUser answer");
        } else if (!texts.some((text) => text.includes("步行") || text.includes("演讲"))) {
          failures.push("expected the answer to use the recalled memory");
        }
        return failures;
      },
    },
    {
      id: "s12-remember-judgment",
      title: "值得记住的变化：Remember 且区分事实与判断",
      frame: frame({
        trigger: {
          kind: "foreground_user",
          summary: "跟你分享一下：我这两个月每天早上都去跑步，感觉整个人状态好了很多。",
        },
        capabilities: [RECALL_CAPABILITY],
      }),
      capabilityScript: () => ({ kind: "completed", output: [] }),
      assert: (outcome) => {
        const base = completedWithValidProposals(outcome);
        if (base.length > 0) return base;
        if (outcome.kind !== "completed") return ["unreachable"];
        const remembers = outcome.proposals.filter(({ type }) => type === "Remember");
        return remembers.length > 0
          ? []
          : ["expected at least one Remember proposal for a durable life change"];
      },
    },
    {
      id: "s13-revise-belief",
      title: "判断已失效：修订记忆而不是留下矛盾",
      frame: frame({
        trigger: {
          kind: "foreground_user",
          summary: "跟你说一下，我上个月说想换工作，后来决定留下来了，别再按我要离职来想了。",
        },
        memoryPins: [{
          memoryId: "mem-belief-1",
          kind: "oren_judgment",
          text: "判断：用户可能会在近期离职换工作。",
          confidence: 0.7,
          occurredAt: "2026-06-30T09:00:00.000Z",
        }],
        capabilities: [RECALL_CAPABILITY],
      }),
      capabilityScript: () => ({ kind: "completed", output: [] }),
      assert: (outcome) => {
        const base = completedWithValidProposals(outcome);
        if (base.length > 0) return base;
        if (outcome.kind !== "completed") return ["unreachable"];
        const revised = outcome.proposals.some((proposal) =>
          (proposal.type === "ReviseBelief" || proposal.type === "Forget")
          && proposal.memoryId === "mem-belief-1");
        return revised
          ? []
          : ["expected a ReviseBelief/Forget proposal referencing mem-belief-1"];
      },
    },
```

（`frame()` 已在 Task 5 中获得 `memoryPins: []` 基础字段，此处 override 即可。）

- [ ] **Step 4: 扩展 smoke 断言**

`packages/app/src/smoke-runner.ts`：

用户消息改为（原第 96 行）：

```typescript
      "请读取计数器，把它加一，记住一个关于这个计数器用途的判断，然后安排一次后续查看。",
```

在重启后 `afterRestart` 对比与垂直切片断言之后、成功日志之前插入：

```typescript
      const memories = await second.recall("oren-smoke", { limit: 50 });
      if (memories.length === 0) {
        log("FAIL: expected recallable memories after restart");
        return 1;
      }
      log(`memories recallable after restart: ${memories.length}`);
```

- [ ] **Step 5: 更新 README**

`README.md` 中 smoke / eval 命令说明附近新增一节（措辞可微调，要点必须齐全）：

```markdown
## 记忆（Phase 3）

- Oren 从生命事件史投影可召回记忆：用户消息、Oren 的表达、线索推进自动入库；
  模型可通过 `Remember` / `ReviseBelief` / `Forget` 提议经营记忆。
- 召回默认使用向量检索（需配置 embedding 凭据）；未配置时自动降级为
  结构化检索（类型/线索/时间过滤 + 关键词 + 时近排序），离线测试全部走降级或假 embedder。
- 启用真实向量召回（可选，手动路径）：

  ```bash
  export OREN_EMBEDDING_PROVIDER=openai
  export OREN_EMBEDDING_MODEL=text-embedding-3-small
  export OPENAI_API_KEY=sk-...
  # 或任意 OpenAI 兼容端点：
  # export OREN_EMBEDDING_PROVIDER=openai-compatible
  # export OREN_EMBEDDING_BASE_URL=https://your-endpoint/v1
  # export OREN_EMBEDDING_API_KEY=...
  ```

- 「忘记」只降低可召回性，生命史与索引行都不会删除；记忆索引可随时从事件史重建。
```

- [ ] **Step 6: 全量验证**

Run: `npm test && npm run typecheck && npm run build && npm run demo`
Expected: 全部 PASS 且完全离线；`npm run smoke` 在未配置模型凭据时输出 unconfigured 提示并以 0 退出。

Run: `npm run smoke`
Expected: 无凭据时打印 "Real-model mode is disabled..." 并退出码 0。

- [ ] **Step 7: Commit**

```bash
git add packages/app packages/evals README.md
git commit -m "feat: assert memory recall in smoke, add memory behavior eval scenarios, document memory setup"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§3 条目模型 → Task 2；§4 协议 → Task 1；§5.1-5.2 投影/重建 → Task 2；§5.3 向量与降级 → Task 3；§6 recall 能力/记忆钉/prompts → Task 4/5/6/7；§7 测试（投影、显式写入、召回过滤、降级、重建一致、重启召回、Guard 拒绝）→ Task 1/2/3/6；smoke 扩展与 evals 场景 → Task 8；`prepare-dist` → Task 2。无缺口。
2. **占位符**：无 TBD/TODO；所有代码块完整。
3. **类型一致性**：`MemoryPort.cursor()` / `loadEventRecordsAfter(sequence)` / `RecallQuery.orenId` / `MemoryPin` 字段名在 Task 2/4/5/6 间已核对一致；`LifeRuntime.recall` 的 `Omit<RecallQuery, "orenId">` 与 Task 6 测试一致。
