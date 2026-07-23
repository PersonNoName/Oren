# Oren Life Kernel with Pi Cognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, deterministic Phase 1 vertical slice in which Oren persists her life state and reliable actions while `pi-agent-core` runs each bounded cognitive episode.

**Architecture:** A TypeScript modular monolith uses one event-sourced `LifeActor` per Oren and SQLite WAL for Chronicle, Inbox, Outbox, operations, grants, schedules, and snapshots. `@oren/pi-cognition` is the only package allowed to import Pi; it maps a `LifeFrame` to a Pi agent loop, exposes Oren capabilities as Pi tools, and returns typed proposals or a durable-effect suspension to the actor.

**Tech Stack:** Node.js 24.15+, npm 11.12+, strict ESM TypeScript 5.9.3, Vitest 3.2.4, built-in `node:sqlite`, TypeBox 1.1.38 inside the Pi adapter, `@earendil-works/pi-ai` 0.75.5, `@earendil-works/pi-agent-core` 0.75.5

## Global Constraints

- Follow `design/2026-07-22-oren-implementation-spine.md`.
- Only `LifeActor` may commit changes to `LifeState`.
- Events are facts, LLM output is an unaccepted `Proposal`, and external work is an `Effect`.
- `LifeActor` never waits for a model or extension while holding its single-writer transaction.
- Each cognition request records `baseStateVersion`; stale cognition results never mutate current state.
- Each Oren has at most one running cognitive episode.
- Foreground user input preempts an idle autonomous episode.
- `autonomyBudget` applies only to idle cognition; foreground interaction uses per-episode guardrails, not a daily quota.
- Persistent capabilities end the current Pi episode; their result starts a new episode through the Inbox.
- Immediate capabilities must be read-only, replay-safe, non-destructive, free of external side effects, and not use the user’s identity.
- Every external effect is persisted before dispatch and uses `effectId` as its idempotency key.
- An external result that may have happened but cannot be verified becomes `uncertain` and is never blindly retried.
- Oren owns the extension protocol. Do not depend on `@earendil-works/pi-coding-agent`.
- Only `packages/pi-cognition` may import `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, or TypeBox.
- Pin Pi packages to `0.75.5`; do not use caret or tilde ranges.
- The sibling `../pi` checkout at baseline commit `7c2775f6` is reference material and an optional local override, not an installation requirement.
- Phase 1 performs no real Web, purchasing, messaging, calendar, or production-model calls in automated tests.
- Tests use temporary or in-memory databases and never write under `data/` or `.oren-life/`.
- Every task follows red-green-refactor and ends with a focused commit.
- Before Phase 1 completion, run `npm test`, `npm run typecheck`, and `npm run build`.

---

## Locked Package and File Structure

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
packages/
  kernel/
    package.json
    src/
      ids.ts
      json.ts
      capability.ts
      protocol.ts
      state.ts
      reducer.ts
      ports.ts
      guard.ts
      life-actor.ts
      index.ts
    test/
      reducer.test.ts
      guard.test.ts
      life-actor.test.ts
  storage/
    package.json
    src/
      database.ts
      migrations.ts
      life-repository.ts
      index.ts
    test/
      life-repository.test.ts
      recovery.test.ts
  cognition/
    package.json
    src/
      types.ts
      life-frame.ts
      conductor.ts
      scripted-adapter.ts
      index.ts
    test/
      conductor.test.ts
  extensions/
    package.json
    src/
      sdk.ts
      registry.ts
      broker.ts
      index.ts
    test/
      broker.test.ts
  pi-cognition/
    package.json
    src/
      proposal-schema.ts
      prompts.ts
      tool-adapter.ts
      pi-cognition-adapter.ts
      index.ts
    test/
      fixtures.ts
      tool-adapter.test.ts
      pi-cognition-adapter.test.ts
  app/
    package.json
    src/
      cognition-worker.ts
      effect-dispatcher.ts
      scheduler.ts
      episode-coordinator.ts
      life-runtime.ts
      demo.ts
      index.ts
    test/
      effect-dispatcher.test.ts
      episode-coordinator.test.ts
      life-runtime.test.ts
extensions/
  test-counter/
    package.json
    src/
      index.ts
```

Dependency direction:

```text
kernel
  ↑
storage      cognition      extensions
                  ↑
             pi-cognition
                  ↑
                 app
```

`app` is the only composition root. `pi-cognition` receives a capability invoker port; it never imports the extension registry or runtime.

---

### Task 1: Bootstrap the Workspace and Freeze Domain Protocols

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `packages/kernel/package.json`
- Create: `packages/kernel/src/ids.ts`
- Create: `packages/kernel/src/json.ts`
- Create: `packages/kernel/src/capability.ts`
- Create: `packages/kernel/src/protocol.ts`
- Create: `packages/kernel/src/state.ts`
- Create: `packages/kernel/src/reducer.ts`
- Create: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/reducer.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `EventEnvelope`, `CoreEvent`, `Proposal`, `Effect`, `CapabilityDescriptor`, `LifeState`, `createInitialLifeState()`, `reduceLifeState()`

- [ ] **Step 1: Write the failing reducer test**

```ts
// packages/kernel/test/reducer.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  reduceLifeState,
  type EventEnvelope,
} from "../src/index.js";

describe("reduceLifeState", () => {
  it("replays accepted events into one deterministic state", () => {
    const initial = createInitialLifeState("oren-1", "person-1");
    const event: EventEnvelope = {
      eventId: "event-1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-23T00:00:00.000Z",
      recordedAt: "2026-07-23T00:00:00.000Z",
      source: "life-actor",
      causationId: null,
      correlationId: "corr-1",
      payload: {
        type: "ThreadAdvanced",
        threadId: "thread-1",
        summary: "Compare Pi and Oren boundaries",
      },
    };

    expect(reduceLifeState(initial, event)).toMatchObject({
      version: 1,
      attention: {
        currentFocus: "Compare Pi and Oren boundaries",
        activeThreadIds: ["thread-1"],
      },
      chronicleCursor: 1,
    });
  });
});
```

- [ ] **Step 2: Create workspace configuration and verify the test fails**

```json
// package.json
{
  "name": "oren",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "extensions/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "24.12.4",
    "typescript": "5.9.3",
    "vitest": "3.2.4"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"],
    "skipLibCheck": true
  },
  "include": ["packages/**/*.ts", "extensions/**/*.ts", "vitest.config.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
```

Run: `npm install && npm test -- packages/kernel/test/reducer.test.ts`

Expected: FAIL because `../src/index.js` does not exist.

- [ ] **Step 3: Add stable protocol and state types**

```ts
// packages/kernel/src/ids.ts
export type OrenId = string;
export type PersonId = string;
export type EventId = string;
export type CorrelationId = string;
export type CausationId = string;
export type EpisodeId = string;
export type EffectId = string;
export type OperationId = string;
export type GrantId = string;
export type ScheduleId = string;
export type ThreadId = string;
```

```ts
// packages/kernel/src/json.ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
```

```ts
// packages/kernel/src/capability.ts
import type { EffectId, GrantId, OrenId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";

export type CapabilityTrait =
  | "read_only"
  | "replay_safe"
  | "reversible"
  | "external_side_effect"
  | "uses_user_identity"
  | "uses_sensitive_data"
  | "billable"
  | "destructive";

export interface CapabilityDescriptor {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly permissionRequirements: readonly string[];
  readonly traits: readonly CapabilityTrait[];
  readonly cancellable: boolean;
  readonly timeoutMs: number;
}

export interface CapabilityInvocation {
  readonly effectId: EffectId;
  readonly orenId: OrenId;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly GrantId[];
  readonly stateVersion: number;
  readonly deadline: string;
}

export type CapabilityResult =
  | { readonly status: "completed"; readonly output: JsonValue; readonly receipt: JsonObject }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "uncertain"; readonly message: string };

export function isImmediateCapability(descriptor: CapabilityDescriptor): boolean {
  const traits = new Set(descriptor.traits);
  return traits.has("read_only")
    && traits.has("replay_safe")
    && !traits.has("external_side_effect")
    && !traits.has("uses_user_identity")
    && !traits.has("destructive");
}
```

```ts
// packages/kernel/src/protocol.ts
import type {
  CorrelationId,
  EffectId,
  EpisodeId,
  EventId,
  GrantId,
  OrenId,
  ScheduleId,
  ThreadId,
} from "./ids.js";
import type { JsonObject } from "./json.js";

export type TriggerKind =
  | "foreground_user"
  | "effect_result"
  | "commitment_due"
  | "scheduled_wake"
  | "health_check";

export type Proposal =
  | { readonly type: "NoAction"; readonly reason: string }
  | { readonly type: "AdvanceThread"; readonly threadId: ThreadId; readonly summary: string }
  | { readonly type: "UpdateDisposition"; readonly disposition: string; readonly reason: string }
  | { readonly type: "ExpressToUser"; readonly text: string; readonly reason: string }
  | { readonly type: "ScheduleWake"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string };

export interface Effect {
  readonly effectId: EffectId;
  readonly orenId: OrenId;
  readonly correlationId: CorrelationId;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly GrantId[];
  readonly stateVersion: number;
}

export type CoreEvent =
  | { readonly type: "OrenInitialized"; readonly personId: string }
  | { readonly type: "UserMessageReceived"; readonly personId: string; readonly text: string }
  | { readonly type: "ThreadAdvanced"; readonly threadId: ThreadId; readonly summary: string }
  | { readonly type: "DispositionUpdated"; readonly disposition: string; readonly reason: string }
  | { readonly type: "CognitionRequested"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly triggerKind: TriggerKind }
  | { readonly type: "CognitionCompleted"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly proposals: readonly Proposal[] }
  | { readonly type: "CognitionFailed"; readonly episodeId: EpisodeId; readonly message: string }
  | { readonly type: "EpisodeInterrupted"; readonly episodeId: EpisodeId; readonly reason: "foreground_user" | "shutdown" }
  | { readonly type: "EffectRequested"; readonly effect: Effect }
  | { readonly type: "EffectCompleted"; readonly effectId: EffectId; readonly receipt: JsonObject }
  | { readonly type: "EffectFailed"; readonly effectId: EffectId; readonly code: string; readonly message: string }
  | { readonly type: "EffectUncertain"; readonly effectId: EffectId; readonly message: string }
  | { readonly type: "WakeScheduled"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string }
  | { readonly type: "WakeDue"; readonly scheduleId: ScheduleId; readonly purpose: string };

export interface EventEnvelope {
  readonly eventId: EventId;
  readonly orenId: OrenId;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly source: string;
  readonly causationId: string | null;
  readonly correlationId: CorrelationId;
  readonly payload: CoreEvent;
}
```

