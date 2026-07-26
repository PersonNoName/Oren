# Phase 5 消息渠道与生活面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为本地面板接通主动分享出口与有限纠错表面：`ExpressToUser` 经打扰策略自动投递/延后，最小共同承诺可展示与更新，loopback 面板可读可写。

**Architecture:** 新建 `@oren/channel`（ChannelPort + Scripted/PanelInbox 适配器）与 `@oren/panel`（snapshot + loopback HTTP + 轻量页）。kernel 增加 reachability、投递结果事件、承诺 Proposal/事件、`GrantRevoked`。`LifeRuntime` 在认知接受后驱动投递；`deliver:<id>` 唤醒走持久调度完成延后投递，不启动认知。

**Tech Stack:** TypeScript (ES2024, NodeNext, strict + exactOptionalPropertyTypes), node:sqlite, node:http, vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-26-phase5-channel-panel-design.md`

## Global Constraints

- `npm test` / `typecheck` / `build` 全绿且**完全离线**；面板监听仅 `enablePanel` / `OREN_PANEL=1` 门控。
- 面板只绑定 `127.0.0.1`；写 API 禁止直写 DB，只调 `LifeRuntime` 受控方法。
- 不向模型暴露 `message.deliver`；投递由 runtime 在 `ExpressToUser` 接受后驱动。
- `triggerKind === "foreground_user"` → `proactive: false`（豁免安静时段与频率帽）；其它触发 → `proactive: true`。
- 延后投递必须 `WakeScheduled`（`purpose: "deliver:<deliveryId>"`），禁止 `setTimeout`。
- 策略「当前时间」可注入（`now`）；安静时段比较使用 **UTC** 从 `now` 解析的 HH:MM（`timezone` 字段保留为 `"UTC"` 默认，满足离线确定性；与 spec `local` 语义对齐方式：生产可后续换 Intl，本 Phase 锁定 UTC）。
- 测试放各包 `test/*.test.ts`；每任务结束该任务测试 + 相关 typecheck 通过再提交。

---

## File map

| Path | Responsibility |
|------|----------------|
| `packages/kernel/src/{protocol,state,reducer,runtime-validation,life-actor,reachability}.ts` | 策略、投递事件、承诺、撤权 |
| `packages/channel/**` | ChannelPort + adapters |
| `packages/panel/**` | Snapshot 类型、HTTP server、静态页 |
| `packages/storage/src/life-repository.ts` | `revokeGrant` |
| `packages/app/src/{life-runtime,cognition-worker,delivery}.ts` | 投递编排、面板挂载、写 API |
| `packages/pi-cognition/src/{prompts,proposal-schema}.ts` | 承诺 schema + 分享纪律 |
| `packages/evals/src/scenarios.ts` | s16–s18 |
| `scripts/prepare-dist.mjs` / README / root+app package.json | 链接与文档 |

---

### Task 1: kernel — reachability + delivery events + GrantRevoked

**Files:**
- Create: `packages/kernel/src/reachability.ts`
- Modify: `packages/kernel/src/state.ts`
- Modify: `packages/kernel/src/protocol.ts`
- Modify: `packages/kernel/src/runtime-validation.ts`
- Modify: `packages/kernel/src/reducer.ts`
- Modify: `packages/kernel/src/life-actor.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/storage/src/life-repository.ts` (add `revokeGrant`)
- Test: `packages/kernel/test/reachability-protocol.test.ts`
- Test: `packages/storage/test/life-repository.test.ts` (revokeGrant case)

**Interfaces:**
- Consumes: existing `LifeState` / `CoreEvent` / `LifeActor` / repository grant table.
- Produces:
  ```ts
  export type QuietHours = {
    readonly start: string; // "HH:MM"
    readonly end: string;
    readonly timezone: "UTC";
  };

  export type ReachabilityPolicy = {
    readonly quietHours: QuietHours | null;
    readonly maxProactivePerDay: number;
    readonly deferWhenQuiet: true;
    readonly proactiveDayKey: string | null; // "YYYY-MM-DD" UTC
    readonly proactiveCountToday: number;
  };

  // LifeState.reachability: ReachabilityPolicy
  // createInitialLifeState defaults:
  //   quietHours: { start: "22:00", end: "08:00", timezone: "UTC" }
  //   maxProactivePerDay: 3
  //   deferWhenQuiet: true
  //   proactiveDayKey: null, proactiveCountToday: 0

  export type DeliveryCause = "quiet_hours" | "frequency_cap";

  export type ReachabilityDecision =
    | { readonly action: "deliver" }
    | { readonly action: "defer"; readonly cause: DeliveryCause; readonly deferUntil: string };

  export function evaluateReachability(
    policy: ReachabilityPolicy,
    nowIso: string,
    proactive: boolean,
  ): ReachabilityDecision;

  export function utcDayKey(nowIso: string): string; // YYYY-MM-DD
  export function nextDeliverAt(policy: ReachabilityPolicy, nowIso: string, cause: DeliveryCause): string;

  // CoreEvent additions:
  // ReachabilityPolicyUpdated { policy: Omit<ReachabilityPolicy, "proactiveDayKey" | "proactiveCountToday"> & { ... full snapshot including counters }, reason: string }
  //   → store full ReachabilityPolicy in event for replay simplicity
  // MessageDelivered { deliveryId, text, reason, channel: "panel", proactive: boolean }
  // MessageDeferred { deliveryId, text, reason, deferUntil, cause: DeliveryCause }
  // MessageDeliveryFailed { deliveryId, text, reason, code: string }
  // GrantRevoked { grantId, reason: string }

  // LifeActor:
  lifeActor.updateReachabilityPolicy(orenId, correlationId, policyInput, reason): void
  lifeActor.recordMessageDelivered(orenId, correlationId, input): void
  lifeActor.recordMessageDeferred(orenId, correlationId, input): void
  //   also commits WakeScheduled { scheduleId: deliveryId, at: deferUntil, purpose: `deliver:${deliveryId}` }
  lifeActor.recordMessageDeliveryFailed(orenId, correlationId, input): void
  lifeActor.revokeGrant(orenId, correlationId, grantId, reason): void
  // repository.revokeGrant(orenId, grantId, revokedAtIso): boolean
  ```

- [ ] **Step 1: Write the failing test**

`packages/kernel/test/reachability-protocol.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  evaluateReachability,
  LifeActor,
  reduceLifeState,
  type EventEnvelope,
} from "@oren/kernel";

describe("evaluateReachability", () => {
  const base = createInitialLifeState("oren-1", "person-1").reachability!;

  it("delivers non-proactive immediately even in quiet hours", () => {
    // 23:00 UTC inside 22:00-08:00
    const d = evaluateReachability(base, "2026-07-26T23:00:00.000Z", false);
    expect(d).toEqual({ action: "deliver" });
  });

  it("defers proactive during quiet hours", () => {
    const d = evaluateReachability(base, "2026-07-26T23:00:00.000Z", true);
    expect(d.action).toBe("defer");
    if (d.action === "defer") {
      expect(d.cause).toBe("quiet_hours");
      expect(d.deferUntil > "2026-07-26T23:00:00.000Z").toBe(true);
    }
  });

  it("defers proactive when frequency cap hit", () => {
    const capped = {
      ...base,
      quietHours: null,
      proactiveDayKey: "2026-07-26",
      proactiveCountToday: 3,
      maxProactivePerDay: 3,
    };
    const d = evaluateReachability(capped, "2026-07-26T12:00:00.000Z", true);
    expect(d.action).toBe("defer");
    if (d.action === "defer") expect(d.cause).toBe("frequency_cap");
  });
});

describe("delivery + policy events", () => {
  it("MessageDelivered increments proactive count for proactive=true", () => {
    const actor = new LifeActor(repo, nextId, () => "2026-07-26T12:00:00.000Z");
    // after initialize + grantIds seeded as in life-actor.test.ts:
    actor.recordMessageDelivered("oren-1", "corr-1", {
      deliveryId: "d1",
      text: "share",
      reason: "progress",
      channel: "panel",
      proactive: true,
    });
    const state = repo.loadState("oren-1");
    expect(state.reachability?.proactiveDayKey).toBe("2026-07-26");
    expect(state.reachability?.proactiveCountToday).toBe(1);
  });

  it("MessageDeferred also schedules WakeScheduled with deliver: purpose", () => {
    const actor = new LifeActor(repo, nextId, () => "2026-07-26T23:00:00.000Z");
    actor.recordMessageDeferred("oren-1", "corr-1", {
      deliveryId: "d2",
      text: "later",
      reason: "progress",
      deferUntil: "2026-07-27T08:00:00.000Z",
      cause: "quiet_hours",
    });
    const events = repo.committed; // or whatever the fake repo exposes
    expect(events.some((e) => e.payload.type === "MessageDeferred")).toBe(true);
    expect(events.some((e) =>
      e.payload.type === "WakeScheduled"
      && e.payload.purpose === "deliver:d2"
    )).toBe(true);
  });

  it("GrantRevoked removes grantId from state", () => {
    // seed state.grantIds = ["g1"]; actor.revokeGrant(...); expect loadState.grantIds excludes g1
  });
});
```

Use the same fake repository pattern as `packages/kernel/test/life-actor.test.ts` (adapt field names to that fake).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/kernel/test/reachability-protocol.test.ts`
Expected: FAIL (module/exports missing)

- [ ] **Step 3: Implement**

1. `state.ts` — add `reachability: ReachabilityPolicy`; defaults as above. Legacy load: if missing, reducer/validation treat via helper `reachabilityOf(state)` that fills defaults (do **not** silently clear quiet hours).
2. `reachability.ts` — pure `evaluateReachability` / `utcDayKey` / `nextDeliverAt`:
   - Quiet window spanning midnight: `start > end` means quiet if `minutes >= start || minutes < end`.
   - `nextDeliverAt` for quiet_hours → next `end` boundary UTC ISO; for frequency_cap → next UTC midnight `00:00:00.000Z`.
3. `protocol.ts` — add the five event types (no new delivery Proposal).
4. `runtime-validation.ts` — canonicalize/validate new events; `HH:MM` regex `^\d{2}:\d{2}$`; `channel === "panel"`; `maxProactivePerDay` non-negative safe int; text/reason non-empty; excerpt-like length caps: text ≤ 8192.
5. `reducer.ts`:
   - `ReachabilityPolicyUpdated` → replace `state.reachability`
   - `MessageDelivered` + `proactive` → bump count if same `utcDayKey(occurredAt)` else reset to 1 / new day key (use envelope `occurredAt`)
   - `MessageDeferred` / `MessageDeliveryFailed` → version only (plus WakeScheduled already handled by existing schedule path when that event is present)
   - `GrantRevoked` → filter `grantIds`
   - `WakeScheduled` for `deliver:` — existing schedule handling already works
6. `life-actor.ts` — methods listed above; `recordMessageDeferred` commits `[MessageDeferred, WakeScheduled]` in one `commit`.
7. `life-repository.ts` — `revokeGrant(orenId, grantId, revokedAt)` sets `revoked_at` where currently null; return false if missing/already revoked.
8. Export from `index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/kernel/test/reachability-protocol.test.ts packages/storage/test/life-repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel packages/storage
git commit -m "$(cat <<'EOF'
feat(kernel): add reachability policy and message delivery events

EOF
)"
```

---

### Task 2: kernel — minimal commitments

**Files:**
- Modify: `packages/kernel/src/protocol.ts`
- Modify: `packages/kernel/src/state.ts`
- Modify: `packages/kernel/src/runtime-validation.ts`
- Modify: `packages/kernel/src/reducer.ts`
- Modify: `packages/kernel/src/life-actor.ts`
- Modify: `packages/pi-cognition/src/proposal-schema.ts`
- Test: `packages/kernel/test/commitment-protocol.test.ts`
- Test: `packages/pi-cognition/test/proposal-schema.test.ts` (or extend existing)

**Interfaces:**
- Consumes: Task 1 LifeActor/commit patterns.
- Produces:
  ```ts
  export type CommitmentStatus = "active" | "paused" | "done";

  export type Commitment = {
    readonly commitmentId: string;
    readonly goal: string;
    readonly status: CommitmentStatus;
    readonly nextStep: string;
    readonly mayAdvanceAutonomously: boolean;
  };

  // LifeState.commitments: readonly Commitment[]  (default [])

  // Proposal:
  // UpsertCommitment { commitmentId?, goal, status, nextStep, mayAdvanceAutonomously }
  // UpdateCommitmentStatus { commitmentId, status, nextStep?, reason }

  // CoreEvent:
  // CommitmentUpserted { commitmentId, goal, status, nextStep, mayAdvanceAutonomously }
  // CommitmentStatusChanged { commitmentId, status, nextStep?, reason }

  // LifeActor.acceptCognition maps UpsertCommitment → CommitmentUpserted (id via nextId if omitted)
  // LifeActor.acceptCognition maps UpdateCommitmentStatus → CommitmentStatusChanged
  // LifeActor.updateCommitmentStatus(orenId, correlationId, input) for panel path (same event)
  ```

- [ ] **Step 1: Write the failing test**

```typescript
describe("commitments", () => {
  it("UpsertCommitment appends and replaces by id", () => { /* reduceLifeState */ });
  it("CommitmentStatusChanged on unknown id is no-op on state but event valid", () => {
    // reduceLifeState does not throw; commitments unchanged
  });
  it("acceptCognition maps UpsertCommitment and UpdateCommitmentStatus", () => { /* LifeActor */ });
  it("updateCommitmentStatus from actor commits CommitmentStatusChanged", () => {});
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run packages/kernel/test/commitment-protocol.test.ts`

- [ ] **Step 3: Implement**

- Validation: `goal`/`nextStep`/`reason` non-empty strings; status enum; `mayAdvanceAutonomously` boolean.
- Reducer upsert: replace matching id or append; cap list length **32** (drop oldest done first, else drop oldest).
- Status change: if id missing → return `base` unchanged (version still increments).
- Update `proposal-schema.ts` TypeBox union with both proposal types (mirror Remember style).
- Export types from kernel index.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run packages/kernel/test/commitment-protocol.test.ts packages/pi-cognition/test`

