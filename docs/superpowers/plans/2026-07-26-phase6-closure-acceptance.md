# Phase 6 闭环验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付离线可重复的长期生命模拟（`@oren/sim` + 主场景 `s-closure-weeks`）与人工持续体验 runbook，完成第一版双重验收的工程腿。

**Architecture:** 新建 `@oren/sim`：可变 `VirtualClock` 注入已有 `LifeRuntime.create(..., { now })`；`ScenarioRunner` 按剧本步骤驱动 message / advance / restart / 故障注入 / 断言。认知用按序剧本 `CognitionPort`（基于 `@oren/cognition` 的 `ScriptedCognitionAdapter`）。网络故障用 sim 内 `GatedWebPort` / `GatedChannelPort` 包装假适配器，不强制改 web/channel 包。持续体验只写 runbook，不进 CI。

**Tech Stack:** TypeScript (ES2024, NodeNext, strict + exactOptionalPropertyTypes), node:sqlite, vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-26-phase6-closure-acceptance-design.md`

## Global Constraints

- `npm test` / `typecheck` / `build` 全绿且**完全离线**；禁止真实 LLM / 真实网络 / 启面板监听。
- `sim` 依赖 `app` 等；**禁止** `app` 反向依赖 `sim`。
- 虚拟时钟单调前进，禁止回拨；默认原点 `2026-01-01T00:00:00.000Z`。
- 不直写事件旁路（除 bootstrap 时用 `SqliteLifeRepository.initializeWithGrant` 播种高 `autonomyRemaining`，与现有 delivery 测试同模式）。
- `LifeRuntime.create(databasePath, cognition, options)` — cognition 是第 2 参，不在 options 内。
- 测试放 `packages/sim/test/*.test.ts`；每任务结束该任务测试 + 相关 typecheck 通过再提交。
- 改完 `packages/sim/package.json` 后必须 `npm install` 并提交更新后的 `package-lock.json`。

---

## File map

| Path | Responsibility |
|------|----------------|
| `packages/sim/package.json` | workspace 包 |
| `packages/sim/src/clock.ts` | `VirtualClock` |
| `packages/sim/src/steps.ts` | 步骤联合类型 |
| `packages/sim/src/scripted-cognition.ts` | 按序 / 按谓词剧本认知 |
| `packages/sim/src/assertions.ts` | 命名断言 |
| `packages/sim/src/network-gate.ts` | `GatedWebPort` / `GatedChannelPort` |
| `packages/sim/src/runner.ts` | `ScenarioRunner` + `SimReport` |
| `packages/sim/src/scenarios/closure-weeks.ts` | 主场景 |
| `packages/sim/src/sim.ts` | CLI |
| `packages/sim/src/index.ts` | barrel |
| `packages/sim/test/*.test.ts` | 单测 + 主场景 |
| `scripts/prepare-dist.mjs` | 加 `sim` symlink |
| `package.json` | `sim` script |
| `README.md` | Phase 6 小节 |
| `docs/superpowers/acceptance/phase6-continuous-experience-runbook.md` | 人工腿 |

---

### Task 1: `@oren/sim` scaffold + VirtualClock + step types

**Files:**
- Create: `packages/sim/package.json`
- Create: `packages/sim/src/clock.ts`
- Create: `packages/sim/src/steps.ts`
- Create: `packages/sim/src/index.ts`
- Create: `packages/sim/test/clock.test.ts`
- Modify: root `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: none from later tasks.
- Produces:
  ```ts
  // clock.ts
  export class VirtualClock {
    public constructor(startIso?: string); // default "2026-01-01T00:00:00.000Z"
    public now(): string; // canonical ISO UTC
    public advanceTo(iso: string): void; // throws if iso < now
    public advanceBy(ms: number): void; // throws if ms < 0
  }

  // steps.ts — discriminated union (runner implements handlers in later tasks)
  export type DurationMs = number;

  export type SimStep =
    | { readonly type: "advance"; readonly ms?: DurationMs; readonly to?: string; readonly drain?: boolean }
    | { readonly type: "message"; readonly text: string }
    | { readonly type: "restart" }
    | { readonly type: "swapCognition"; readonly scriptId: string }
    | { readonly type: "swapExtension"; readonly version: string }
    | { readonly type: "revokeGrant"; readonly grantId: string; readonly reason: string }
    | { readonly type: "failNetwork"; readonly failing: boolean; readonly targets?: readonly ("web" | "channel")[] }
    | { readonly type: "setReachability"; readonly quietHours: { start: string; end: string } | null; readonly maxProactivePerDay?: number }
    | { readonly type: "checkpoint"; readonly name: string }
    | { readonly type: "assert"; readonly name: string; readonly args?: Record<string, unknown> };
  ```

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@oren/sim",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/app": "*",
    "@oren/channel": "*",
    "@oren/cognition": "*",
    "@oren/extensions": "*",
    "@oren/kernel": "*",
    "@oren/memory": "*",
    "@oren/storage": "*",
    "@oren/test-counter": "*",
    "@oren/web": "*"
  }
}
```

- [ ] **Step 2: Write failing clock test**

```ts
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";

describe("VirtualClock", () => {
  it("starts at default origin and advances monotonically", () => {
    const clock = new VirtualClock();
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    clock.advanceBy(60_000);
    expect(clock.now()).toBe("2026-01-01T00:01:00.000Z");
    clock.advanceTo("2026-01-02T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects rewind and negative advanceBy", () => {
    const clock = new VirtualClock("2026-01-01T12:00:00.000Z");
    expect(() => clock.advanceTo("2026-01-01T11:00:00.000Z")).toThrow(/rewind|monotone/i);
    expect(() => clock.advanceBy(-1)).toThrow();
  });
});
```

- [ ] **Step 3: Run test — expect FAIL (module missing)**

Run: `npx vitest run packages/sim/test/clock.test.ts`
Expected: FAIL (cannot resolve `../src/clock.js`)

- [ ] **Step 4: Implement VirtualClock + steps + barrel**

`clock.ts`: parse with existing `canonicalizeInstant` from `@oren/kernel` if exported; otherwise validate via `Date.parse` and `new Date(ms).toISOString()`. Store ms internally; `now()` returns ISO. `advanceTo` / `advanceBy` enforce monotone.

`steps.ts`: export the `SimStep` union exactly as in Interfaces.

`index.ts`:
```ts
export * from "./clock.js";
export * from "./steps.js";
```

- [ ] **Step 5: npm install + pass tests**

Run:
```bash
npm install
npx vitest run packages/sim/test/clock.test.ts
npx tsc --noEmit -p packages/sim 2>/dev/null || npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sim package-lock.json
git commit -m "$(cat <<'EOF'
feat(sim): add VirtualClock and scenario step types

Scaffold @oren/sim with a monotone virtual clock as the foundation
for offline long-horizon life simulation.
EOF
)"
```

---

### Task 2: ScenarioRunner core + sequenced cognition

**Files:**
- Create: `packages/sim/src/scripted-cognition.ts`
- Create: `packages/sim/src/runner.ts`
- Create: `packages/sim/test/runner.test.ts`
- Modify: `packages/sim/src/index.ts`

**Interfaces:**
- Consumes: `VirtualClock`, `SimStep` from Task 1; `LifeRuntime.create(path, cognition, options)` from `@oren/app`.
- Produces:
  ```ts
  import type { CognitionOutcome, CognitionPort, LifeFrame } from "@oren/cognition";
  import type { Proposal } from "@oren/kernel";

  export type CognitionTurn =
    | { readonly proposals: readonly Proposal[] }
    | { readonly outcome: CognitionOutcome }
    | {
        readonly when: (frame: LifeFrame) => boolean;
        readonly proposals?: readonly Proposal[];
        readonly outcome?: CognitionOutcome;
      };

  export function createSequencedCognition(
    turns: readonly CognitionTurn[],
    options?: { readonly exhaust?: "no_action" | "fail" },
  ): CognitionPort;
  // Uses ScriptedCognitionAdapter under the hood.
  // Matching: first unused turn whose `when` matches (or no `when`);
  // exhaust default "no_action" → { kind:"completed", proposals:[{type:"NoAction", reason:"script exhausted"}], usage:{totalTokens:0} }

  export type ScenarioDefinition = {
    readonly id: string;
    readonly orenId?: string;      // default "oren-1"
    readonly personId?: string;    // default "person-1"
    readonly startIso?: string;
    readonly autonomyRemaining?: number; // default 64 — seeded via initializeWithGrant
    readonly scripts: Readonly<Record<string, CognitionPort>>; // key "default" required
    readonly extensionFactories?: Readonly<Record<string, () => import("@oren/extensions").OrenExtension>>;
    // key "default" optional — falls back to createTestCounterExtension
    readonly steps: readonly SimStep[];
  };

  export type SimReport = {
    readonly scenarioId: string;
    readonly ok: boolean;
    readonly stepsCompleted: number;
    readonly error?: string;
    readonly assertions: readonly { readonly name: string; readonly ok: boolean; readonly detail?: string }[];
  };

  export class ScenarioRunner {
    public async run(scenario: ScenarioDefinition): Promise<SimReport>;
  }
  ```

**Bootstrap (must document in code comments):**
1. temp dir + `life.db` path
2. `VirtualClock(startIso)`
3. Open `SqliteLifeRepository`, `initializeWithGrant` with:
   ```ts
   {
     ...createInitialLifeState(orenId, personId),
     budgets: {
       autonomyRemaining: scenario.autonomyRemaining ?? 64,
       interactionMaxSteps: 8,
       commitmentRemaining: {},
       webQuotaRemaining: 8,
     },
   }
   ```
   and grant `{ grantId: \`runtime:${orenId}:test-counter\`, capabilityPattern: "test.*", expiresAt: "9999-12-31T23:59:59.999Z", revoked: false }`
4. Close repo
5. Build gated web/channel (stubs OK in Task 2 — always succeeding; Task 3 wires real gates)
6. `LifeRuntime.create(dbPath, scripts.default, { now: () => clock.now(), nextId, embedder: new FakeEmbedder(), webPort, channelPort, extensionFactory })`
7. **Do not** call `initialize` again (identity already in DB)
8. Execute steps; always `close()` runtime in `finally`

**Task 2 step handlers only:** `advance`, `message`, `checkpoint` (store `inspect()` in map), `assert` (call placeholder that throws `Assertion not registered: ${name}` unless Task 3 registered — for Task 2 test only use checkpoint + a built-in `stateEquals` stub OR skip assert steps).  

Minimum for Task 2: implement `advance` + `message` + `checkpoint`; `assert` can delegate to an injectable `AssertionRegistry` that Task 3 fills — for now register one trivial `true` assert named `ok`.

- [ ] **Step 1: Write failing runner test**

```ts
import { describe, expect, it } from "vitest";
import { createSequencedCognition, ScenarioRunner } from "../src/index.js";

describe("ScenarioRunner", () => {
  it("runs message + advance with sequenced cognition and checkpoint", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "AdvanceThread", threadId: "thread-1", summary: "start clue" },
          { type: "ExpressToUser", text: "I heard you.", reason: "ack" },
          { type: "NoAction", reason: "done" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t2-smoke",
      scripts: { default: cognition },
      steps: [
        { type: "message", text: "hello" },
        { type: "checkpoint", name: "after-hello" },
        { type: "advance", ms: 3_600_000 },
        { type: "assert", name: "ok" },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.stepsCompleted).toBe(4);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run packages/sim/test/runner.test.ts`
Expected: FAIL (exports missing)

- [ ] **Step 3: Implement scripted-cognition + runner**

`scripted-cognition.ts`: wrap `ScriptedCognitionAdapter`; keep index of next turn; support `when` predicates.

`runner.ts` key behaviors:
- `message` → `runtime.receiveUserMessage(orenId, personId, text)` then `drain()`
- `advance` → `clock.advanceBy(ms)` or `advanceTo(to)` (require exactly one of ms/to); if `drain !== false`, call `drain()`
- `checkpoint` → `checkpoints.set(name, structuredClone(runtime.inspect(orenId)))`
- `assert` name `ok` → push `{ name:"ok", ok:true }`
- Unknown assert → fail report
- Catch step errors → `ok:false`, `error` with step index

Use `PanelInboxAdapter(() => clock.now())` as channel so later `getPanelSnapshot()` works.

For web in Task 2, pass a `ScriptedWebAdapter` with fixed safe public URLs:
```ts
new ScriptedWebAdapter({
  search: () => ({ results: [{ title: "Hit", url: "https://example.com/a", snippet: "s" }] }),
  read: () => ({ url: "https://example.com/a", title: "A", text: "body ".repeat(20) }),
})
```

- [ ] **Step 4: Pass tests**

Run: `npx vitest run packages/sim/test/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sim
git commit -m "$(cat <<'EOF'
feat(sim): add ScenarioRunner and sequenced cognition

Bootstrap a seeded LifeRuntime under a virtual clock and drive
message/advance/checkpoint steps for offline scenario playback.
EOF
)"
```

---

### Task 3: Assertion library

**Files:**
- Create: `packages/sim/src/assertions.ts`
- Create: `packages/sim/test/assertions.test.ts`
- Modify: `packages/sim/src/runner.ts` (wire registry)
- Modify: `packages/sim/src/index.ts`

**Interfaces:**
- Consumes: `ScenarioRunner` checkpoint map + live `LifeRuntime`.
- Produces:
  ```ts
  export type AssertContext = {
    readonly runtime: import("@oren/app").LifeRuntime;
    readonly orenId: string;
    readonly checkpoints: ReadonlyMap<string, import("@oren/kernel").LifeState>;
    readonly clock: import("./clock.js").VirtualClock;
    readonly args: Record<string, unknown>;
  };

  export type AssertionFn = (ctx: AssertContext) => void | Promise<void>; // throw on failure

  export const defaultAssertions: Readonly<Record<string, AssertionFn>>;
  // names from spec §5.1:
  // stateEquals — args: { a: checkpointName, b?: checkpointName }  (b omitted → compare a to live inspect)
  // replayMatches — args: { before: checkpointName } compare to live (used after restart)
  // threadContinues — live currentFocus non-null
  // commitmentProgressed — args: { since: checkpointName } — commitments differ in status/nextStep or new id
  // shareDelivered — getPanelSnapshot().inbox some status==="delivered" (optional args.proactive?: boolean)
  // noOverDisturb — from events via snapshot: no delivered proactive with at in quiet window if policy has quietHours;
  //                 and reachability.proactiveCountToday <= maxProactivePerDay
  // grantGone — args: { grantId: string } — !inspect().grantIds.includes(grantId)
  // budgetMonotone — args: { since: checkpointName } — webQuotaRemaining and autonomyRemaining <= since
  // ledgerIntact — getPanelSnapshot(); no duplicate completed effect ids in actionLedger if field exists;
  //                 simpler: pendingEffectIds empty OR no MessageDelivered with same deliveryId twice in inbox
  ```

Implementation notes for `noOverDisturb` / `shareDelivered`: use `runtime.getPanelSnapshot()` (works without HTTP panel; projects from events + PanelInboxAdapter).

For `replayMatches`: compare `version`, `attention`, `commitments`, `budgets`, `grantIds`, `reachability` (full object).

- [ ] **Step 1: Write failing assertion tests**

```ts
import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import { defaultAssertions } from "../src/assertions.js";

describe("defaultAssertions", () => {
  it("budgetMonotone fails when web quota rises", async () => {
    const orenId = "oren-1";
    const before = {
      ...createInitialLifeState(orenId, "person-1"),
      budgets: {
        autonomyRemaining: 10,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
        webQuotaRemaining: 5,
      },
    };
    const live = {
      ...before,
      budgets: { ...before.budgets, webQuotaRemaining: 8 },
    };
    const checkpoints = new Map([["c0", before]]);
    await expect(
      defaultAssertions.budgetMonotone!({
        runtime: { inspect: () => live } as never,
        orenId,
        checkpoints,
        clock: { now: () => "2026-01-01T00:00:00.000Z" } as never,
        args: { since: "c0" },
      }),
    ).rejects.toThrow(/quota|monotone|budget/i);
  });
});
```

Also add one integration case in `assertions.test.ts` or extend runner test: run a tiny scenario that expresses + asserts `shareDelivered`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/sim/test/assertions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement assertions + wire into runner**

In `runner.ts`, on `assert` step:
```ts
const fn = defaultAssertions[step.name];
if (!fn) throw new Error(`Unknown assertion: ${step.name}`);
await fn({ runtime, orenId, checkpoints, clock, args: step.args ?? {} });
```

Remove the Task 2 stub `ok` assert or keep it as `() => {}` in `defaultAssertions`.

- [ ] **Step 4: Pass tests**

Run: `npx vitest run packages/sim/test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sim
git commit -m "$(cat <<'EOF'
feat(sim): add named assertion library for closure scenarios

Cover replay, thread/commitment progress, share delivery, disturb
bounds, grants, budgets, and ledger sanity checks.
EOF
)"
```

---

### Task 4: Fault steps — restart, swap, revoke, network gate

**Files:**
- Create: `packages/sim/src/network-gate.ts`
- Create: `packages/sim/test/fault-steps.test.ts`
- Modify: `packages/sim/src/runner.ts`
- Modify: `packages/sim/src/index.ts`

**Interfaces:**
- Consumes: Task 2 runner bootstrap.
- Produces:
  ```ts
  export type NetworkGate = { failing: boolean; web: boolean; channel: boolean };

  export class GatedWebPort implements import("@oren/web").WebPort {
    public constructor(
      private readonly inner: import("@oren/web").WebPort,
      private readonly gate: NetworkGate,
    );
    // search/read: if gate.failing && gate.web → throw Error("sim_network_fault")
  }

  export class GatedChannelPort implements import("@oren/channel").ChannelPort {
    public constructor(
      private readonly inner: import("@oren/channel").ChannelPort,
      private readonly gate: NetworkGate,
    );
    // deliver: if gate.failing && gate.channel → { ok:false, code:"sim_network_fault", message:"..." }
    // else inner.deliver
  }
  ```

**Runner mutable session state:**
```ts
{
  cognitionKey: "default",
  extensionKey: "default",
  gate: { failing: false, web: true, channel: true },
}
```

**Step handlers:**

| Step | Behavior |
|------|----------|
| `failNetwork` | set `gate.failing`; if `targets` provided, set `gate.web`/`gate.channel` accordingly (only listed true) |
| `revokeGrant` | `runtime.revokeGrant(grantId, reason)` |
| `setReachability` | `runtime.updateReachabilityPolicy({ quietHours: ..., maxProactivePerDay, deferWhenQuiet: true }, "sim")` — match existing `ReachabilityPolicyInput` shape from app |
| `restart` | `await runtime.close()`; recreate with **same** `dbPath`, `clock`, `gate`, current cognition/extension keys, same web/channel gate wrappers (new inner PanelInboxAdapter is OK — events still project delivered mail) |
| `swapCognition` | set `cognitionKey = scriptId`; must exist in `scenario.scripts`; then same as restart (or restart-only swap — **require restart semantics**: close+create with new cognition) |
| `swapExtension` | set `extensionKey = version`; look up `extensionFactories[version]`; close+create |

Check `updateReachabilityPolicy` input type in `packages/app` / kernel — pass fields the API accepts (likely omits counters; counters stay event-sourced).

- [ ] **Step 1: Write failing fault-steps test**

```ts
import { createTestCounterExtension } from "@oren/test-counter";
import { describe, expect, it } from "vitest";
import { createSequencedCognition, ScenarioRunner } from "../src/index.js";

describe("ScenarioRunner fault steps", () => {
  it("revokes grant and asserts grantGone", async () => {
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-revoke",
      scripts: {
        default: createSequencedCognition([{ proposals: [{ type: "NoAction", reason: "n" }] }]),
      },
      steps: [
        { type: "revokeGrant", grantId: "runtime:oren-1:test-counter", reason: "sim revoke" },
        { type: "assert", name: "grantGone", args: { grantId: "runtime:oren-1:test-counter" } },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("restarts and replayMatches", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "AdvanceThread", threadId: "t1", summary: "clue" },
          { type: "NoAction", reason: "d" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-restart",
      scripts: { default: cognition },
      steps: [
        { type: "message", text: "go" },
        { type: "checkpoint", name: "pre" },
        { type: "restart" },
        { type: "assert", name: "replayMatches", args: { before: "pre" } },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("failNetwork on channel records delivery failure path without throwing runner", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "ExpressToUser", text: "ping", reason: "n" },
          { type: "NoAction", reason: "d" },
        ],
      },
    ]);
    // Force deliverable proactive window: midday + no quiet or outside quiet
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-net",
      startIso: "2026-01-01T12:00:00.000Z",
      scripts: { default: cognition },
      steps: [
        { type: "setReachability", quietHours: null, maxProactivePerDay: 10 },
        { type: "failNetwork", failing: true, targets: ["channel"] },
        { type: "message", text: "hi" },
        // foreground express still goes through channel — expect MessageDeliveryFailed in snapshot
        { type: "failNetwork", failing: false },
      ],
    });
    expect(report.ok).toBe(true);
    // Optional stronger assert: snapshot inbox has failed status — add assert helper or inline in test via second scenario
  });
});
```

For extension swap, include a factory map with `"1.0.0"` and `"1.1.0"` both from `createTestCounterExtension` but different `manifest.version` — restart with `swapExtension` must succeed.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/sim/test/fault-steps.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement network-gate + runner handlers**

Ensure `GatedChannelPort` still passes `instanceof PanelInboxAdapter` check **OR** change nothing — `getPanelSnapshot` only uses adapter when `instanceof PanelInboxAdapter`. After gating, instanceof fails → snapshot still builds inbox from **events** (`MessageDelivered` etc.). That is enough for assertions. Prefer wrapping PanelInboxAdapter anyway.

- [ ] **Step 4: Pass tests**

Run: `npx vitest run packages/sim/test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sim
git commit -m "$(cat <<'EOF'
feat(sim): add restart, swap, revoke, and network fault steps

Wire gated web/channel ports and runtime recreation so closure
scenarios can inject the core fault five-pack offline.
EOF
)"
```

---

### Task 5: Main scenario `s-closure-weeks`

**Files:**
- Create: `packages/sim/src/scenarios/closure-weeks.ts`
- Create: `packages/sim/test/closure-weeks.test.ts`
- Modify: `packages/sim/src/index.ts` (export scenario)

**Interfaces:**
- Consumes: full runner + assertions + fault steps.
- Produces:
  ```ts
  export const CLOSURE_WEEKS_SCENARIO_ID = "s-closure-weeks";
  export function buildClosureWeeksScenario(): ScenarioDefinition;
  ```

**Scenario script design (deterministic, ~2–3 virtual weeks):**

Use two cognition scripts: `default` and `model-b`.

`default` turns (illustrative — adjust counts so each `message` / wake consumes the right turn):

1. On first foreground: `UpsertCommitment` (goal, status active, nextStep, mayAdvanceAutonomously true) + `AdvanceThread` + `Remember` + `ScheduleWake` at clock+1d purpose `continue clue` + `ExpressToUser` ack
2. On scheduled_wake (clue): invoke `web.search` via capabilityPort if present, else skip; `Remember` / `AdvanceThread`; `ExpressToUser` proactive share; `ScheduleWake` further
3. Later turns: `UpdateCommitmentStatus` progress; `NoAction`

Quiet-hours share test:
- `setReachability` quietHours `{ start:"22:00", end:"08:00" }`
- `advance` to `...T23:00:00.000Z`
- Trigger proactive express (scheduled wake) → expect deferred (assert via custom step or checkpoint + panel inbox status deferred)
- `advance` to next morning `...T08:30:00.000Z` + `drain` → deliver wake → `shareDelivered` with proactive true

Then weave:
- `failNetwork` web true → attempt cognition that calls web.search → should not crash scenario (cognition turn catches / returns NoAction on failure) → `failNetwork` false
- `revokeGrant` test-counter → `grantGone`
- `swapExtension` to `1.1.0` (restart)
- `swapCognition` to `model-b` which continues `UpdateCommitmentStatus`
- mid `checkpoint` + `restart` + `replayMatches`
- final asserts: `threadContinues`, `commitmentProgressed`, `noOverDisturb`, `budgetMonotone`

**Extension factories:**
```ts
extensionFactories: {
  "default": createTestCounterExtension,
  "1.1.0": () => {
    const ext = createTestCounterExtension();
    return { ...ext, manifest: { ...ext.manifest, version: "1.1.0" } };
  },
}
```
Note: `createTestCounterExtension()` returns new object each call — OK.

**Web search in cognition:** only if `frame.capabilities` has `web.search`; use `capabilityPort.invoke`. If invoke rejected/failed, still complete with NoAction — scenario must not throw.

- [ ] **Step 1: Write failing closure-weeks test**

```ts
import { describe, expect, it } from "vitest";
import { ScenarioRunner } from "../src/runner.js";
import { buildClosureWeeksScenario, CLOSURE_WEEKS_SCENARIO_ID } from "../src/scenarios/closure-weeks.js";

describe("s-closure-weeks", () => {
  it("passes the offline closure scenario", async () => {
    const report = await new ScenarioRunner().run(buildClosureWeeksScenario());
    expect(report.scenarioId).toBe(CLOSURE_WEEKS_SCENARIO_ID);
    expect(report.ok).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run packages/sim/test/closure-weeks.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `buildClosureWeeksScenario`**

Keep steps explicit in the array (no hidden magic). Prefer ~15–40 steps, not hundreds.

If a step is flaky due to wake purpose matching, fix cognition `when: (frame) => frame.trigger.kind === "scheduled_wake" && frame.trigger.summary.includes(...)` — inspect actual trigger.summary from kernel WakeDue handling if needed.

- [ ] **Step 4: Pass tests**

Run: `npx vitest run packages/sim/test/closure-weeks.test.ts`
Expected: PASS

Also: `npx vitest run packages/sim/test`

- [ ] **Step 5: Commit**

```bash
git add packages/sim
git commit -m "$(cat <<'EOF'
feat(sim): add s-closure-weeks long-horizon offline scenario

Exercise thread, share, commitment, quiet-hours deferral, and the
core fault five-pack under a virtual multi-week clock.
EOF
)"
```

---

### Task 6: CLI, prepare-dist, README, runbook

**Files:**
- Create: `packages/sim/src/sim.ts`
- Create: `docs/superpowers/acceptance/phase6-continuous-experience-runbook.md`
- Modify: `packages/sim/src/index.ts` (if needed)
- Modify: `scripts/prepare-dist.mjs` — add `["sim", "packages/sim"]` and ensure `app` is already handled for runtime deps (sim CLI imports `@oren/app`; prepare-dist must symlink packages sim needs: at minimum `sim`, and app’s deps already listed — **also add `app` to prepare-dist if missing**)
- Modify: root `package.json` — `"sim": "npm run build && node --enable-source-maps dist/packages/sim/src/sim.js"`
- Modify: `README.md` — Phase 6 section

**Check prepare-dist:** current list has channel/panel/web/… but may omit `app`. Smoke uses `dist/packages/app/...` directly via path, not `@oren/app` from dist node_modules. Sim compiled JS will `import from "@oren/app"` — **must** add `["app", "packages/app"]` and `["sim", "packages/sim"]` to `prepare-dist.mjs` packages array (and any missing transitive workspace packages already present).

- [ ] **Step 1: Implement CLI**

```ts
// packages/sim/src/sim.ts
import { ScenarioRunner } from "./runner.js";
import { buildClosureWeeksScenario } from "./scenarios/closure-weeks.js";

export async function runSimCli(): Promise<number> {
  const report = await new ScenarioRunner().run(buildClosureWeeksScenario());
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const exitCode = await runSimCli();
process.exitCode = exitCode;
```

Mirror evals entry style (always run; no fragile `import.meta.url` guard).

- [ ] **Step 2: Wire package.json + prepare-dist**

Root scripts add `sim`. prepare-dist add `app` (if absent) + `sim`.

- [ ] **Step 3: Write runbook**

`docs/superpowers/acceptance/phase6-continuous-experience-runbook.md`:

```markdown
# Phase 6 持续体验验收 Runbook

> 人工腿；不进 CI。需真实模型凭据 + 可选 `OREN_PANEL=1`。

## 准备
1. 配置模型 API Key（与 smoke 相同）
2. `OREN_PANEL=1 npm run smoke` 或日常运行入口（按 README）
3. 打开面板 URL（日志中的 127.0.0.1）

## 勾选（客观）
- [ ] 自有线索：至少一次 `AdvanceThread` / 焦点延续可在面板或事件中看到
- [ ] 主动分享：至少一次有实质内容的 proactive / 用户可见分享
- [ ] 共同承诺：用户委托后 Oren 推进 `nextStep` 或 status，且授权可追溯

## 勾选（主观）
- [ ] 打扰可接受：未感到过度催促；安静策略行为符合预期

## 证据（可选）
面板截图或导出近期 inbox / commitments / grants 摘要。
```

- [ ] **Step 4: README Phase 6 小节**

Document: `npm run sim`（离线）、runbook 路径、与 Phase 5 面板关系。

- [ ] **Step 5: Verify**

```bash
npm test
npm run typecheck
npm run build
npm run sim
```

Expected: all green; `sim` prints `SimReport` with `"ok": true`.

- [ ] **Step 6: Commit**

```bash
git add packages/sim scripts/prepare-dist.mjs package.json README.md docs/superpowers/acceptance
git commit -m "$(cat <<'EOF'
feat(sim): add sim CLI, dist wiring, and continuous-experience runbook

Expose npm run sim for offline closure playback and document the
manual dual-acceptance experience checklist.
EOF
)"
```

---

## Self-review (author)

| Spec requirement | Task |
|------------------|------|
| `@oren/sim` VirtualClock + runner + steps | 1–2 |
| Scripted CognitionPort | 2 |
| Assertion library §5.1 | 3 |
| Fault five-pack | 4 |
| `s-closure-weeks` | 5 |
| `npm run sim` + prepare-dist | 6 |
| Continuous experience runbook | 6 |
| README | 6 |
| No ClockPort in kernel | honored |
| Offline CI | honored |

**Placeholder scan:** none intentional.  
**Type consistency:** `SimStep`, `ScenarioDefinition`, `SimReport`, `createSequencedCognition`, `NetworkGate` names stable across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-phase6-closure-acceptance.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
**2. Inline Execution** — execute in this session with checkpoints  

Which approach?