```ts
// packages/kernel/src/state.ts
import type { OrenId, PersonId } from "./ids.js";

export interface LifeState {
  readonly orenId: OrenId;
  readonly version: number;
  readonly identity: {
    readonly ethosVersion: number;
    readonly currentDisposition: string;
  };
  readonly attention: {
    readonly activeThreadIds: readonly string[];
    readonly currentFocus: string | null;
    readonly unresolvedQuestions: readonly string[];
  };
  readonly relationship: {
    readonly primaryPersonId: PersonId;
    readonly currentContextRef: string | null;
  };
  readonly grantIds: readonly string[];
  readonly pendingEffectIds: readonly string[];
  readonly schedules: readonly string[];
  readonly budgets: {
    readonly autonomyRemaining: number;
    readonly interactionMaxSteps: number;
    readonly commitmentRemaining: Readonly<Record<string, number>>;
  };
  readonly chronicleCursor: number;
}

export function createInitialLifeState(orenId: OrenId, personId: PersonId): LifeState {
  return {
    orenId,
    version: 0,
    identity: { ethosVersion: 1, currentDisposition: "attentive" },
    attention: { activeThreadIds: [], currentFocus: null, unresolvedQuestions: [] },
    relationship: { primaryPersonId: personId, currentContextRef: null },
    grantIds: [],
    pendingEffectIds: [],
    schedules: [],
    budgets: { autonomyRemaining: 0, interactionMaxSteps: 8, commitmentRemaining: {} },
    chronicleCursor: 0,
  };
}
```

- [ ] **Step 4: Implement the deterministic reducer and exports**

```ts
// packages/kernel/src/reducer.ts
import type { EventEnvelope } from "./protocol.js";
import type { LifeState } from "./state.js";

export function reduceLifeState(state: LifeState, event: EventEnvelope): LifeState {
  const nextVersion = state.version + 1;
  const base = { ...state, version: nextVersion, chronicleCursor: state.chronicleCursor + 1 };

  switch (event.payload.type) {
    case "ThreadAdvanced": {
      const activeThreadIds = state.attention.activeThreadIds.includes(event.payload.threadId)
        ? state.attention.activeThreadIds
        : [...state.attention.activeThreadIds, event.payload.threadId].slice(-16);
      return {
        ...base,
        attention: {
          ...state.attention,
          activeThreadIds,
          currentFocus: event.payload.summary,
        },
      };
    }
    case "DispositionUpdated":
      return {
        ...base,
        identity: { ...state.identity, currentDisposition: event.payload.disposition },
      };
    case "EffectRequested":
      return {
        ...base,
        pendingEffectIds: [...state.pendingEffectIds, event.payload.effect.effectId],
      };
    case "EffectCompleted":
    case "EffectFailed":
    case "EffectUncertain":
      return {
        ...base,
        pendingEffectIds: state.pendingEffectIds.filter((id) => id !== event.payload.effectId),
      };
    case "WakeScheduled":
      return {
        ...base,
        schedules: state.schedules.includes(event.payload.scheduleId)
          ? state.schedules
          : [...state.schedules, event.payload.scheduleId],
      };
    default:
      return base;
  }
}
```

```ts
// packages/kernel/src/index.ts
export * from "./ids.js";
export * from "./json.js";
export * from "./capability.js";
export * from "./protocol.js";
export * from "./state.js";
export * from "./reducer.js";
```

```json
// packages/kernel/package.json
{
  "name": "@oren/kernel",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

Run: `npm test -- packages/kernel/test/reducer.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the frozen domain layer**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts packages/kernel
git commit -m "feat(kernel): freeze life protocol and reducer"
```

---

### Task 2: Implement SQLite Chronicle, Inbox, Outbox, and Recovery State

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/migrations.ts`
- Create: `packages/storage/src/life-repository.ts`
- Create: `packages/storage/src/index.ts`
- Test: `packages/storage/test/life-repository.test.ts`
- Test: `packages/storage/test/recovery.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope`, `Effect`, `LifeState`, `reduceLifeState()`
- Produces: `SqliteLifeRepository`, atomic `appendAndEnqueueEffects()`, durable Inbox/Outbox/operation/schedule leases

- [ ] **Step 1: Write failing persistence and restart tests**

```ts
// packages/storage/test/life-repository.test.ts
import { describe, expect, it } from "vitest";
import { createInitialLifeState, type EventEnvelope } from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("SqliteLifeRepository", () => {
  it("commits an event and outbox effect atomically", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    const event = {
      eventId: "event-1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-23T00:00:00.000Z",
      recordedAt: "2026-07-23T00:00:00.000Z",
      source: "life-actor",
      causationId: null,
      correlationId: "corr-1",
      payload: {
        type: "EffectRequested",
        effect: {
          effectId: "effect-1",
          orenId: "oren-1",
          correlationId: "corr-1",
          capability: "test.increment",
          arguments: { by: 1 },
          grantIds: ["grant-1"],
          stateVersion: 0,
        },
      },
    } satisfies EventEnvelope;

    repo.appendAndEnqueueEffects("oren-1", [event], [event.payload.effect]);

    expect(repo.loadEvents("oren-1")).toHaveLength(1);
    expect(repo.claimOutbox("worker-1", 1)[0]?.effectId).toBe("effect-1");
  });
});
```

```ts
// packages/storage/test/recovery.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("repository recovery", () => {
  it("reclaims an expired outbox lease after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-"));
    const path = join(directory, "life.db");
    const first = new SqliteLifeRepository(openDatabase(path));
    first.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    expect(first.claimOutbox("dead-worker", 1, "2026-07-23T00:00:00.000Z")).toHaveLength(1);
    first.close();

    const second = new SqliteLifeRepository(openDatabase(path));
    expect(second.claimOutbox("live-worker", 1, "2026-07-23T00:10:00.000Z")).toHaveLength(1);
    second.close();
  });
});
```

- [ ] **Step 2: Run tests and verify missing storage exports**

Run: `npm test -- packages/storage/test`

Expected: FAIL because `@oren/storage` does not exist.

- [ ] **Step 3: Add schema and database initialization**

```ts
// packages/storage/src/database.ts
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}
```

```ts
// packages/storage/src/migrations.ts
import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      oren_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_oren ON events(oren_id, sequence);

    CREATE TABLE IF NOT EXISTS snapshots (
      oren_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      cursor INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox (
      inbox_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS outbox (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
      lease_owner TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS operations (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      grant_json TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      delivered_at TEXT
    );
  `);
}
```

- [ ] **Step 4: Implement repository transactions and leases**

```ts
// packages/storage/src/life-repository.ts
import type { DatabaseSync } from "node:sqlite";
import {
  reduceLifeState,
  type Effect,
  type EventEnvelope,
  type JsonObject,
  type LifeState,
} from "@oren/kernel";

interface OutboxRow {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: Effect;
  readonly attempts: number;
}

export class SqliteLifeRepository {
  public constructor(private readonly db: DatabaseSync) {}

  public close(): void {
    this.db.close();
  }

  public initialize(state: LifeState): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO snapshots(oren_id, version, cursor, state_json)
      VALUES (?, ?, ?, ?)
    `).run(state.orenId, state.version, state.chronicleCursor, JSON.stringify(state));
  }

  public loadEvents(orenId: string): EventEnvelope[] {
    return this.db.prepare(`
      SELECT envelope_json FROM events WHERE oren_id = ? ORDER BY sequence
    `).all(orenId).map((row) => JSON.parse(String(row.envelope_json)) as EventEnvelope);
  }

  public rehydrate(orenId: string): LifeState {
    const row = this.db.prepare(`SELECT state_json FROM snapshots WHERE oren_id = ?`).get(orenId);
    if (!row) throw new Error(`Missing initial snapshot for ${orenId}`);
    return this.loadEvents(orenId).reduce(
      reduceLifeState,
      JSON.parse(String(row.state_json)) as LifeState,
    );
  }

  public appendAndEnqueueEffects(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertEvent = this.db.prepare(`
        INSERT INTO events(event_id, oren_id, recorded_at, envelope_json) VALUES (?, ?, ?, ?)
      `);
      for (const event of events) {
        insertEvent.run(event.eventId, orenId, event.recordedAt, JSON.stringify(event));
        if (event.payload.type === "WakeScheduled") {
          this.db.prepare(`
            INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(schedule_id) DO UPDATE SET
              due_at = excluded.due_at,
              purpose = excluded.purpose,
              delivered_at = NULL
          `).run(
            event.payload.scheduleId,
            orenId,
            event.payload.at,
            event.payload.purpose,
          );
        }
      }
      const insertEffect = this.db.prepare(`
        INSERT INTO outbox(effect_id, oren_id, capability, effect_json, status)
        VALUES (?, ?, ?, ?, 'pending')
      `);
      for (const effect of effects) {
        insertEffect.run(effect.effectId, orenId, effect.capability, JSON.stringify(effect));
        this.db.prepare(`
          INSERT INTO operations(effect_id, oren_id, capability, status)
          VALUES (?, ?, ?, 'pending')
        `).run(effect.effectId, orenId, effect.capability);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public enqueueRawEffect(
    orenId: string,
    effectId: string,
    capability: string,
    arguments_: JsonObject,
  ): void {
    const effect: Effect = {
      effectId,
      orenId,
      correlationId: effectId,
      capability,
      arguments: arguments_,
      grantIds: [],
      stateVersion: 0,
    };
    this.db.prepare(`
      INSERT INTO outbox(effect_id, oren_id, capability, effect_json, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(effectId, orenId, capability, JSON.stringify(effect));
    this.db.prepare(`
      INSERT INTO operations(effect_id, oren_id, capability, status)
      VALUES (?, ?, ?, 'pending')
    `).run(effectId, orenId, capability);
  }