- [ ] **Step 5: Commit**

```bash
git add packages/kernel packages/pi-cognition
git commit -m "$(cat <<'EOF'
feat(kernel): add minimal commitment proposals and state

EOF
)"
```

---

### Task 3: `@oren/channel` package

**Files:**
- Create: `packages/channel/package.json`
- Create: `packages/channel/src/types.ts`
- Create: `packages/channel/src/scripted-adapter.ts`
- Create: `packages/channel/src/panel-inbox-adapter.ts`
- Create: `packages/channel/src/index.ts`
- Modify: root `package.json` workspaces already include `packages/*`
- Modify: `scripts/prepare-dist.mjs` — add `["channel", "packages/channel"]`
- Test: `packages/channel/test/channel-adapters.test.ts`

**Interfaces:**
- Consumes: none from kernel required in adapters (pure).
- Produces:
  ```ts
  export type DeliverInput = {
    readonly deliveryId: string;
    readonly text: string;
    readonly reason: string;
    readonly proactive: boolean;
  };

  export type DeliverResult =
    | { readonly ok: true; readonly deliveredAt: string }
    | { readonly ok: false; readonly code: string; readonly message: string };

  export interface ChannelPort {
    deliver(input: DeliverInput): Promise<DeliverResult>;
  }

  export class ScriptedChannelAdapter implements ChannelPort {
    constructor(handlers?: {
      deliver?: (input: DeliverInput) => Promise<DeliverResult> | DeliverResult;
    });
    readonly calls: DeliverInput[]; // recorded
  }

  export type InboxMessage = DeliverInput & { readonly deliveredAt: string };

  export class PanelInboxAdapter implements ChannelPort {
    constructor(private readonly now: () => string);
    readonly messages: InboxMessage[]; // newest last
    deliver(...): Promise<DeliverResult>; // always ok unless text empty → ok:false code empty_text
  }
  ```