  public claimOutbox(worker: string, limit: number, now = new Date().toISOString()): OutboxRow[] {
    const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT effect_id, oren_id, capability, effect_json, attempts
        FROM outbox
        WHERE status IN ('pending','dispatched')
          AND (lease_until IS NULL OR lease_until < ?)
        ORDER BY rowid
        LIMIT ?
      `).all(now, limit);
      const lease = this.db.prepare(`
        UPDATE outbox
        SET status = 'dispatched', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE effect_id = ?
      `);
      for (const row of rows) lease.run(worker, leaseUntil, String(row.effect_id));
      for (const row of rows) {
        this.db.prepare(`
          UPDATE operations
          SET status = 'dispatched', attempts = attempts + 1
          WHERE effect_id = ?
        `).run(String(row.effect_id));
      }
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        effectId: String(row.effect_id),
        orenId: String(row.oren_id),
        capability: String(row.capability),
        effect: JSON.parse(String(row.effect_json)) as Effect,
        attempts: Number(row.attempts) + 1,
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
```

```ts
// packages/storage/src/index.ts
export * from "./database.js";
export * from "./life-repository.js";
```

```json
// packages/storage/package.json
{
  "name": "@oren/storage",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/kernel": "*"
  }
}
```

Run: `npm test -- packages/storage/test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit durable storage**

```bash
git add packages/storage
git commit -m "feat(storage): add durable life repository"
```

---

### Task 3: Add Grants, Budgets, and Deterministic Guard Decisions

**Files:**
- Create: `packages/kernel/src/guard.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/storage/src/life-repository.ts`
- Test: `packages/kernel/test/guard.test.ts`

**Interfaces:**
- Consumes: `Proposal`, `CapabilityDescriptor`, `LifeState`
- Produces: `Grant`, `GuardDecision`, `Guard.evaluate()`

- [ ] **Step 1: Write failing tests for foreground and autonomous budget behavior**

```ts
// packages/kernel/test/guard.test.ts
import { describe, expect, it } from "vitest";
import { createInitialLifeState, Guard, type Grant } from "../src/index.js";

const grant: Grant = {
  grantId: "grant-1",
  capabilityPattern: "test.*",
  expiresAt: "2026-08-01T00:00:00.000Z",
  revoked: false,
};

describe("Guard", () => {
  it("does not charge the autonomy budget for foreground cognition", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const decision = new Guard().evaluateCognition(state, "foreground_user", 3);
    expect(decision).toEqual({ allowed: true, autonomyCost: 0 });
  });

  it("requires a live grant for a persistent capability", () => {
    const decision = new Guard().evaluateCapability({
      capability: "test.increment",
      grants: [grant],
      now: "2026-07-23T00:00:00.000Z",
    });
    expect(decision.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the guard test and verify it fails**

Run: `npm test -- packages/kernel/test/guard.test.ts`

Expected: FAIL because `Guard` and `Grant` are not exported.

- [ ] **Step 3: Implement explicit guard inputs and pure decisions**

```ts
// packages/kernel/src/guard.ts
import type { TriggerKind } from "./protocol.js";
import type { LifeState } from "./state.js";

export interface Grant {
  readonly grantId: string;
  readonly capabilityPattern: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export type GuardDecision =
  | { readonly allowed: true; readonly autonomyCost: number }
  | { readonly allowed: false; readonly reason: string };

function matches(pattern: string, capability: string): boolean {
  return pattern.endsWith("*")
    ? capability.startsWith(pattern.slice(0, -1))
    : pattern === capability;
}

export class Guard {
  public evaluateCognition(
    state: LifeState,
    trigger: TriggerKind,
    requestedSteps: number,
  ): GuardDecision {
    if (requestedSteps > state.budgets.interactionMaxSteps) {
      return { allowed: false, reason: "episode_step_limit" };
    }
    if (trigger === "foreground_user" || trigger === "effect_result") {
      return { allowed: true, autonomyCost: 0 };
    }
    if (state.budgets.autonomyRemaining < requestedSteps) {
      return { allowed: false, reason: "autonomy_budget_exhausted" };
    }
    return { allowed: true, autonomyCost: requestedSteps };
  }

  public evaluateCapability(input: {
    readonly capability: string;
    readonly grants: readonly Grant[];
    readonly now: string;
  }): GuardDecision {
    const grant = input.grants.find((candidate) =>
      !candidate.revoked
      && candidate.expiresAt > input.now
      && matches(candidate.capabilityPattern, input.capability));
    return grant
      ? { allowed: true, autonomyCost: 0 }
      : { allowed: false, reason: "missing_or_expired_grant" };
  }
}
```

- [ ] **Step 4: Export and verify deterministic decisions**

```ts
// append to packages/kernel/src/index.ts
export * from "./guard.js";
```

```ts
// add to packages/storage/src/life-repository.ts
import type { Grant } from "@oren/kernel";

public putGrant(orenId: string, grant: Grant): void {
  this.db.prepare(`
    INSERT INTO grants(grant_id, oren_id, grant_json, revoked_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(grant_id) DO UPDATE SET grant_json = excluded.grant_json
  `).run(grant.grantId, orenId, JSON.stringify(grant));
}

public loadGrants(orenId: string): Grant[] {
  return this.db.prepare(`
    SELECT grant_json FROM grants WHERE oren_id = ? AND revoked_at IS NULL
  `).all(orenId).map((row) => JSON.parse(String(row.grant_json)) as Grant);
}
```

Run: `npm test -- packages/kernel/test/guard.test.ts packages/storage/test/life-repository.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the guard**

```bash
git add packages/kernel packages/storage
git commit -m "feat(kernel): enforce grants and cognition budgets"
```

---

### Task 4: Implement the Single-Writer LifeActor and Async Cognition Requests

**Files:**
- Create: `packages/kernel/src/ports.ts`
- Create: `packages/kernel/src/life-actor.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/life-actor.test.ts`

**Interfaces:**
- Consumes: durable Inbox events and `LifeRepositoryPort`
- Produces: `LifeActor.handleUserMessage()`, `LifeActor.acceptCognition()`, `LifeActor.requestEffect()`, `CognitionJob`

- [ ] **Step 1: Write a failing test showing the actor schedules cognition without awaiting it**

```ts
// packages/kernel/test/life-actor.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  LifeActor,
  type CognitionJob,
  type EventEnvelope,
  type LifeRepositoryPort,
} from "../src/index.js";

describe("LifeActor", () => {
  it("persists CognitionRequested and returns a job immediately", () => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: (_orenId, accepted) => events.push(...accepted),
      commitInbox: (_inboxId, _orenId, accepted) => events.push(...accepted),
    };
    let id = 0;
    const actor = new LifeActor(
      repository,
      () => `id-${++id}`,
      () => "2026-07-23T00:00:00.000Z",
    );

    const job = actor.handleUserMessage("oren-1", "person-1", "hello");

    expect(job).toMatchObject<CognitionJob>({
      orenId: "oren-1",
      episodeId: "id-1",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
    });
    expect(events.map((event) => event.payload.type)).toEqual([
      "UserMessageReceived",
      "CognitionRequested",
    ]);
  });

  it("rejects a cognition result based on an older state version", () => {
    const state = {
      ...createInitialLifeState("oren-1", "person-1"),
      version: 3,
    };
    const repository: LifeRepositoryPort = {
      loadState: () => state,
      commit: () => { throw new Error("stale result must not commit"); },
      commitInbox: () => { throw new Error("stale result must not commit"); },
    };
    const actor = new LifeActor(repository, () => "id", () => "2026-07-23T00:00:00.000Z");

    expect(actor.acceptCognition({
      orenId: "oren-1",
      episodeId: "episode-old",
      baseStateVersion: 2,
      triggerKind: "health_check",
      correlationId: "corr-old",
    }, [{ type: "NoAction", reason: "nothing" }])).toEqual({
      accepted: false,
      reason: "stale_state_version",
    });
  });
});
```

- [ ] **Step 2: Run the actor test and verify missing interfaces**

Run: `npm test -- packages/kernel/test/life-actor.test.ts`

Expected: FAIL because `LifeRepositoryPort`, `CognitionJob`, and `LifeActor` do not exist.

- [ ] **Step 3: Define ports and cognition job**

```ts
// packages/kernel/src/ports.ts
import type { EventEnvelope, TriggerKind } from "./protocol.js";
import type { LifeState } from "./state.js";

export interface LifeRepositoryPort {
  loadState(orenId: string): LifeState;
  commit(orenId: string, events: readonly EventEnvelope[]): void;
  commitInbox(inboxId: string, orenId: string, events: readonly EventEnvelope[]): void;
}

export interface CognitionJob {
  readonly orenId: string;
  readonly episodeId: string;
  readonly baseStateVersion: number;
  readonly triggerKind: TriggerKind;
  readonly correlationId: string;
}
```

- [ ] **Step 4: Implement short actor transactions and stale-result rejection**

```ts
// packages/kernel/src/life-actor.ts
import type { Effect, EventEnvelope, Proposal } from "./protocol.js";
import type { CognitionJob, LifeRepositoryPort } from "./ports.js";

export class LifeActor {
  public constructor(
    private readonly repository: LifeRepositoryPort,
    private readonly nextId: () => string,
    private readonly now: () => string,
  ) {}

  public handleUserMessage(orenId: string, personId: string, text: string): CognitionJob {
    const before = this.repository.loadState(orenId);
    const episodeId = this.nextId();
    const correlationId = this.nextId();
    const received = this.envelope(orenId, correlationId, {
      type: "UserMessageReceived",
      personId,
      text,
    });
    const requested = this.envelope(orenId, correlationId, {
      type: "CognitionRequested",
      episodeId,
      baseStateVersion: before.version + 2,
      triggerKind: "foreground_user",
    });
    this.repository.commit(orenId, [received, requested]);
    return {
      orenId,
      episodeId,
      baseStateVersion: before.version + 2,
      triggerKind: "foreground_user",
      correlationId,
    };
  }

  public acceptCognition(
    job: CognitionJob,
    proposals: readonly Proposal[],
  ): { readonly accepted: boolean; readonly reason?: string } {
    const current = this.repository.loadState(job.orenId);
    if (current.version !== job.baseStateVersion) {
      return { accepted: false, reason: "stale_state_version" };
    }
    const completed = this.envelope(job.orenId, job.correlationId, {
      type: "CognitionCompleted",
      episodeId: job.episodeId,
      baseStateVersion: job.baseStateVersion,
      proposals,
    });
    const accepted = proposals.flatMap((proposal): EventEnvelope[] => {
      switch (proposal.type) {
        case "AdvanceThread":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "ThreadAdvanced",
            threadId: proposal.threadId,
            summary: proposal.summary,
          })];
        case "UpdateDisposition":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "DispositionUpdated",
            disposition: proposal.disposition,
            reason: proposal.reason,
          })];
        case "ScheduleWake":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "WakeScheduled",
            scheduleId: proposal.scheduleId,
            at: proposal.at,
            purpose: proposal.purpose,
          })];
        case "NoAction":
        case "ExpressToUser":
          return [];
      }
    });
    this.repository.commit(job.orenId, [completed, ...accepted]);
    return { accepted: true };
  }

  public requestEffect(
    orenId: string,
    correlationId: string,
    effect: Effect,
  ): { readonly accepted: boolean; readonly reason?: string } {
    const current = this.repository.loadState(orenId);
    if (current.version !== effect.stateVersion) {
      return { accepted: false, reason: "stale_state_version" };
    }
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, { type: "EffectRequested", effect }),
    ]);
    return { accepted: true };
  }

  public recordCognitionExit(
    job: CognitionJob,
    exit:
      | { readonly kind: "failed"; readonly message: string }
      | { readonly kind: "aborted"; readonly reason: "foreground_user" | "shutdown" },
  ): void {
    const payload: EventEnvelope["payload"] = exit.kind === "failed"
      ? { type: "CognitionFailed", episodeId: job.episodeId, message: exit.message }
      : { type: "EpisodeInterrupted", episodeId: job.episodeId, reason: exit.reason };
    this.repository.commit(job.orenId, [
      this.envelope(job.orenId, job.correlationId, payload),
    ]);
  }

  private envelope(
    orenId: string,
    correlationId: string,
    payload: EventEnvelope["payload"],
  ): EventEnvelope {
    const timestamp = this.now();
    return {
      eventId: this.nextId(),
      orenId,
      schemaVersion: 1,
      occurredAt: timestamp,
      recordedAt: timestamp,
      source: "life-actor",
      causationId: null,
      correlationId,
      payload,
    };
  }
}
```

```ts
// append to packages/kernel/src/index.ts
export * from "./ports.js";
export * from "./life-actor.js";
```

Run: `npm test -- packages/kernel/test/life-actor.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the actor**

```bash
git add packages/kernel
git commit -m "feat(kernel): add asynchronous single-writer life actor"
```

---

### Task 5: Define LifeFrame, CognitionPort, and Deterministic Conductor Tests