- [ ] **Step 1: Failing tests**

```typescript
it("ScriptedChannelAdapter records calls and returns scripted failure", async () => {
  const port = new ScriptedChannelAdapter({
    deliver: () => ({ ok: false, code: "boom", message: "nope" }),
  });
  const r = await port.deliver({
    deliveryId: "d1", text: "hi", reason: "share", proactive: true,
  });
  expect(r.ok).toBe(false);
  expect(port.calls).toHaveLength(1);
});

it("PanelInboxAdapter stores messages with deliveredAt", async () => {
  const port = new PanelInboxAdapter(() => "2026-07-26T12:00:00.000Z");
  const r = await port.deliver({
    deliveryId: "d1", text: "hi", reason: "share", proactive: false,
  });
  expect(r).toEqual({ ok: true, deliveredAt: "2026-07-26T12:00:00.000Z" });
  expect(port.messages[0]?.deliveryId).toBe("d1");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement package + prepare-dist entry**

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run packages/channel/test/channel-adapters.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/channel scripts/prepare-dist.mjs package-lock.json
git commit -m "$(cat <<'EOF'
feat(channel): add ChannelPort with scripted and panel inbox adapters

EOF
)"
```

---

### Task 4: app — ExpressToUser delivery orchestration

**Files:**
- Create: `packages/app/src/delivery.ts`
- Modify: `packages/app/src/cognition-worker.ts` — optional `onCognitionAccepted` hook
- Modify: `packages/app/src/life-runtime.ts` — channel option, delivery after accept, deferred wake intercept
- Modify: `packages/app/package.json` — depend on `@oren/channel`
- Test: `packages/app/test/life-runtime-delivery.test.ts`

**Interfaces:**
- Consumes: Task 1–3 (`evaluateReachability`, LifeActor record*, `ChannelPort`).
- Produces:
  ```ts
  // packages/app/src/delivery.ts
  export async function deliverExpressProposals(input: {
    orenId: string;
    correlationId: string;
    triggerKind: TriggerKind;
    proposals: readonly Proposal[];
    state: LifeState;
    now: string;
    channel: ChannelPort;
    actor: LifeActor;
    nextId: () => string;
  }): Promise<void>;
  // For each ExpressToUser:
  //   proactive = triggerKind !== "foreground_user"
  //   decision = evaluateReachability(state.reachability, now, proactive)
  //   deliveryId = nextId()
  //   if defer → actor.recordMessageDeferred(...)
  //   else → channel.deliver → delivered | failed via actor

  // CognitionWorker constructor gains:
  // onCognitionAccepted?: (job: CognitionJob, proposals: readonly Proposal[]) => Promise<void>
  // after successful acceptCognition, await onCognitionAccepted?.(activeJob, outcome.proposals)

  // LifeRuntimeOptions:
  //   channelPort?: ChannelPort
  //   // default in tests: ScriptedChannelAdapter; if omitted, still construct Scripted no-op success so Express doesn't throw

  // Deferred wake: when claimed inbox event is WakeDue and purpose matches /^deliver:(.+)$/,
  // do NOT call handleInbox cognition path. Instead:
  //   commit WakeDue via a small actor.method OR repository.commitInbox accepting only WakeDue
  //   load MessageDeferred text by scanning recent events for deliveryId
  //   channel.deliver → recordMessageDelivered | recordMessageDeliveryFailed
  // Prefer: LifeActor.handleDeliverWake(claimed) that commits WakeDue + delivery result without CognitionRequested.
  ```