**Files:**
- Create: `packages/cognition/package.json`
- Create: `packages/cognition/src/types.ts`
- Create: `packages/cognition/src/life-frame.ts`
- Create: `packages/cognition/src/conductor.ts`
- Create: `packages/cognition/src/scripted-adapter.ts`
- Create: `packages/cognition/src/index.ts`
- Test: `packages/cognition/test/conductor.test.ts`

**Interfaces:**
- Consumes: `CognitionJob`, `LifeState`, `CapabilityDescriptor`
- Produces: `LifeFrame`, `CognitionPort.run()`, `CognitionOutcome`, `Conductor.createFrame()`

- [ ] **Step 1: Write a failing bounded-frame test**

```ts
// packages/cognition/test/conductor.test.ts
import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import { Conductor } from "../src/index.js";

describe("Conductor", () => {
  it("builds a bounded LifeFrame with capability summaries", () => {
    const frame = new Conductor().createFrame({
      state: createInitialLifeState("oren-1", "person-1"),
      correlationId: "corr-1",
      trigger: { kind: "foreground_user", summary: "hello" },
      capabilities: [{
        extensionId: "test",
        name: "test.read",
        description: "Read a deterministic value",
        inputSchema: { type: "object" },
        outputSchema: { type: "number" },
        permissionRequirements: [],
        traits: ["read_only", "replay_safe"],
        cancellable: true,
        timeoutMs: 1000,
      }],
      maxSteps: 8,
    });

    expect(frame).toMatchObject({
      orenId: "oren-1",
      stateVersion: 0,
      trigger: { kind: "foreground_user" },
      maxSteps: 8,
    });
    expect(frame.capabilities[0]?.name).toBe("test.read");
  });
});
```

- [ ] **Step 2: Run the test and verify the package is absent**

Run: `npm test -- packages/cognition/test/conductor.test.ts`

Expected: FAIL because `@oren/cognition` does not exist.

- [ ] **Step 3: Define cognition boundaries**

```ts
// packages/cognition/src/types.ts
import type {
  CapabilityDescriptor,
  JsonObject,
  JsonValue,
  Proposal,
  TriggerKind,
} from "@oren/kernel";

export interface LifeFrame {
  readonly orenId: string;
  readonly correlationId: string;
  readonly stateVersion: number;
  readonly identity: { readonly ethosVersion: number; readonly disposition: string };
  readonly attention: { readonly focus: string | null; readonly threadIds: readonly string[] };
  readonly relationship: { readonly primaryPersonId: string; readonly contextRef: string | null };
  readonly trigger: { readonly kind: TriggerKind; readonly summary: string };
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly maxSteps: number;
}

export type CapabilityInvocationOutcome =
  | { readonly kind: "completed"; readonly output: JsonValue }
  | { readonly kind: "waiting_for_effect"; readonly effectId: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface CognitionCapabilityPort {
  invoke(input: {
    readonly orenId: string;
    readonly descriptor: CapabilityDescriptor;
    readonly arguments: JsonObject;
    readonly stateVersion: number;
    readonly correlationId: string;
  }): Promise<CapabilityInvocationOutcome>;
}

export type CognitionOutcome =
  | { readonly kind: "completed"; readonly proposals: readonly Proposal[]; readonly usage: { readonly totalTokens: number } }
  | { readonly kind: "waiting_for_effect"; readonly effectId: string; readonly usage: { readonly totalTokens: number } }
  | { readonly kind: "failed"; readonly message: string; readonly usage: { readonly totalTokens: number } }
  | { readonly kind: "aborted"; readonly usage: { readonly totalTokens: number } };

export interface CognitionPort {
  run(frame: LifeFrame, capabilityPort: CognitionCapabilityPort, signal: AbortSignal): Promise<CognitionOutcome>;
}
```

```ts
// packages/cognition/src/life-frame.ts
import type { CapabilityDescriptor, LifeState, TriggerKind } from "@oren/kernel";
import type { LifeFrame } from "./types.js";

export interface CreateFrameInput {
  readonly state: LifeState;
  readonly correlationId: string;
  readonly trigger: { readonly kind: TriggerKind; readonly summary: string };
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly maxSteps: number;
}

export function createLifeFrame(input: CreateFrameInput): LifeFrame {
  return {
    orenId: input.state.orenId,
    correlationId: input.correlationId,
    stateVersion: input.state.version,
    identity: {
      ethosVersion: input.state.identity.ethosVersion,
      disposition: input.state.identity.currentDisposition,
    },
    attention: {
      focus: input.state.attention.currentFocus,
      threadIds: input.state.attention.activeThreadIds.slice(0, 16),
    },
    relationship: {
      primaryPersonId: input.state.relationship.primaryPersonId,
      contextRef: input.state.relationship.currentContextRef,
    },
    trigger: input.trigger,
    capabilities: input.capabilities,
    maxSteps: input.maxSteps,
  };
}
```

- [ ] **Step 4: Add the conductor and scripted adapter**

```ts
// packages/cognition/src/conductor.ts
import { createLifeFrame, type CreateFrameInput } from "./life-frame.js";

export class Conductor {
  public createFrame(input: CreateFrameInput) {
    return createLifeFrame(input);
  }
}
```

```ts
// packages/cognition/src/scripted-adapter.ts
import type {
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "./types.js";

export type CognitionScript = (
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
  signal: AbortSignal,
) => Promise<CognitionOutcome>;

export class ScriptedCognitionAdapter implements CognitionPort {
  public constructor(private readonly script: CognitionScript) {}

  public async run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome> {
    return signal.aborted
      ? { kind: "aborted", usage: { totalTokens: 0 } }
      : this.script(frame, capabilityPort, signal);
  }
}
```

```ts
// packages/cognition/src/index.ts
export * from "./types.js";
export * from "./life-frame.js";
export * from "./conductor.js";
export * from "./scripted-adapter.js";
```

```json
// packages/cognition/package.json
{
  "name": "@oren/cognition",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/kernel": "*"
  }
}
```

Run: `npm test -- packages/cognition/test/conductor.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit cognition ports**

```bash
git add packages/cognition
git commit -m "feat(cognition): define bounded life frames and port"
```

---

### Task 6: Build the Oren Extension SDK, Registry, and Double-Lane Broker

**Files:**
- Create: `packages/extensions/package.json`
- Create: `packages/extensions/src/sdk.ts`
- Create: `packages/extensions/src/registry.ts`
- Create: `packages/extensions/src/broker.ts`
- Create: `packages/extensions/src/index.ts`
- Create: `extensions/test-counter/package.json`
- Create: `extensions/test-counter/src/index.ts`
- Test: `packages/extensions/test/broker.test.ts`

**Interfaces:**
- Consumes: Oren capability protocol and `Guard`
- Produces: `OrenExtension`, `ExtensionRegistry`, `CapabilityBroker.invoke()`, immediate-versus-persistent routing

- [ ] **Step 1: Write failing lane-selection tests**

```ts
// packages/extensions/test/broker.test.ts
import { describe, expect, it } from "vitest";
import { CapabilityBroker, ExtensionRegistry } from "../src/index.js";
import testCounter from "../../../extensions/test-counter/src/index.js";

describe("CapabilityBroker", () => {
  it("executes an immediate read in-process", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => true,
    );

    const result = await broker.invoke({
      orenId: "oren-1",
      correlationId: "corr-read",
      capability: "test.read",
      arguments: {},
      grantIds: [],
      stateVersion: 1,
      effectId: "effect-read",
    });

    expect(result).toEqual({ kind: "completed", output: 0 });
    expect(effects).toEqual([]);
  });

  it("persists a side effect without executing it inline", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => true,
    );

    const result = await broker.invoke({
      orenId: "oren-1",
      correlationId: "corr-1",
      capability: "test.increment",
      arguments: { by: 1 },
      grantIds: ["grant-1"],
      stateVersion: 1,
      effectId: "effect-1",
    });

    expect(result).toEqual({ kind: "waiting_for_effect", effectId: "effect-1" });
    expect(effects).toEqual(["effect-1"]);
  });

  it("rejects a protected capability before persisting an effect", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => false,
    );

    const result = await broker.invoke({
      orenId: "oren-1",
      correlationId: "corr-denied",
      capability: "test.increment",
      arguments: { by: 1 },
      grantIds: [],
      stateVersion: 1,
      effectId: "effect-denied",
    });

    expect(result).toEqual({ kind: "rejected", reason: "missing_or_expired_grant" });
    expect(effects).toEqual([]);
  });

  it("rejects a manifest whose capability claims another extension", () => {
    const registry = new ExtensionRegistry();
    const invalid = {
      ...testCounter,
      manifest: {
        ...testCounter.manifest,
        id: "invalid",
        capabilities: testCounter.manifest.capabilities.map((capability) => ({
          ...capability,
          extensionId: "someone-else",
        })),
      },
    };

    expect(() => registry.register(invalid)).toThrow("wrong extensionId");
  });
});
```

- [ ] **Step 2: Run tests and verify the SDK is missing**

Run: `npm test -- packages/extensions/test`

Expected: FAIL because extension APIs do not exist.

- [ ] **Step 3: Define the Oren-native extension API**

```ts
// packages/extensions/src/sdk.ts
import type {
  CapabilityDescriptor,
  CapabilityInvocation,
  CapabilityResult,
  JsonObject,
} from "@oren/kernel";

export interface ExtensionContext {
  readonly extensionId: string;
  reportProgress(invocationId: string, message: string): void;
  emitObservation(source: string, payload: JsonObject): void;
}

export interface OrenExtension {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
    readonly protocolVersion: 1;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly eventSources: readonly string[];
  };
  activate(context: ExtensionContext): Promise<void>;
  deactivate(): Promise<void>;
  invoke(invocation: CapabilityInvocation, signal: AbortSignal): Promise<CapabilityResult>;
  query?(effectId: string, signal: AbortSignal): Promise<CapabilityResult>;
  cancel?(effectId: string, signal: AbortSignal): Promise<void>;
}
```

```ts
// packages/extensions/src/registry.ts
import type { CapabilityDescriptor } from "@oren/kernel";
import type { OrenExtension } from "./sdk.js";

export class ExtensionRegistry {
  private readonly extensions = new Map<string, OrenExtension>();
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  public register(extension: OrenExtension): void {
    if (extension.manifest.protocolVersion !== 1) {
      throw new Error(`Unsupported extension protocol: ${extension.manifest.protocolVersion}`);
    }
    if (this.extensions.has(extension.manifest.id)) {
      throw new Error(`Duplicate extension: ${extension.manifest.id}`);
    }
    for (const capability of extension.manifest.capabilities) {
      if (capability.extensionId !== extension.manifest.id) {
        throw new Error(`Capability ${capability.name} has the wrong extensionId`);
      }
      if (capability.timeoutMs <= 0) {
        throw new Error(`Capability ${capability.name} has an invalid timeout`);
      }
      if (this.capabilities.has(capability.name)) {
        throw new Error(`Duplicate capability: ${capability.name}`);
      }
      this.capabilities.set(capability.name, capability);
    }
    this.extensions.set(extension.manifest.id, extension);
  }

  public listCapabilities(): readonly CapabilityDescriptor[] {
    return [...this.capabilities.values()];
  }