- [ ] **Step 1: Failing integration tests**

```typescript
it("foreground ExpressToUser delivers immediately via channel", async () => {
  const channel = new ScriptedChannelAdapter();
  const runtime = await LifeRuntime.create(db, cognitionThatExpresses("hello"), {
    now: () => "2026-07-26T23:00:00.000Z", // quiet hours
    channelPort: channel,
  });
  await runtime.initialize(...);
  await runtime.receiveUserMessage("hi");
  await runtime.drain();
  expect(channel.calls).toHaveLength(1);
  // state / events include MessageDelivered proactive:false
});

it("proactive ExpressToUser during quiet hours defers and does not call channel", async () => {
  // cognition on scheduled_wake returns ExpressToUser
  // expect channel.calls empty; MessageDeferred present; schedule purpose deliver:
});

it("deliver: wake completes deferred delivery without new cognition proposals requirement", async () => {
  // seed deferred + due schedule; drain; expect MessageDelivered and channel.calls length 1
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement delivery.ts, worker hook, runtime wiring, `LifeActor.handleDeliverWake`**

`handleDeliverWake` must:
1. Validate purpose `deliver:<id>`
2. Find latest `MessageDeferred` with that `deliveryId` in chronicle (repository load events) — if missing, commit WakeDue only / fail closed without deliver
3. `commitInbox` with `[WakeDue, MessageDelivered|Failed]` — **no** `CognitionRequested`

If existing `commitInbox` requires pairing patterns, follow the same API as `handleInbox` but without cognition request event.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run packages/app/test/life-runtime-delivery.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/app packages/kernel
git commit -m "$(cat <<'EOF'
feat(app): auto-deliver ExpressToUser with reachability gating

EOF
)"
```