  public resolve(name: string): { descriptor: CapabilityDescriptor; extension: OrenExtension } {
    const descriptor = this.capabilities.get(name);
    if (!descriptor) throw new Error(`Unknown capability: ${name}`);
    const extension = this.extensions.get(descriptor.extensionId);
    if (!extension) throw new Error(`Inactive extension: ${descriptor.extensionId}`);
    return { descriptor, extension };
  }
}
```

- [ ] **Step 4: Implement the broker and deterministic test extension**

```ts
// packages/extensions/src/broker.ts
import {
  isImmediateCapability,
  type CapabilityDescriptor,
  type Effect,
  type JsonObject,
} from "@oren/kernel";
import type { CapabilityInvocationOutcome } from "@oren/cognition";
import type { ExtensionRegistry } from "./registry.js";

export interface BrokerInput {
  readonly orenId: string;
  readonly correlationId: string;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly string[];
  readonly stateVersion: number;
  readonly effectId: string;
}

export class CapabilityBroker {
  public constructor(
    private readonly registry: ExtensionRegistry,
    private readonly persistEffect: (effect: Effect) => boolean,
    private readonly authorize: (
      input: BrokerInput,
      descriptor: CapabilityDescriptor,
    ) => boolean,
  ) {}

  public async invoke(input: BrokerInput): Promise<CapabilityInvocationOutcome> {
    const { descriptor, extension } = this.registry.resolve(input.capability);
    if (descriptor.permissionRequirements.length > 0 && !this.authorize(input, descriptor)) {
      return { kind: "rejected", reason: "missing_or_expired_grant" };
    }
    if (!isImmediateCapability(descriptor)) {
      const effect: Effect = {
        effectId: input.effectId,
        orenId: input.orenId,
        correlationId: input.correlationId,
        capability: input.capability,
        arguments: input.arguments,
        grantIds: input.grantIds,
        stateVersion: input.stateVersion,
      };
      if (!this.persistEffect(effect)) {
        return { kind: "rejected", reason: "stale_state_version" };
      }
      return { kind: "waiting_for_effect", effectId: effect.effectId };
    }
    const result = await extension.invoke({
      effectId: input.effectId,
      orenId: input.orenId,
      capability: input.capability,
      arguments: input.arguments,
      grantIds: input.grantIds,
      stateVersion: input.stateVersion,
      deadline: new Date(Date.now() + descriptor.timeoutMs).toISOString(),
    }, new AbortController().signal);
    return result.status === "completed"
      ? { kind: "completed", output: result.output }
      : { kind: "rejected", reason: result.message };
  }
}
```

```ts
// extensions/test-counter/src/index.ts
import type { OrenExtension } from "@oren/extensions";

let value = 0;

const extension: OrenExtension = {
  manifest: {
    id: "test-counter",
    version: "1.0.0",
    protocolVersion: 1,
    eventSources: [],
    capabilities: [
      {
        extensionId: "test-counter",
        name: "test.read",
        description: "Read the counter",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "number" },
        permissionRequirements: [],
        traits: ["read_only", "replay_safe"],
        cancellable: true,
        timeoutMs: 1000,
      },
      {
        extensionId: "test-counter",
        name: "test.increment",
        description: "Increment the counter",
        inputSchema: {
          type: "object",
          properties: { by: { type: "number" } },
          required: ["by"],
          additionalProperties: false,
        },
        outputSchema: { type: "number" },
        permissionRequirements: ["test.write"],
        traits: ["external_side_effect"],
        cancellable: false,
        timeoutMs: 1000,
      },
    ],
  },
  async activate() {},
  async deactivate() {},
  async invoke(invocation) {
    if (invocation.capability === "test.read") {
      return { status: "completed", output: value, receipt: { observed: true } };
    }
    const by = Number(invocation.arguments.by);
    value += by;
    return {
      status: "completed",
      output: value,
      receipt: { effectId: invocation.effectId, value },
    };
  },
};

export default extension;
```

```ts
// packages/extensions/src/index.ts
export * from "./sdk.js";
export * from "./registry.js";
export * from "./broker.js";
```

```json
// packages/extensions/package.json
{
  "name": "@oren/extensions",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/cognition": "*",
    "@oren/kernel": "*"
  }
}
```

```json
// extensions/test-counter/package.json
{
  "name": "@oren/test-counter",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/extensions": "*"
  }
}
```

Run:

`npm test -- packages/extensions/test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the Oren extension boundary**

```bash
git add packages/extensions extensions/test-counter package-lock.json
git commit -m "feat(extensions): add native capability broker"
```

---

### Task 7: Adapt Pi Tools and Run a Typed Cognitive Episode

**Files:**
- Create: `packages/pi-cognition/package.json`
- Create: `packages/pi-cognition/src/proposal-schema.ts`
- Create: `packages/pi-cognition/src/prompts.ts`
- Create: `packages/pi-cognition/src/tool-adapter.ts`
- Create: `packages/pi-cognition/src/pi-cognition-adapter.ts`
- Create: `packages/pi-cognition/src/index.ts`
- Create: `packages/pi-cognition/test/fixtures.ts`
- Test: `packages/pi-cognition/test/tool-adapter.test.ts`
- Test: `packages/pi-cognition/test/pi-cognition-adapter.test.ts`

**Interfaces:**
- Consumes: `LifeFrame`, `CognitionCapabilityPort`, Pi `runAgentLoop()`
- Produces: `PiCognitionAdapter`, internal `oren_commit` tool, capability-to-`AgentTool` mapping, typed `CognitionOutcome`

- [ ] **Step 1: Write failing adapter tests with a fake Pi stream**

```ts
// packages/pi-cognition/test/pi-cognition-adapter.test.ts
import { describe, expect, it } from "vitest";
import { PiCognitionAdapter } from "../src/index.js";
import {
  createCommitStream,
  createFrame,
  createMockModel,
} from "./fixtures.js";

describe("PiCognitionAdapter", () => {
  it("accepts proposals only through oren_commit", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createCommitStream([{
        type: "AdvanceThread",
        threadId: "thread-1",
        summary: "Pi is the inner cognition engine",
      }]),
    });
    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "completed",
      proposals: [{ type: "AdvanceThread", threadId: "thread-1" }],
    });
  });
});
```

```ts
// packages/pi-cognition/test/tool-adapter.test.ts
import { describe, expect, it } from "vitest";
import { toPiTool } from "../src/index.js";
import { createFrame } from "./fixtures.js";

describe("toPiTool", () => {
  it("terminates the Pi turn when Oren persists an external effect", async () => {
    const descriptor = {
      extensionId: "test-counter",
      name: "test.increment",
      description: "Increment the counter",
      inputSchema: {
        type: "object",
        properties: { by: { type: "number" } },
        required: ["by"],
      },
      outputSchema: { type: "number" },
      permissionRequirements: ["test.write"],
      traits: ["external_side_effect"],
      cancellable: false,
      timeoutMs: 1000,
    } as const;
    const tool = toPiTool(descriptor, createFrame(), {
      invoke: async () => ({ kind: "waiting_for_effect", effectId: "effect-1" }),
    });

    const result = await tool.execute("tool-1", { by: 1 }, undefined, undefined);

    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({
      kind: "waiting_for_effect",
      effectId: "effect-1",
    });
  });
});
```

- [ ] **Step 2: Add exact Pi dependencies and verify the test fails**

```json
// packages/pi-cognition/package.json
{
  "name": "@oren/pi-cognition",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.75.5",
    "@earendil-works/pi-ai": "0.75.5",
    "@oren/cognition": "*",
    "@oren/kernel": "*",
    "typebox": "1.1.38"
  }
}
```

Run: `npm install && npm test -- packages/pi-cognition/test/pi-cognition-adapter.test.ts`

Expected: FAIL because `PiCognitionAdapter` and fixtures are missing.

- [ ] **Step 3: Implement test fixtures and the typed commit tool**

```ts
// packages/pi-cognition/src/proposal-schema.ts
import { Type } from "typebox";

export const ProposalSchema = Type.Union([
  Type.Object({ type: Type.Literal("NoAction"), reason: Type.String() }),
  Type.Object({
    type: Type.Literal("AdvanceThread"),
    threadId: Type.String(),
    summary: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("UpdateDisposition"),
    disposition: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("ExpressToUser"),
    text: Type.String(),
    reason: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("ScheduleWake"),
    scheduleId: Type.String(),
    at: Type.String(),
    purpose: Type.String(),
  }),
]);

export const CommitSchema = Type.Object({
  proposals: Type.Array(ProposalSchema, { maxItems: 16 }),
});
```

```ts
// packages/pi-cognition/test/fixtures.ts
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  EventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { Proposal } from "@oren/kernel";
import type { LifeFrame } from "@oren/cognition";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  public constructor(message: AssistantMessage) {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => event.type === "done" ? event.message : event.error,
    );
    queueMicrotask(() => this.push({ type: "done", reason: "stop", message }));
  }
}

export function createMockModel(): Model<"openai-responses"> {
  return {
    id: "mock",
    name: "mock",
    api: "openai-responses",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

export function createCommitStream(proposals: readonly Proposal[]) {
  return () => new MockAssistantStream({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "commit-1",
      name: "oren_commit",
      arguments: { proposals },
    }],
    api: "openai-responses",
    provider: "mock",
    model: "mock",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

export function createSequenceStream(
  contents: readonly AssistantMessage["content"][],
) {
  let index = 0;
  return () => {
    const content = contents[index++];
    if (!content) throw new Error("Fake Pi stream exhausted");
    return new MockAssistantStream({
      role: "assistant",
      content,
      api: "openai-responses",
      provider: "mock",
      model: "mock",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
  };
}

export function createFrame(): LifeFrame {
  return {
    orenId: "oren-1",
    correlationId: "corr-1",
    stateVersion: 1,
    identity: { ethosVersion: 1, disposition: "attentive" },
    attention: { focus: null, threadIds: [] },
    relationship: { primaryPersonId: "person-1", contextRef: null },
    trigger: { kind: "foreground_user", summary: "hello" },
    capabilities: [],
    maxSteps: 8,
  };
}
```

- [ ] **Step 4: Implement Pi capability tools, commit collection, stop rules, and usage mapping**

```ts
// packages/pi-cognition/src/tool-adapter.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { CognitionCapabilityPort, LifeFrame } from "@oren/cognition";
import type { CapabilityDescriptor, JsonObject } from "@oren/kernel";

export function toPiTool(
  descriptor: CapabilityDescriptor,
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
): AgentTool {
  return {
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.inputSchema as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const outcome = await capabilityPort.invoke({
        orenId: frame.orenId,
        descriptor,
        arguments: params as JsonObject,
        stateVersion: frame.stateVersion,
        correlationId: frame.correlationId,
      });
      if (outcome.kind === "completed") {
        return {
          content: [{ type: "text", text: JSON.stringify(outcome.output) }],
          details: outcome,
        };
      }
      if (outcome.kind === "waiting_for_effect") {
        return {
          content: [{ type: "text", text: `Effect queued: ${outcome.effectId}` }],
          details: outcome,
          terminate: true,
        };
      }
      return {
        content: [{ type: "text", text: outcome.reason }],
        details: outcome,
      };
    },
  };
}
```