---

### Task 5: `@oren/panel` — snapshot + loopback server

**Files:**
- Create: `packages/panel/package.json`
- Create: `packages/panel/src/types.ts`
- Create: `packages/panel/src/snapshot.ts` (pure assemblers if needed)
- Create: `packages/panel/src/server.ts`
- Create: `packages/panel/src/static/index.html` (minimal single page)
- Create: `packages/panel/src/index.ts`
- Modify: `scripts/prepare-dist.mjs` — add `panel`
- Test: `packages/panel/test/panel-server.test.ts`

**Interfaces:**
- Consumes: none of LifeRuntime at type level — inject callbacks.
- Produces:
  ```ts
  export type PanelSnapshot = {
    readonly inbox: ReadonlyArray<{
      deliveryId: string;
      text: string;
      reason: string;
      status: "delivered" | "deferred" | "failed";
      proactive?: boolean;
      deferUntil?: string;
      at: string;
    }>;
    readonly attention: LifeState["attention"]; // or structural copy
    readonly commitments: readonly Commitment[];
    readonly budgets: LifeState["budgets"];
    readonly grants: ReadonlyArray<{ grantId: string; capabilityPattern: string; revoked: boolean }>;
    readonly schedules: ReadonlyArray<{ scheduleId: string; dueAt: string; purpose: string }>;
    readonly actionLedger: ReadonlyArray<{ at: string; summary: string }>;
    readonly publicDiary: ReadonlyArray<{ at: string; text: string }>;
    readonly reachability: ReachabilityPolicy;
  };

  export type PanelHandlers = {
    getSnapshot: () => PanelSnapshot | Promise<PanelSnapshot>;
    postMessage: (text: string) => Promise<void>;
    updateReachability: (policy: ReachabilityPolicy, reason: string) => Promise<void>;
    revokeGrant: (grantId: string, reason: string) => Promise<void>;
    updateCommitment: (commitmentId: string, body: {
      status: CommitmentStatus;
      nextStep?: string;
      reason: string;
    }) => Promise<void>;
  };

  export type PanelServer = {
    readonly url: string; // http://127.0.0.1:<port>
    close(): Promise<void>;
  };

  export function createPanelServer(
    handlers: PanelHandlers,
    options?: { port?: number }, // host fixed 127.0.0.1
  ): Promise<PanelServer>;
  ```

Routes:
- `GET /api/snapshot` → JSON
- `POST /api/message` body `{ text }`
- `POST /api/reachability` body `{ policy, reason }`
- `POST /api/grants/:id/revoke` body `{ reason }`
- `POST /api/commitments/:id` body `{ status, nextStep?, reason }`
- `GET /` → static HTML

- [ ] **Step 1: Failing tests**

```typescript
it("serves snapshot on loopback only", async () => {
  const server = await createPanelServer({
    getSnapshot: () => minimalSnapshot(),
    postMessage: async () => {},
    updateReachability: async () => {},
    revokeGrant: async () => {},
    updateCommitment: async () => {},
  });
  const res = await fetch(`${server.url}/api/snapshot`);
  expect(res.ok).toBe(true);
  await server.close();
});

it("POST /api/message invokes handler", async () => {
  const texts: string[] = [];
  const server = await createPanelServer({
    ...noopHandlers,
    postMessage: async (text) => { texts.push(text); },
  });
  await fetch(`${server.url}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  expect(texts).toEqual(["hello"]);
  await server.close();
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement server with `node:http`; reject bind host ≠ 127.0.0.1; HTML: sections for inbox, commitments, grants, budgets, ledger; fetch snapshot on load; simple forms for message / revoke / commitment status**

Keep HTML/CSS minimal and readable — one column, no card dashboard clutter.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run packages/panel/test/panel-server.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/panel scripts/prepare-dist.mjs package-lock.json
git commit -m "$(cat <<'EOF'
feat(panel): add loopback life panel server and snapshot API

EOF
)"
```

---

### Task 6: LifeRuntime panel wiring + snapshot builder + write APIs

**Files:**
- Create: `packages/app/src/panel-snapshot.ts`
- Modify: `packages/app/src/life-runtime.ts`
- Modify: `packages/app/package.json` — `@oren/panel`
- Test: `packages/app/test/life-runtime-panel.test.ts`

**Interfaces:**
- Consumes: Task 4–5.
- Produces:
  ```ts
  // LifeRuntimeOptions:
  //   enablePanel?: boolean
  //   useProcessPanelEnv?: boolean  // when true, OREN_PANEL=1 enables panel
  //   panelPort?: number
  //   channelPort?: ChannelPort  // if enablePanel and no channelPort, use shared PanelInboxAdapter instance

  // LifeRuntime methods:
  getPanelSnapshot(): PanelSnapshot
  updateReachabilityPolicy(policy, reason): void
  revokeGrant(grantId, reason): void
  updateCommitmentStatus(commitmentId, body): void
  // receiveUserMessage already exists

  // buildPanelSnapshot(repo, state, inboxAdapter?, ...): PanelSnapshot
  // inbox: merge PanelInboxAdapter.messages with recent MessageDeferred/Failed from events
  // publicDiary: MessageDelivered texts
  // actionLedger: recent Effect* + Observation* summaries from events (limit 20)
  // schedules: repository list schedules for oren
  // grants: loadGrants including revoked (extend load if needed)
  ```

- [ ] **Step 1: Failing tests**

```typescript
it("updateReachabilityPolicy persists and shows in snapshot", async () => { /* ... */ });
it("revokeGrant marks grant revoked and Guard denies", async () => { /* ... */ });
it("enablePanel serves snapshot reflecting delivered message", async () => {
  const runtime = await LifeRuntime.create(..., {
    enablePanel: true,
    channelPort: undefined, // should install PanelInboxAdapter
  });
  // express via user message path; fetch runtime panel URL if exposed
});
```

Expose `runtime.panelUrl(): string | undefined` for tests.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement snapshot builder + runtime methods + start/stop panel in create/close**

On `enablePanel || (useProcessPanelEnv && process.env.OREN_PANEL === "1")`:
- Ensure `PanelInboxAdapter` is the channel (or fan-in: if custom channel provided, still record to inbox via wrapping — **YAGNI**: if `enablePanel` and no `channelPort`, use `PanelInboxAdapter`; if both, wrap: deliver to both scripted and inbox — simplest rule: **panel mode forces PanelInboxAdapter** unless `channelPort` explicitly passed (tests may pass PanelInboxAdapter).

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run packages/app/test/life-runtime-panel.test.ts packages/app/test/life-runtime-delivery.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/app
git commit -m "$(cat <<'EOF'
feat(app): wire life panel snapshot and controlled write APIs

EOF
)"
```