```ts
// packages/pi-cognition/src/prompts.ts
import type { LifeFrame } from "@oren/cognition";

export function systemPrompt(frame: LifeFrame): string {
  return [
    "You are Oren's bounded cognition engine.",
    "Think autonomously, but do not claim that an external action happened without a tool receipt.",
    "Submit accepted state proposals only by calling oren_commit.",
    `Maximum turns: ${frame.maxSteps}.`,
    `Identity: ${JSON.stringify(frame.identity)}`,
    `Attention: ${JSON.stringify(frame.attention)}`,
  ].join("\n");
}

export function userPrompt(frame: LifeFrame): string {
  return JSON.stringify({
    trigger: frame.trigger,
    relationship: frame.relationship,
  });
}
```

```ts
// packages/pi-cognition/src/pi-cognition-adapter.ts
import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";
import { CommitSchema } from "./proposal-schema.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { toPiTool } from "./tool-adapter.js";

export class PiCognitionAdapter implements CognitionPort {
  public constructor(private readonly options: {
    readonly model: Model<any>;
    readonly streamFn: StreamFn;
  }) {}

  public async run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome> {
    let committed: readonly Proposal[] | null = null;
    let waitingEffectId: string | null = null;
    let totalTokens = 0;
    let turns = 0;

    const commitTool: AgentTool = {
      name: "oren_commit",
      label: "Commit episode",
      description: "Submit typed proposals and finish this cognitive episode.",
      parameters: CommitSchema,
      executionMode: "sequential",
      async execute(_id, params) {
        committed = (params as { proposals: readonly Proposal[] }).proposals;
        return {
          content: [{ type: "text", text: "Episode committed." }],
          details: { committed: true },
          terminate: true,
        };
      },
    };
    const capabilityTools = frame.capabilities.map((descriptor) =>
      toPiTool(descriptor, frame, {
        async invoke(input) {
          const result = await capabilityPort.invoke(input);
          if (result.kind === "waiting_for_effect") waitingEffectId = result.effectId;
          return result;
        },
      }));
    const context: AgentContext = {
      systemPrompt: systemPrompt(frame),
      messages: [],
      tools: [...capabilityTools, commitTool],
    };
    const events: AgentEvent[] = [];

    try {
      await runAgentLoop(
        [{ role: "user", content: userPrompt(frame), timestamp: Date.now() }],
        context,
        {
          model: this.options.model,
          convertToLlm: (messages) => messages.filter(
            (message) => message.role === "user"
              || message.role === "assistant"
              || message.role === "toolResult",
          ),
          toolExecution: "sequential",
          shouldStopAfterTurn: () =>
            waitingEffectId !== null || committed !== null || ++turns >= frame.maxSteps,
        },
        (event) => {
          events.push(event);
          if (event.type === "message_end" && event.message.role === "assistant") {
            totalTokens += event.message.usage.totalTokens;
          }
        },
        signal,
        this.options.streamFn,
      );
    } catch (error) {
      return signal.aborted
        ? { kind: "aborted", usage: { totalTokens } }
        : {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
            usage: { totalTokens },
          };
    }

    if (signal.aborted) return { kind: "aborted", usage: { totalTokens } };
    if (waitingEffectId) {
      return { kind: "waiting_for_effect", effectId: waitingEffectId, usage: { totalTokens } };
    }
    return committed
      ? { kind: "completed", proposals: committed, usage: { totalTokens } }
      : { kind: "failed", message: "Pi ended without oren_commit", usage: { totalTokens } };
  }
}
```

```ts
// packages/pi-cognition/src/index.ts
export * from "./prompts.js";
export * from "./tool-adapter.js";
export * from "./pi-cognition-adapter.js";
```

Run: `npm test -- packages/pi-cognition/test && npm run typecheck`

Expected: PASS. Confirm with `rg -n "@earendil-works/pi|from \"typebox" packages --glob '*.ts'` that matches occur only under `packages/pi-cognition`.

- [ ] **Step 5: Commit Pi cognition integration**

```bash
git add packages/pi-cognition package-lock.json
git commit -m "feat(cognition): run bounded episodes with Pi"
```

---

### Task 8: Dispatch Durable Effects Without Blind Retries

**Files:**
- Create: `packages/app/package.json`
- Create: `packages/app/src/effect-dispatcher.ts`
- Create: `packages/app/src/index.ts`
- Modify: `packages/storage/src/life-repository.ts`
- Test: `packages/app/test/effect-dispatcher.test.ts`
- Test: `packages/storage/test/recovery.test.ts`

**Interfaces:**
- Consumes: Outbox lease, `ExtensionRegistry.resolve()`, extension `invoke()` and optional `query()`
- Produces: `EffectDispatcher.runOnce()`, terminal receipt events, `uncertain` recovery

- [ ] **Step 1: Write a failing test for dispatch-after-unknown recovery**

```ts
// packages/app/test/effect-dispatcher.test.ts
import { describe, expect, it } from "vitest";
import { EffectDispatcher } from "../src/index.js";

describe("EffectDispatcher", () => {
  it("marks a dispatched non-queryable effect uncertain instead of sending it twice", async () => {
    let invocations = 0;
    const repository = {
      claimOutbox: () => [{
        effectId: "effect-1",
        orenId: "oren-1",
        capability: "test.increment",
        effect: {
          effectId: "effect-1",
          orenId: "oren-1",
          correlationId: "corr-1",
          capability: "test.increment",
          arguments: { by: 1 },
          grantIds: ["grant-1"],
          stateVersion: 1,
        },
        attempts: 2,
      }],
      finishEffect: (
        _effectId: string,
        _orenId: string,
        _correlationId: string,
        payload: { type: string },
      ) => {
        terminalPayloads.push(payload.type);
      },
    };
    const terminalPayloads: string[] = [];
    const registry = {
      resolve: () => ({
        descriptor: { timeoutMs: 1000 },
        extension: { invoke: async () => { invocations++; throw new Error("not expected"); } },
      }),
    };

    const dispatcher = new EffectDispatcher(repository, registry, "worker-1");
    const results = await dispatcher.runOnce();

    expect(invocations).toBe(0);
    expect(results).toEqual([{ effectId: "effect-1", status: "uncertain" }]);
    expect(terminalPayloads).toEqual(["EffectUncertain"]);
  });
});
```

- [ ] **Step 2: Run the test and verify the dispatcher is absent**

Run: `npm test -- packages/app/test/effect-dispatcher.test.ts`

Expected: FAIL because `@oren/app` does not exist.

- [ ] **Step 3: Atomically persist effect terminal state and its Inbox result**

```ts
// add to packages/storage/src/life-repository.ts
public finishEffect(
  effectId: string,
  orenId: string,
  correlationId: string,
  payload:
    | Extract<CoreEvent, { type: "EffectCompleted" }>
    | Extract<CoreEvent, { type: "EffectFailed" }>
    | Extract<CoreEvent, { type: "EffectUncertain" }>,
): void {
  const status = payload.type === "EffectCompleted"
    ? "completed"
    : payload.type === "EffectFailed"
      ? "failed"
      : "uncertain";
  this.db.exec("BEGIN IMMEDIATE");
  try {
    this.db.prepare(`
      UPDATE outbox
      SET status = ?, receipt_json = ?, lease_owner = NULL, lease_until = NULL
      WHERE effect_id = ? AND status NOT IN ('completed','failed','uncertain','cancelled')
    `).run(status, JSON.stringify(payload), effectId);
    this.db.prepare(`
      UPDATE operations SET status = ?, receipt_json = ? WHERE effect_id = ?
    `).run(status, JSON.stringify(payload), effectId);
    this.db.prepare(`
      INSERT OR IGNORE INTO inbox(
        inbox_id, oren_id, priority, available_at, payload_json
      ) VALUES (?, ?, 4, ?, ?)
    `).run(
      `effect-result:${effectId}`,
      orenId,
      new Date().toISOString(),
      JSON.stringify({ correlationId, event: payload }),
    );
    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 4: Implement reconciliation-first dispatch**

```ts
// packages/app/src/effect-dispatcher.ts
import type { CapabilityInvocation, CapabilityResult } from "@oren/kernel";

interface ClaimedEffect {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: {
    readonly effectId: string;
    readonly correlationId: string;
    readonly capability: string;
    readonly arguments: CapabilityInvocation["arguments"];
    readonly grantIds: readonly string[];
    readonly stateVersion: number;
  };
  readonly attempts: number;
}

interface EffectRepository {
  claimOutbox(worker: string, limit: number): ClaimedEffect[];
  finishEffect(
    effectId: string,
    orenId: string,
    correlationId: string,
    payload:
      | { readonly type: "EffectCompleted"; readonly effectId: string; readonly receipt: CapabilityInvocation["arguments"] }
      | { readonly type: "EffectFailed"; readonly effectId: string; readonly code: string; readonly message: string }
      | { readonly type: "EffectUncertain"; readonly effectId: string; readonly message: string },
  ): void;
}

interface EffectRegistry {
  resolve(name: string): {
    descriptor: { readonly timeoutMs: number };
    extension: {
      invoke(invocation: CapabilityInvocation, signal: AbortSignal): Promise<CapabilityResult>;
      query?(effectId: string, signal: AbortSignal): Promise<CapabilityResult>;
    };
  };
}

export class EffectDispatcher {
  public constructor(
    private readonly repository: EffectRepository,
    private readonly registry: EffectRegistry,
    private readonly workerId: string,
  ) {}

  public async runOnce(): Promise<Array<{ effectId: string; status: string }>> {
    const claimed = this.repository.claimOutbox(this.workerId, 8);
    const results: Array<{ effectId: string; status: string }> = [];
    for (const row of claimed) {
      const { descriptor, extension } = this.registry.resolve(row.capability);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), descriptor.timeoutMs);
      try {
        let result: CapabilityResult;
        if (row.attempts > 1) {
          if (!extension.query) {
            this.repository.finishEffect(row.effectId, row.orenId, row.effect.correlationId, {
              type: "EffectUncertain",
              effectId: row.effectId,
              message: "Dispatch outcome cannot be queried",
            });
            results.push({ effectId: row.effectId, status: "uncertain" });
            continue;
          }
          result = await extension.query(row.effectId, controller.signal);
        } else {
          result = await extension.invoke({
            effectId: row.effect.effectId,
            orenId: row.orenId,
            capability: row.effect.capability,
            arguments: row.effect.arguments,
            grantIds: row.effect.grantIds,
            stateVersion: row.effect.stateVersion,
            deadline: new Date(Date.now() + descriptor.timeoutMs).toISOString(),
          }, controller.signal);
        }
        if (result.status === "completed") {
          this.repository.finishEffect(row.effectId, row.orenId, row.effect.correlationId, {
            type: "EffectCompleted",
            effectId: row.effectId,
            receipt: result.receipt,
          });
        } else if (result.status === "uncertain") {
          this.repository.finishEffect(row.effectId, row.orenId, row.effect.correlationId, {
            type: "EffectUncertain",
            effectId: row.effectId,
            message: result.message,
          });
        } else {
          this.repository.finishEffect(row.effectId, row.orenId, row.effect.correlationId, {
            type: "EffectFailed",
            effectId: row.effectId,
            code: result.code,
            message: result.message,
          });
        }
        results.push({ effectId: row.effectId, status: result.status });
      } catch (error) {
        this.repository.finishEffect(row.effectId, row.orenId, row.effect.correlationId, {
          type: "EffectUncertain",
          effectId: row.effectId,
          message: error instanceof Error ? error.message : String(error),
        });
        results.push({ effectId: row.effectId, status: "uncertain" });
      } finally {
        clearTimeout(timeout);
      }
    }
    return results;
  }
}
```

```json
// packages/app/package.json
{
  "name": "@oren/app",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/cognition": "*",
    "@oren/extensions": "*",
    "@oren/kernel": "*",
    "@oren/pi-cognition": "*",
    "@oren/storage": "*",
    "@oren/test-counter": "*"
  }
}
```

```ts
// packages/app/src/index.ts
export * from "./effect-dispatcher.js";
```

Run: `npm test -- packages/app/test/effect-dispatcher.test.ts packages/storage/test/recovery.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit effect dispatch**

```bash
git add packages/app packages/storage
git commit -m "feat(app): dispatch durable effects with reconciliation"
```

---

### Task 9: Coordinate Cognition, Foreground Preemption, and Scheduled Wakes

**Files:**
- Create: `packages/app/src/cognition-worker.ts`
- Create: `packages/app/src/episode-coordinator.ts`
- Create: `packages/app/src/scheduler.ts`
- Modify: `packages/app/src/index.ts`
- Modify: `packages/kernel/src/life-actor.ts`
- Modify: `packages/storage/src/life-repository.ts`
- Test: `packages/app/test/episode-coordinator.test.ts`

**Interfaces:**
- Consumes: `CognitionJob`, `CognitionPort`, durable Inbox and schedules
- Produces: one active episode per Oren, foreground preemption, trigger priority, idempotent wake delivery

- [ ] **Step 1: Write a failing foreground-preemption test**

```ts
// packages/app/test/episode-coordinator.test.ts
import { describe, expect, it } from "vitest";
import { EpisodeCoordinator } from "../src/index.js";

describe("EpisodeCoordinator", () => {
  it("aborts an idle episode before starting foreground cognition", async () => {
    const transitions: string[] = [];
    const coordinator = new EpisodeCoordinator(async (job, signal) => {
      transitions.push(`start:${job.triggerKind}`);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        transitions.push(`abort:${job.triggerKind}`);
        resolve();
      }, { once: true }));
    });

    void coordinator.start({
      orenId: "oren-1",
      episodeId: "background",
      baseStateVersion: 1,
      triggerKind: "health_check",
      correlationId: "corr-background",
    });
    await coordinator.start({
      orenId: "oren-1",
      episodeId: "foreground",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
      correlationId: "corr-foreground",
    });

    expect(transitions.slice(0, 3)).toEqual([
      "start:health_check",
      "abort:health_check",
      "start:foreground_user",
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify coordination is absent**

Run: `npm test -- packages/app/test/episode-coordinator.test.ts`

Expected: FAIL because `EpisodeCoordinator` does not exist.

- [ ] **Step 3: Implement the one-episode coordinator**

```ts
// packages/app/src/episode-coordinator.ts
import type { CognitionJob } from "@oren/kernel";

const priority = {
  foreground_user: 5,
  effect_result: 4,
  commitment_due: 3,
  scheduled_wake: 2,
  health_check: 1,
} as const;

interface ActiveEpisode {
  readonly job: CognitionJob;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class EpisodeCoordinator {
  private readonly active = new Map<string, ActiveEpisode>();

  public constructor(
    private readonly runEpisode: (job: CognitionJob, signal: AbortSignal) => Promise<void>,
  ) {}

  public async start(job: CognitionJob): Promise<void> {
    const current = this.active.get(job.orenId);
    if (current) {
      if (priority[job.triggerKind] <= priority[current.job.triggerKind]) return;
      current.controller.abort();
      await current.promise;
    }
    const controller = new AbortController();
    const promise = this.runEpisode(job, controller.signal)
      .finally(() => {
        if (this.active.get(job.orenId)?.job.episodeId === job.episodeId) {
          this.active.delete(job.orenId);
        }
      });
    this.active.set(job.orenId, { job, controller, promise });
    await Promise.resolve();
  }

  public waitForIdle(orenId: string): Promise<void> {
    return this.active.get(orenId)?.promise ?? Promise.resolve();
  }
}
```

- [ ] **Step 4: Add cognition worker and idempotent scheduler**

```ts
// packages/app/src/cognition-worker.ts
import type { CognitionPort, Conductor } from "@oren/cognition";
import type { CognitionJob, Guard, LifeActor } from "@oren/kernel";

export class CognitionWorker {
  public constructor(
    private readonly cognition: CognitionPort,
    private readonly conductor: Conductor,
    private readonly actor: LifeActor,
    private readonly guard: Guard,
    private readonly loadFrameInput: (job: CognitionJob) => Parameters<Conductor["createFrame"]>[0],
    private readonly capabilityPort: Parameters<CognitionPort["run"]>[1],
  ) {}

  public async run(job: CognitionJob, signal: AbortSignal): Promise<void> {
    const frameInput = this.loadFrameInput(job);
    const decision = this.guard.evaluateCognition(
      frameInput.state,
      job.triggerKind,
      frameInput.maxSteps,
    );
    if (!decision.allowed) return;
    const frame = this.conductor.createFrame(frameInput);
    const outcome = await this.cognition.run(frame, this.capabilityPort, signal);
    if (outcome.kind === "completed") {
      this.actor.acceptCognition(job, outcome.proposals);
    } else if (outcome.kind === "failed") {
      this.actor.recordCognitionExit(job, { kind: "failed", message: outcome.message });
    } else if (outcome.kind === "aborted") {
      this.actor.recordCognitionExit(job, { kind: "aborted", reason: "foreground_user" });
    }
  }
}
```

```ts
// packages/app/src/scheduler.ts
export interface DueSchedule {
  readonly scheduleId: string;
  readonly orenId: string;
  readonly purpose: string;
}

export interface ScheduleRepository {
  claimDue(now: string, limit: number): readonly DueSchedule[];
  deliverWake(schedule: DueSchedule): void;
}

export class Scheduler {
  public constructor(private readonly repository: ScheduleRepository) {}

  public runOnce(now: string): number {
    const due = this.repository.claimDue(now, 32);
    for (const schedule of due) {
      this.repository.deliverWake(schedule);
    }
    return due.length;
  }
}
```

```ts
// add to packages/storage/src/life-repository.ts
export interface InboxItem {
  readonly inboxId: string;
  readonly orenId: string;
  readonly correlationId: string;
  readonly event: CoreEvent;
}

public claimInbox(worker: string, now = new Date().toISOString()): InboxItem[] {
  const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
  this.db.exec("BEGIN IMMEDIATE");
  try {
    const rows = this.db.prepare(`
      SELECT inbox_id, oren_id, payload_json
      FROM inbox
      WHERE processed_at IS NULL
        AND available_at <= ?
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY priority DESC, rowid
      LIMIT 32
    `).all(now, now);
    const lease = this.db.prepare(`
      UPDATE inbox SET lease_owner = ?, lease_until = ? WHERE inbox_id = ?
    `);
    for (const row of rows) lease.run(worker, leaseUntil, String(row.inbox_id));
    this.db.exec("COMMIT");
    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as {
        correlationId: string;
        event: CoreEvent;
      };
      return {
        inboxId: String(row.inbox_id),
        orenId: String(row.oren_id),
        correlationId: payload.correlationId,
        event: payload.event,
      };
    });
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}