---

### Task 7: prompts, evals, README, smoke note

**Files:**
- Modify: `packages/pi-cognition/src/prompts.ts`
- Modify: `packages/pi-cognition/src/proposal-schema.ts` (if Task 2 left gaps)
- Test: `packages/pi-cognition/test/panel-prompts.test.ts`
- Modify: `packages/evals/src/scenarios.ts` — add s16/s17/s18
- Test: `packages/evals/test/channel-scenarios.test.ts`
- Modify: `README.md` — Phase 5 section
- Modify: `packages/app/src/smoke-runner.ts` — optional log of delivery/commitment when present (no hard fail without panel)
- Test: ensure `npm test` / `typecheck` / `build` green

**Interfaces:**
- Consumes: commitment proposals in schema; delivery covered by Task 4 app tests (eval harness remains cognition-proposal focused, same as Phase 3/4 split).
- Produces scenarios (locked):
  1. `s16-proactive-share` — user/wake context asks for a progress share; assert `ExpressToUser` with `text.trim().length >= 20` and not only a generic filler (reuse existing express-text helpers if any).
  2. `s17-commitment-advance` — user asks Oren to track/advance a shared commitment; assert `UpsertCommitment` or `UpdateCommitmentStatus`.
  3. `s18-commitment-pause` — user asks to pause autonomous advancement; assert `UpdateCommitmentStatus` with `status: "paused"` (or upsert with paused).

Also add `packages/evals/test/reachability-eval-note.test.ts` or fold into channel-scenarios: import `evaluateReachability` and assert quiet/frequency defer — keeps Phase 5 quiet-hours acceptance visible in evals package without requiring full LifeRuntime in harness.

- [ ] **Step 1: Failing prompt + scenario tests**

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement prompts section「分享与打扰」+「共同承诺」; scenarios; README「消息渠道与生活面板（Phase 5）」documenting `OREN_PANEL=1`, defaults, write APIs**

- [ ] **Step 4: Full verification**

Run:
```bash
npm test
npm run typecheck
npm run build
```
Expected: all green

- [ ] **Step 5: Commit**

```bash
git add packages/pi-cognition packages/evals packages/app README.md
git commit -m "$(cat <<'EOF'
feat: add Phase 5 prompts, eval scenarios, and panel docs

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Local web panel + same-surface delivery | 5, 6 |
| Runtime auto-deliver `ExpressToUser` | 4 |
| Reachability policy events + quiet/frequency | 1, 4 |
| `MessageDelivered` / `Deferred` / `Failed` | 1, 4 |
| Persistent `deliver:` wake | 1, 4 |
| Minimal commitments | 2, 6, 7 |
| Limited panel writes | 5, 6 |
| `@oren/channel` + `@oren/panel` | 3, 5 |
| Grant revoke event + API | 1, 6 |
| Offline tests; panel opt-in | Global + 5/6 |
| Prompts / evals / README | 7 |
| No second channel / no hard mute / no IM | Non-goals honored |

**Note:** Spec timezone locked to **UTC** (amended alongside this plan) for offline determinism.