public commitInbox(
  inboxId: string,
  orenId: string,
  events: readonly EventEnvelope[],
): void {
  this.db.exec("BEGIN IMMEDIATE");
  try {
    const claimed = this.db.prepare(`
      UPDATE inbox
      SET processed_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE inbox_id = ? AND processed_at IS NULL
    `).run(new Date().toISOString(), inboxId);
    if (Number(claimed.changes) !== 1) {
      this.db.exec("ROLLBACK");
      return;
    }
    const insert = this.db.prepare(`
      INSERT INTO events(event_id, oren_id, recorded_at, envelope_json)
      VALUES (?, ?, ?, ?)
    `);
    for (const event of events) {
      insert.run(event.eventId, orenId, event.recordedAt, JSON.stringify(event));
    }
    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}

public claimDue(now: string, limit: number): Array<{
  scheduleId: string;
  orenId: string;
  purpose: string;
}> {
  return this.db.prepare(`
    SELECT schedule_id, oren_id, purpose
    FROM schedules
    WHERE due_at <= ? AND delivered_at IS NULL
    ORDER BY due_at
    LIMIT ?
  `).all(now, limit).map((row) => ({
    scheduleId: String(row.schedule_id),
    orenId: String(row.oren_id),
    purpose: String(row.purpose),
  }));
}

public deliverWake(schedule: {
  readonly scheduleId: string;
  readonly orenId: string;
  readonly purpose: string;
}): void {
  this.db.exec("BEGIN IMMEDIATE");
  try {
    this.db.prepare(`
      INSERT OR IGNORE INTO inbox(
        inbox_id, oren_id, priority, available_at, payload_json
      ) VALUES (?, ?, 2, ?, ?)
    `).run(
      `wake:${schedule.scheduleId}`,
      schedule.orenId,
      new Date().toISOString(),
      JSON.stringify({
        correlationId: `schedule:${schedule.scheduleId}`,
        event: {
          type: "WakeDue",
          scheduleId: schedule.scheduleId,
          purpose: schedule.purpose,
        },
      }),
    );
    this.db.prepare(`
      UPDATE schedules SET delivered_at = ? WHERE schedule_id = ?
    `).run(new Date().toISOString(), schedule.scheduleId);
    this.db.exec("COMMIT");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

```ts
// add to packages/kernel/src/life-actor.ts
public handleInbox(input: {
  readonly inboxId: string;
  readonly orenId: string;
  readonly correlationId: string;
  readonly event: EventEnvelope["payload"];
}): CognitionJob {
  const before = this.repository.loadState(input.orenId);
  const episodeId = this.nextId();
  const triggerKind = input.event.type === "WakeDue"
    ? "scheduled_wake"
    : "effect_result";
  const accepted = this.envelope(input.orenId, input.correlationId, input.event);
  const requested = this.envelope(input.orenId, input.correlationId, {
    type: "CognitionRequested",
    episodeId,
    baseStateVersion: before.version + 2,
    triggerKind,
  });
  this.repository.commitInbox(input.inboxId, input.orenId, [accepted, requested]);
  return {
    orenId: input.orenId,
    episodeId,
    baseStateVersion: before.version + 2,
    triggerKind,
    correlationId: input.correlationId,
  };
}
```

```ts
// packages/app/src/index.ts
export * from "./effect-dispatcher.js";
export * from "./cognition-worker.js";
export * from "./episode-coordinator.js";
export * from "./scheduler.js";
```

Run: `npm test -- packages/app/test/episode-coordinator.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit coordination and scheduling**

```bash
git add packages/app packages/storage
git commit -m "feat(app): coordinate episodes and durable wakes"
```

---

### Task 10: Compose and Verify the Restartable End-to-End Life Slice

**Files:**
- Create: `packages/app/src/life-runtime.ts`
- Create: `packages/app/src/demo.ts`
- Modify: `packages/app/src/index.ts`
- Test: `packages/app/test/life-runtime.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: all Phase 1 packages
- Produces: `LifeRuntime`, deterministic demo, Pi-backed fake-stream integration test

- [ ] **Step 1: Write the failing end-to-end restart test**

```ts
// packages/app/test/life-runtime.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiCognitionAdapter } from "@oren/pi-cognition";
import {
  createMockModel,
  createSequenceStream,
} from "../../pi-cognition/test/fixtures.js";
import { LifeRuntime } from "../src/index.js";

describe("LifeRuntime", () => {
  it("runs immediate cognition, suspends for an effect, resumes, and replays after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-runtime-"));
    const databasePath = join(directory, "life.db");
    const first = await LifeRuntime.createDeterministic(databasePath);

    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Think about the counter");
    await first.drain();
    const beforeRestart = first.inspect("oren-1");
    await first.close();

    const second = await LifeRuntime.createDeterministic(databasePath);
    await second.drain();
    const afterRestart = second.inspect("oren-1");

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.pendingEffectIds).toEqual([]);
    expect(afterRestart.attention.currentFocus).toContain("counter");
    await second.close();
  });

  it("runs the same durable slice through PiCognitionAdapter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-pi-runtime-"));
    const databasePath = join(directory, "life.db");
    const streamFn = createSequenceStream([
      [{ type: "toolCall", id: "read-1", name: "test.read", arguments: {} }],
      [{
        type: "toolCall",
        id: "increment-1",
        name: "test.increment",
        arguments: { by: 1 },
      }],
      [{
        type: "toolCall",
        id: "commit-1",
        name: "oren_commit",
        arguments: {
          proposals: [
            {
              type: "AdvanceThread",
              threadId: "counter",
              summary: "Pi completed the counter lifecycle",
            },
            {
              type: "ScheduleWake",
              scheduleId: "counter-follow-up",
              at: "2099-01-02T00:00:00.000Z",
              purpose: "Revisit the counter",
            },
          ],
        },
      }],
    ]);
    const runtime = await LifeRuntime.create(
      databasePath,
      new PiCognitionAdapter({ model: createMockModel(), streamFn }),
    );

    await runtime.initialize("oren-1", "person-1");
    await runtime.receiveUserMessage("oren-1", "person-1", "Inspect and increment the counter");
    await runtime.drain();

    expect(runtime.inspect("oren-1")).toMatchObject({
      pendingEffectIds: [],
      attention: { currentFocus: "Pi completed the counter lifecycle" },
      schedules: ["counter-follow-up"],
    });
    await runtime.close();
  });
});
```

- [ ] **Step 2: Run the end-to-end test and verify the composition root is missing**

Run: `npm test -- packages/app/test/life-runtime.test.ts`

Expected: FAIL because `LifeRuntime` does not exist.

- [ ] **Step 3: Implement one composition root without leaking Pi**

```ts
// packages/app/src/life-runtime.ts
import { randomUUID } from "node:crypto";
import {
  Conductor,
  ScriptedCognitionAdapter,
  type CognitionPort,
} from "@oren/cognition";
import {
  createInitialLifeState,
  Guard,
  LifeActor,
  type LifeState,
} from "@oren/kernel";
import { CapabilityBroker, ExtensionRegistry } from "@oren/extensions";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import testCounter from "../../../extensions/test-counter/src/index.js";
import { CognitionWorker } from "./cognition-worker.js";
import { EffectDispatcher } from "./effect-dispatcher.js";
import { EpisodeCoordinator } from "./episode-coordinator.js";

export class LifeRuntime {
  private constructor(
    private readonly repository: SqliteLifeRepository,
    private readonly actor: LifeActor,
    private readonly coordinator: EpisodeCoordinator,
    private readonly dispatcher: EffectDispatcher,
  ) {}

  public static async createDeterministic(databasePath: string): Promise<LifeRuntime> {
    const cognition = new ScriptedCognitionAdapter(async (frame, capabilityPort) => {
      if (frame.trigger.kind === "foreground_user") {
        const read = frame.capabilities.find((capability) => capability.name === "test.read");
        const increment = frame.capabilities.find((capability) => capability.name === "test.increment");
        if (!read || !increment) {
          return { kind: "failed", message: "Test capabilities missing", usage: { totalTokens: 0 } };
        }
        await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: read,
          arguments: {},
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        });
        const pending = await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: increment,
          arguments: { by: 1 },
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        });
        return pending.kind === "waiting_for_effect"
          ? { ...pending, usage: { totalTokens: 0 } }
          : { kind: "failed", message: "Expected durable effect", usage: { totalTokens: 0 } };
      }
      return {
        kind: "completed",
        proposals: [
          {
            type: "AdvanceThread",
            threadId: "counter",
            summary: "Understand the counter lifecycle",
          },
          {
            type: "ScheduleWake",
            scheduleId: "counter-follow-up",
            at: "2099-01-02T00:00:00.000Z",
            purpose: "Revisit the counter",
          },
        ],
        usage: { totalTokens: 0 },
      };
    });
    return LifeRuntime.create(databasePath, cognition);
  }

  public static async create(
    databasePath: string,
    cognition: CognitionPort,
  ): Promise<LifeRuntime> {
    const repository = new SqliteLifeRepository(openDatabase(databasePath));
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    await testCounter.activate({
      extensionId: "test-counter",
      reportProgress() {},
      emitObservation() {},
    });
    const actor = new LifeActor(repository, randomUUID, () => new Date().toISOString());
    const guard = new Guard();
    const broker = new CapabilityBroker(
      registry,
      (effect) => actor.requestEffect(
        effect.orenId,
        effect.correlationId,
        effect,
      ).accepted,
      (input) => guard.evaluateCapability({
        capability: input.capability,
        grants: repository.loadGrants(input.orenId).filter(
          (grant) => input.grantIds.includes(grant.grantId),
        ),
        now: new Date().toISOString(),
      }).allowed,
    );
    const conductor = new Conductor();
    const worker = new CognitionWorker(
      cognition,
      conductor,
      actor,
      guard,
      (job) => ({
        state: repository.loadState(job.orenId),
        correlationId: job.correlationId,
        trigger: { kind: job.triggerKind, summary: job.correlationId },
        capabilities: registry.listCapabilities(),
        maxSteps: 8,
      }),
      {
        invoke: ({ orenId, descriptor, arguments: arguments_, stateVersion, correlationId }) =>
          broker.invoke({
            orenId,
            correlationId,
            capability: descriptor.name,
            arguments: arguments_,
            grantIds: ["grant-1"],
            stateVersion,
            effectId: randomUUID(),
          }),
      },
    );
    const coordinator = new EpisodeCoordinator((job, signal) => worker.run(job, signal));
    const dispatcher = new EffectDispatcher(repository, registry, randomUUID());
    return new LifeRuntime(repository, actor, coordinator, dispatcher);
  }

  public async initialize(orenId: string, personId: string): Promise<void> {
    this.repository.initialize(createInitialLifeState(orenId, personId));
    this.repository.putGrant(orenId, {
      grantId: "grant-1",
      capabilityPattern: "test.*",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revoked: false,
    });
  }

  public async receiveUserMessage(orenId: string, personId: string, text: string): Promise<void> {
    await this.coordinator.start(this.actor.handleUserMessage(orenId, personId, text));
    await this.coordinator.waitForIdle(orenId);
  }

  public async drain(): Promise<void> {
    await this.dispatcher.runOnce();
    for (const inbox of this.repository.claimInbox("life-runtime")) {
      const job = this.actor.handleInbox({
        inboxId: inbox.inboxId,
        orenId: inbox.orenId,
        correlationId: inbox.correlationId,
        event: inbox.event,
      });
      await this.coordinator.start(job);
      await this.coordinator.waitForIdle(inbox.orenId);
    }
  }

  public inspect(orenId: string): LifeState {
    return this.repository.loadState(orenId);
  }

  public async close(): Promise<void> {
    this.repository.close();
  }
}
```

Add these repository adapter methods in the same step:

```ts
public loadState(orenId: string): LifeState {
  return this.rehydrate(orenId);
}

public commit(orenId: string, events: readonly EventEnvelope[]): void {
  const effects = events.flatMap((event) =>
    event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
  this.appendAndEnqueueEffects(orenId, events, effects);
}
```

- [ ] **Step 4: Run the deterministic and Pi-backed slices through every gate**

```ts
// packages/app/src/demo.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeRuntime } from "./life-runtime.js";

const directory = mkdtempSync(join(tmpdir(), "oren-demo-"));
const databasePath = join(directory, "life.db");
const first = await LifeRuntime.createDeterministic(databasePath);
await first.initialize("oren-demo", "person-demo");
await first.receiveUserMessage("oren-demo", "person-demo", "Think about the counter");
await first.drain();
const before = first.inspect("oren-demo");
await first.close();

const second = await LifeRuntime.createDeterministic(databasePath);
const after = second.inspect("oren-demo");
await second.close();

if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error("Replay mismatch");
}
console.log("Oren demo completed; replay matched");
```

```ts
// append to packages/app/src/index.ts
export * from "./life-runtime.js";
```

Document these commands in `README.md`:

```bash
npm install
npm test
npm run typecheck
npm run build
node --enable-source-maps dist/packages/app/src/demo.js
```

Run:

```bash
npm test
npm run typecheck
npm run build
node --enable-source-maps dist/packages/app/src/demo.js
```

Expected:

```text
Test Files  all passed
TypeScript  no errors
Build       exit 0
Oren demo   completed; replay matched
```

Then verify dependency boundaries:

```bash
rg -n '@earendil-works/pi|from "typebox' packages --glob '*.ts'
```

Expected: every match is under `packages/pi-cognition`.

- [ ] **Step 5: Commit the complete Phase 1 slice**

```bash
git add packages/app packages/storage README.md
git commit -m "feat: complete restartable Oren life slice"
```

---

## Phase 1 Completion Checklist

- [ ] `LifeActor` is the only state writer.
- [ ] Model and extension calls occur outside actor transactions.
- [ ] Every cognition result includes and validates `baseStateVersion`.
- [ ] Foreground input preempts idle cognition.
- [ ] Foreground interaction does not consume `autonomyBudget`.
- [ ] Immediate tools satisfy all five eligibility conditions.
- [ ] Persistent tools create an Effect and end the Pi episode.
- [ ] Effect completion triggers a new episode through Inbox correlation.
- [ ] No Pi internal transcript or active stream is required for recovery.
- [ ] `effectId` is the extension idempotency key.
- [ ] Expired dispatch leases reconcile or become `uncertain`; they are not blindly resent.
- [ ] Duplicate receipts do not apply twice.
- [ ] Oren extensions cannot write `LifeState`, access SQLite, or access model credentials.
- [ ] Only `packages/pi-cognition` imports Pi or TypeBox.
- [ ] Pi dependencies are pinned exactly to `0.75.5`.
- [ ] Fake streams cover Pi adapter behavior without network access.
- [ ] Empty-database startup, effect suspension, result resumption, shutdown, restart, and replay pass end to end.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
