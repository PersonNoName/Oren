# Oren Life Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, deterministic vertical slice of Oren’s life kernel that accepts durable events, reconstructs one Oren’s state, asks a scripted cognition adapter for typed proposals, enforces grants and budgets, invokes a test extension through a durable outbox, and schedules the next wake.

**Architecture:** A TypeScript/Node.js modular monolith hosts one single-writer `LifeActor` per Oren. SQLite WAL stores the inbox, append-only chronicle, snapshots, grants, schedules, operations, and outbox; LLM-facing cognition and extension-facing capability protocols are replaceable ports, while all accepted state changes remain deterministic and replayable.

**Tech Stack:** Node.js 24.15+, npm 11.12+, TypeScript (strict ESM), Vitest, built-in `node:sqlite`, npm workspaces

## Global Constraints

- The implementation must follow `design/2026-07-22-oren-implementation-spine.md`.
- Only `LifeActor` may commit changes to `LifeState`.
- Events are facts; LLM outputs are typed `Proposal` values; external work is a typed `Effect`.
- LLM adapters and extensions never receive SQLite handles, credentials, or mutable `LifeState`.
- Every external effect has an idempotency key and reaches a terminal receipt or an explicit unresolved state.
- `autonomy_budget` applies only to idle autonomous cognition.
- Foreground user interaction is not subject to a daily quota; `interaction_guardrails` only bound one cognitive episode.
- Each background commitment has its own `commitment_budget`.
- Phase 1 has no production model SDK, Web access, message channel, vector database, dashboard, or remote extension transport.
- Use built-in `node:sqlite`; add no runtime dependency in Phase 1.
- Tests use temporary or in-memory databases and never write under `data/` or `.oren-life/`.
- Run `npm test`, `npm run typecheck`, and `npm run build` before the final Phase 1 commit.

---

## Scope Decomposition

The approved architecture contains several independently reviewable products. This plan covers only **Phase 1: runnable life-kernel vertical slice**.

Follow-on plans, written only after Phase 1 passes, will cover:

1. real model adapter plus prompt/evaluation harness;
2. memory/content projection and recall;
3. Web reading and source provenance;
4. one real message channel;
5. life/action dashboard and long-horizon simulation tooling.

Phase 1 uses a scripted cognition adapter and a deterministic test extension so the kernel can be verified without network access or model variance.

## Locked File Structure

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
      protocol.ts
      state.ts
      reducer.ts
      guard.ts
      life-actor.ts
      index.ts
    test/
      state.test.ts
      reducer.test.ts
      guard.test.ts
      life-actor.test.ts
  storage/
    package.json
    src/
      database.ts
      migrations.ts
      chronicle-store.ts
      snapshot-store.ts
      inbox-store.ts
      outbox-store.ts
      schedule-store.ts
      operation-store.ts
      grant-store.ts
      index.ts
    test/
      chronicle-store.test.ts
      snapshot-store.test.ts
      inbox-store.test.ts
      outbox-store.test.ts
      schedule-store.test.ts
  cognition/
    package.json
    src/
      cognition-adapter.ts
      life-frame.ts
      conductor.ts
      scripted-adapter.ts
      index.ts
    test/
      conductor.test.ts
  capabilities/
    package.json
    src/
      manifest.ts
      extension.ts
      registry.ts
      runtime.ts
      index.ts
    test/
      runtime.test.ts
  app/
    package.json
    src/
      decision-compiler.ts
      effect-dispatcher.ts
      scheduler.ts
      life-runtime.ts
      demo.ts
      index.ts
    test/
      effect-dispatcher.test.ts
      scheduler.test.ts
      life-runtime.test.ts
extensions/
  test-counter/
    package.json
    src/
      index.ts
```

Dependency direction:

```text
kernel        ← storage
kernel        ← cognition
kernel        ← capabilities
kernel + storage + cognition + capabilities ← app
capabilities  ← extensions/test-counter
```

`kernel` imports no workspace package. `storage`, `cognition`, and `capabilities` may import `@oren/kernel`; they do not import one another. `app` is the composition root.

---

### Task 1: Bootstrap the Workspace and Freeze Core Protocol Types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `packages/kernel/package.json`
- Create: `packages/kernel/src/ids.ts`
- Create: `packages/kernel/src/protocol.ts`
- Create: `packages/kernel/src/state.ts`
- Create: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/state.test.ts`
- Generated: `package-lock.json`

**Interfaces:**
- Produces: `EventEnvelope`, `CoreEvent`, `Proposal`, `Effect`, `LifeState`, `createInitialLifeState()`
- Consumes: none

- [ ] **Step 1: Write the failing state-construction test**

```ts
// packages/kernel/test/state.test.ts
import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "../src/index.js";

describe("createInitialLifeState", () => {
  it("creates a bounded empty state for one Oren", () => {
    expect(createInitialLifeState("oren-1", "person-1")).toEqual({
      orenId: "oren-1",
      version: 0,
      identity: {
        ethosVersion: 1,
        currentDisposition: "attentive",
      },
      attention: {
        activeThreadIds: [],
        currentFocus: null,
        unresolvedQuestions: [],
      },
      relationship: {
        primaryPersonId: "person-1",
        currentContextRef: null,
      },
      commitments: [],
      intentions: [],
      schedules: [],
      grantIds: [],
      budgets: {
        autonomyRemaining: 0,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
      pendingOperationIds: [],
      chronicleCursor: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test and verify the workspace is not yet configured**

Run: `npm test -- packages/kernel/test/state.test.ts`

Expected: FAIL because the root package and kernel exports do not exist.

- [ ] **Step 3: Create the root workspace configuration**

```json
// package.json
{
  "name": "oren",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*",
    "extensions/*"
  ],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
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

```json
// packages/kernel/package.json
{
  "name": "@oren/kernel",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts"
}
```

Run: `npm install`

Expected: PASS and create `package-lock.json`.

- [ ] **Step 4: Add stable identifiers and protocol types**

```ts
// packages/kernel/src/ids.ts
export type OrenId = string;
export type PersonId = string;
export type EventId = string;
export type CorrelationId = string;
export type IntentId = string;
export type EffectId = string;
export type GrantId = string;
export type OperationId = string;
export type ScheduleId = string;
export type ThreadId = string;
export type CommitmentId = string;
```

```ts
// packages/kernel/src/protocol.ts
import type {
  CommitmentId,
  CorrelationId,
  EffectId,
  EventId,
  GrantId,
  IntentId,
  OrenId,
  ScheduleId,
  ThreadId,
} from "./ids.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CoreEvent =
  | { type: "OrenInitialized"; personId: string }
  | { type: "UserMessageReceived"; personId: string; text: string }
  | { type: "WakeDue"; scheduleId: ScheduleId; purpose: string }
  | { type: "ThreadActivated"; threadId: ThreadId; summary: string }
  | { type: "ThreadAdvanced"; threadId: ThreadId; summary: string }
  | {
      type: "CommitmentCreated";
      commitmentId: CommitmentId;
      summary: string;
      nextStep: string;
      budgetRemaining: number;
    }
  | {
      type: "CommitmentAdvanced";
      commitmentId: CommitmentId;
      nextStep: string;
    }
  | {
      type: "IntentFormed";
      intentId: IntentId;
      reason: string;
      proposedAction: string;
      expiresAt: string;
    }
  | {
      type: "WakeScheduled";
      scheduleId: ScheduleId;
      dueAt: string;
      purpose: string;
    }
  | { type: "GrantRecorded"; grantId: GrantId }
  | {
      type: "BudgetConsumed";
      budget: "autonomy" | "commitment";
      amount: number;
      commitmentId: CommitmentId | null;
    }
  | {
      type: "EffectRequested";
      effectId: EffectId;
      capability: string;
      intentId: IntentId;
    }
  | {
      type: "CapabilityCompleted";
      effectId: EffectId;
      capability: string;
      receipt: JsonValue;
    }
  | {
      type: "CapabilityFailed";
      effectId: EffectId;
      capability: string;
      category:
        | "Retryable"
        | "NeedsReconciliation"
        | "NeedsAttention"
        | "Terminal";
      message: string;
    };

export interface EventEnvelope<TPayload extends CoreEvent = CoreEvent> {
  eventId: EventId;
  orenId: OrenId;
  schemaVersion: 1;
  occurredAt: string;
  recordedAt: string;
  source: string;
  causationId: EventId | null;
  correlationId: CorrelationId;
  payload: TPayload;
}

export type Proposal =
  | { type: "NoAction"; reason: string }
  | { type: "AdvanceThread"; threadId: ThreadId; summary: string }
  | {
      type: "CreateOrUpdateCommitment";
      commitmentId: CommitmentId;
      summary: string;
      nextStep: string;
    }
  | {
      type: "FormIntent";
      intentId: IntentId;
      reason: string;
      proposedAction: string;
      expiresAt: string;
    }
  | {
      type: "RequestCapability";
      intentId: IntentId;
      capability: string;
      arguments: JsonValue;
      riskTraits: string[];
      commitmentId: CommitmentId | null;
    }
  | {
      type: "ScheduleWake";
      scheduleId: ScheduleId;
      dueAt: string;
      purpose: string;
    };

export interface Effect {
  effectId: EffectId;
  orenId: OrenId;
  intentId: IntentId;
  capability: string;
  arguments: JsonValue;
  grantIds: GrantId[];
  stateVersion: number;
  deadline: string;
  idempotencyKey: string;
  correlationId: CorrelationId;
}

export interface ScheduledWake {
  scheduleId: ScheduleId;
  orenId: OrenId;
  dueAt: string;
  purpose: string;
}

export interface DecisionBatch {
  events: EventEnvelope[];
  effects: Effect[];
  schedules: ScheduledWake[];
}
```

- [ ] **Step 5: Add the initial bounded state**

```ts
// packages/kernel/src/state.ts
import type {
  CommitmentId,
  GrantId,
  OrenId,
  OperationId,
  PersonId,
  ScheduleId,
  ThreadId,
} from "./ids.js";

export interface LifeState {
  orenId: OrenId;
  version: number;
  identity: {
    ethosVersion: number;
    currentDisposition: string;
  };
  attention: {
    activeThreadIds: ThreadId[];
    currentFocus: string | null;
    unresolvedQuestions: string[];
  };
  relationship: {
    primaryPersonId: PersonId;
    currentContextRef: string | null;
  };
  commitments: Array<{
    commitmentId: CommitmentId;
    summary: string;
    nextStep: string;
    status: "active" | "blocked" | "completed" | "cancelled";
  }>;
  intentions: Array<{
    intentId: string;
    reason: string;
    proposedAction: string;
    expiresAt: string;
  }>;
  schedules: Array<{
    scheduleId: ScheduleId;
    dueAt: string;
    purpose: string;
  }>;
  grantIds: GrantId[];
  budgets: {
    autonomyRemaining: number;
    interactionMaxSteps: number;
    commitmentRemaining: Record<CommitmentId, number>;
  };
  pendingOperationIds: OperationId[];
  chronicleCursor: number;
}

export function createInitialLifeState(
  orenId: OrenId,
  primaryPersonId: PersonId,
): LifeState {
  return {
    orenId,
    version: 0,
    identity: {
      ethosVersion: 1,
      currentDisposition: "attentive",
    },
    attention: {
      activeThreadIds: [],
      currentFocus: null,
      unresolvedQuestions: [],
    },
    relationship: {
      primaryPersonId,
      currentContextRef: null,
    },
    commitments: [],
    intentions: [],
    schedules: [],
    grantIds: [],
    budgets: {
      autonomyRemaining: 0,
      interactionMaxSteps: 8,
      commitmentRemaining: {},
    },
    pendingOperationIds: [],
    chronicleCursor: 0,
  };
}
```

```ts
// packages/kernel/src/index.ts
export * from "./ids.js";
export * from "./protocol.js";
export * from "./state.js";
```

- [ ] **Step 6: Run the task checks**

Run: `npm test -- packages/kernel/test/state.test.ts && npm run typecheck`

Expected: PASS; one test passes and TypeScript reports no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts packages/kernel
git commit -m "chore: bootstrap Oren TypeScript workspace"
```

---

### Task 2: Implement the SQLite Chronicle

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/migrations.ts`
- Create: `packages/storage/src/chronicle-store.ts`
- Create: `packages/storage/src/index.ts`
- Test: `packages/storage/test/chronicle-store.test.ts`

**Interfaces:**
- Consumes: `EventEnvelope` from `@oren/kernel`
- Produces: `SqliteDatabase`, `ChronicleStore.append()`, `ChronicleStore.list()`, `ChronicleStore.lastSequence()`

- [ ] **Step 1: Write the failing append-and-replay test**

```ts
// packages/storage/test/chronicle-store.test.ts
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@oren/kernel";
import {
  ChronicleStore,
  SqliteDatabase,
  applyMigrations,
} from "../src/index.js";

function initializedEvent(): EventEnvelope {
  return {
    eventId: "event-1",
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt: "2026-07-23T00:00:00.000Z",
    recordedAt: "2026-07-23T00:00:00.000Z",
    source: "test",
    causationId: null,
    correlationId: "correlation-1",
    payload: { type: "OrenInitialized", personId: "person-1" },
  };
}

describe("ChronicleStore", () => {
  it("appends once and replays in sequence order", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const store = new ChronicleStore(database);

    expect(store.append(initializedEvent())).toBe(1);
    expect(store.append(initializedEvent())).toBe(1);
    expect(store.lastSequence("oren-1")).toBe(1);
    expect(store.list("oren-1", 0)).toEqual([
      { sequence: 1, event: initializedEvent() },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/storage/test/chronicle-store.test.ts`

Expected: FAIL because `@oren/storage` files do not exist.

- [ ] **Step 3: Add the storage package and shared database wrapper**

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

```ts
// packages/storage/src/database.ts
import { DatabaseSync } from "node:sqlite";

export class SqliteDatabase {
  readonly raw: DatabaseSync;

  constructor(filename: string) {
    this.raw = new DatabaseSync(filename);
    this.raw.exec("PRAGMA foreign_keys = ON");
    if (filename !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL");
    }
  }

  transaction<T>(work: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
```

- [ ] **Step 4: Add the initial migration**

```ts
// packages/storage/src/migrations.ts
import type { SqliteDatabase } from "./database.js";

export function applyMigrations(database: SqliteDatabase): void {
  database.raw.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      oren_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL,
      causation_id TEXT,
      correlation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_oren_sequence
      ON events (oren_id, sequence);
  `);
}
```

- [ ] **Step 5: Implement idempotent chronicle append and replay**

```ts
// packages/storage/src/chronicle-store.ts
import type { EventEnvelope } from "@oren/kernel";
import type { SqliteDatabase } from "./database.js";

interface EventRow {
  sequence: number;
  event_id: string;
  oren_id: string;
  schema_version: number;
  occurred_at: string;
  recorded_at: string;
  source: string;
  causation_id: string | null;
  correlation_id: string;
  payload_json: string;
}

export class ChronicleStore {
  constructor(private readonly database: SqliteDatabase) {}

  append(event: EventEnvelope): number {
    this.database.raw
      .prepare(`
        INSERT INTO events (
          event_id, oren_id, schema_version, occurred_at, recorded_at,
          source, causation_id, correlation_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `)
      .run(
        event.eventId,
        event.orenId,
        event.schemaVersion,
        event.occurredAt,
        event.recordedAt,
        event.source,
        event.causationId,
        event.correlationId,
        JSON.stringify(event.payload),
      );

    const row = this.database.raw
      .prepare("SELECT sequence FROM events WHERE event_id = ?")
      .get(event.eventId) as { sequence: number };
    return row.sequence;
  }

  list(
    orenId: string,
    afterSequence: number,
  ): Array<{ sequence: number; event: EventEnvelope }> {
    const rows = this.database.raw
      .prepare(`
        SELECT * FROM events
        WHERE oren_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `)
      .all(orenId, afterSequence) as unknown as EventRow[];

    return rows.map((row) => ({
      sequence: row.sequence,
      event: {
        eventId: row.event_id,
        orenId: row.oren_id,
        schemaVersion: 1,
        occurredAt: row.occurred_at,
        recordedAt: row.recorded_at,
        source: row.source,
        causationId: row.causation_id,
        correlationId: row.correlation_id,
        payload: JSON.parse(row.payload_json) as EventEnvelope["payload"],
      },
    }));
  }

  lastSequence(orenId: string): number {
    const row = this.database.raw
      .prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM events WHERE oren_id = ?
      `)
      .get(orenId) as { sequence: number };
    return row.sequence;
  }
}
```

```ts
// packages/storage/src/index.ts
export * from "./database.js";
export * from "./migrations.js";
export * from "./chronicle-store.js";
```

- [ ] **Step 6: Run the task checks**

Run: `npm install && npm test -- packages/storage/test/chronicle-store.test.ts && npm run typecheck`

Expected: PASS; duplicate append returns the original sequence and only one event is replayed.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json packages/storage
git commit -m "feat: add SQLite chronicle store"
```

---

### Task 3: Add Deterministic Reduction, Snapshots, and Rehydration

**Files:**
- Create: `packages/kernel/src/reducer.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/reducer.test.ts`
- Create: `packages/storage/src/snapshot-store.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `LifeState`, `EventEnvelope`, `ChronicleStore`
- Produces: `reduceLifeState()`, `SnapshotStore.save()`, `SnapshotStore.latest()`, `rehydrateLifeState()`

- [ ] **Step 1: Write the failing deterministic reducer test**

```ts
// packages/kernel/test/reducer.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  reduceLifeState,
  type EventEnvelope,
} from "../src/index.js";

describe("reduceLifeState", () => {
  it("replays thread and wake facts without mutating the input", () => {
    const initial = createInitialLifeState("oren-1", "person-1");
    const event: EventEnvelope = {
      eventId: "event-2",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-23T01:00:00.000Z",
      recordedAt: "2026-07-23T01:00:00.000Z",
      source: "conductor",
      causationId: "event-1",
      correlationId: "correlation-1",
      payload: {
        type: "ThreadActivated",
        threadId: "thread-1",
        summary: "Digital forgetting",
      },
    };

    const next = reduceLifeState(initial, 2, event);

    expect(initial.attention.activeThreadIds).toEqual([]);
    expect(next.attention.activeThreadIds).toEqual(["thread-1"]);
    expect(next.attention.currentFocus).toBe("Digital forgetting");
    expect(next.version).toBe(1);
    expect(next.chronicleCursor).toBe(2);
  });
});
```

- [ ] **Step 2: Run the reducer test and verify failure**

Run: `npm test -- packages/kernel/test/reducer.test.ts`

Expected: FAIL because `reduceLifeState` is not exported.

- [ ] **Step 3: Implement the pure reducer**

```ts
// packages/kernel/src/reducer.ts
import type { EventEnvelope } from "./protocol.js";
import type { LifeState } from "./state.js";

export function reduceLifeState(
  state: LifeState,
  sequence: number,
  event: EventEnvelope,
): LifeState {
  const next = structuredClone(state);
  const payload = event.payload;

  switch (payload.type) {
    case "ThreadActivated":
      if (!next.attention.activeThreadIds.includes(payload.threadId)) {
        next.attention.activeThreadIds.push(payload.threadId);
      }
      next.attention.currentFocus = payload.summary;
      break;
    case "ThreadAdvanced":
      if (!next.attention.activeThreadIds.includes(payload.threadId)) {
        next.attention.activeThreadIds.push(payload.threadId);
      }
      next.attention.currentFocus = payload.summary;
      break;
    case "CommitmentCreated":
      next.commitments.push({
        commitmentId: payload.commitmentId,
        summary: payload.summary,
        nextStep: payload.nextStep,
        status: "active",
      });
      next.budgets.commitmentRemaining[payload.commitmentId] =
        payload.budgetRemaining;
      break;
    case "CommitmentAdvanced": {
      const commitment = next.commitments.find(
        (item) => item.commitmentId === payload.commitmentId,
      );
      if (commitment) commitment.nextStep = payload.nextStep;
      break;
    }
    case "IntentFormed":
      next.intentions.push({
        intentId: payload.intentId,
        reason: payload.reason,
        proposedAction: payload.proposedAction,
        expiresAt: payload.expiresAt,
      });
      break;
    case "WakeScheduled":
      next.schedules = next.schedules.filter(
        (item) => item.scheduleId !== payload.scheduleId,
      );
      next.schedules.push({
        scheduleId: payload.scheduleId,
        dueAt: payload.dueAt,
        purpose: payload.purpose,
      });
      break;
    case "GrantRecorded":
      if (!next.grantIds.includes(payload.grantId)) {
        next.grantIds.push(payload.grantId);
      }
      break;
    case "BudgetConsumed":
      if (payload.budget === "autonomy") {
        next.budgets.autonomyRemaining = Math.max(
          0,
          next.budgets.autonomyRemaining - payload.amount,
        );
      } else if (payload.commitmentId !== null) {
        const remaining =
          next.budgets.commitmentRemaining[payload.commitmentId] ?? 0;
        next.budgets.commitmentRemaining[payload.commitmentId] = Math.max(
          0,
          remaining - payload.amount,
        );
      }
      break;
    case "EffectRequested":
      if (!next.pendingOperationIds.includes(payload.effectId)) {
        next.pendingOperationIds.push(payload.effectId);
      }
      break;
    case "CapabilityCompleted":
    case "CapabilityFailed":
      next.pendingOperationIds = next.pendingOperationIds.filter(
        (operationId) => operationId !== payload.effectId,
      );
      break;
    case "OrenInitialized":
    case "UserMessageReceived":
    case "WakeDue":
      break;
  }

  next.version += 1;
  next.chronicleCursor = sequence;
  return next;
}
```

Add `export * from "./reducer.js";` to `packages/kernel/src/index.ts`.

- [ ] **Step 4: Write the failing snapshot rehydration test**

```ts
// packages/storage/test/snapshot-store.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  reduceLifeState,
  type EventEnvelope,
} from "@oren/kernel";
import {
  applyMigrations,
  ChronicleStore,
  rehydrateLifeState,
  SnapshotStore,
  SqliteDatabase,
} from "../src/index.js";

describe("rehydrateLifeState", () => {
  it("loads a snapshot and reduces only later events", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const chronicle = new ChronicleStore(database);
    const snapshots = new SnapshotStore(database);
    const initial = createInitialLifeState("oren-1", "person-1");

    snapshots.save("oren-1", 0, initial);
    const event: EventEnvelope = {
      eventId: "event-2",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-23T01:00:00.000Z",
      recordedAt: "2026-07-23T01:00:00.000Z",
      source: "test",
      causationId: null,
      correlationId: "correlation-2",
      payload: {
        type: "ThreadActivated",
        threadId: "thread-1",
        summary: "Digital forgetting",
      },
    };
    chronicle.append(event);

    const state = rehydrateLifeState(
      "oren-1",
      "person-1",
      chronicle,
      snapshots,
      reduceLifeState,
    );
    expect(state.attention.activeThreadIds).toEqual(["thread-1"]);
    expect(state.chronicleCursor).toBe(1);
  });
});
```

- [ ] **Step 5: Add snapshots and rehydration**

Append to `applyMigrations()`:

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  oren_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (oren_id, sequence)
);
```

```ts
// packages/storage/src/snapshot-store.ts
import {
  createInitialLifeState,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import type { ChronicleStore } from "./chronicle-store.js";
import type { SqliteDatabase } from "./database.js";

export class SnapshotStore {
  constructor(private readonly database: SqliteDatabase) {}

  save(orenId: string, sequence: number, state: LifeState): void {
    this.database.raw
      .prepare(`
        INSERT OR REPLACE INTO snapshots
          (oren_id, sequence, state_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(orenId, sequence, JSON.stringify(state), new Date().toISOString());
  }

  latest(
    orenId: string,
  ): { sequence: number; state: LifeState } | null {
    const row = this.database.raw
      .prepare(`
        SELECT sequence, state_json
        FROM snapshots
        WHERE oren_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(orenId) as
      | { sequence: number; state_json: string }
      | undefined;
    return row
      ? {
          sequence: row.sequence,
          state: JSON.parse(row.state_json) as LifeState,
        }
      : null;
  }
}

export function rehydrateLifeState(
  orenId: string,
  personId: string,
  chronicle: ChronicleStore,
  snapshots: SnapshotStore,
  reduce: (
    state: LifeState,
    sequence: number,
    event: EventEnvelope,
  ) => LifeState,
): LifeState {
  const snapshot = snapshots.latest(orenId);
  let state =
    snapshot?.state ?? createInitialLifeState(orenId, personId);
  const after = snapshot?.sequence ?? 0;
  for (const item of chronicle.list(orenId, after)) {
    state = reduce(state, item.sequence, item.event);
  }
  return state;
}
```

Export `SnapshotStore` and `rehydrateLifeState` from `packages/storage/src/index.ts`.

- [ ] **Step 6: Run the task checks**

Run: `npm test -- packages/kernel/test/reducer.test.ts packages/storage/test/snapshot-store.test.ts && npm run typecheck`

Expected: PASS; reducer is immutable and snapshot rehydration consumes only later events.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel packages/storage
git commit -m "feat: add deterministic life-state replay"
```

---

### Task 4: Add the Durable Inbox and Single-Writer LifeActor

**Files:**
- Create: `packages/storage/src/inbox-store.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/inbox-store.test.ts`
- Create: `packages/kernel/src/life-actor.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/life-actor.test.ts`

**Interfaces:**
- Consumes: `ChronicleStore`, `SnapshotStore`, `reduceLifeState()`
- Produces: `InboxStore.enqueue()`, `InboxStore.nextPending()`, `InboxStore.completeAsEvent()`, `LifeActor.processOne()`, `LifeActor.commitDecisions()`

- [ ] **Step 1: Write failing inbox idempotency and actor-order tests**

```ts
// packages/storage/test/inbox-store.test.ts
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  InboxStore,
  SqliteDatabase,
} from "../src/index.js";

describe("InboxStore", () => {
  it("deduplicates one incoming event by inbox id", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const inbox = new InboxStore(database);
    const event = {
      eventId: "inbox-1",
      orenId: "oren-1",
      schemaVersion: 1 as const,
      occurredAt: "2026-07-23T00:00:00.000Z",
      recordedAt: "2026-07-23T00:00:00.000Z",
      source: "test",
      causationId: null,
      correlationId: "correlation-1",
      payload: { type: "WakeDue" as const, scheduleId: "s-1", purpose: "think" },
    };
    inbox.enqueue(event);
    inbox.enqueue(event);
    expect(inbox.pendingCount("oren-1")).toBe(1);
  });
});
```

```ts
// packages/kernel/test/life-actor.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  type EventEnvelope,
} from "../src/index.js";

describe("LifeActor", () => {
  it("serially reduces one accepted event", async () => {
    const events: Array<{ sequence: number; event: EventEnvelope }> = [];
    let state = createInitialLifeState("oren-1", "person-1");
    const actor = new LifeActor({
      loadState: () => state,
      takeNext: () => ({
        eventId: "event-1",
        orenId: "oren-1",
        schemaVersion: 1,
        occurredAt: "2026-07-23T00:00:00.000Z",
        recordedAt: "2026-07-23T00:00:00.000Z",
        source: "test",
        causationId: null,
        correlationId: "correlation-1",
        payload: {
          type: "ThreadActivated",
          threadId: "thread-1",
          summary: "Digital forgetting",
        },
      }),
      commitInboxEvent: (event) => {
        const item = { sequence: 1, event };
        events.push(item);
        state = reduceLifeState(state, item.sequence, item.event);
        return item;
      },
      commitDecisionBatch: () => [],
    });

    const result = await actor.processOne();
    expect(result?.state.attention.activeThreadIds).toEqual(["thread-1"]);
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run both tests and verify failure**

Run: `npm test -- packages/storage/test/inbox-store.test.ts packages/kernel/test/life-actor.test.ts`

Expected: FAIL because `InboxStore` and `LifeActor` do not exist.

- [ ] **Step 3: Add the durable inbox**

Append to `applyMigrations()`:

```sql
CREATE TABLE IF NOT EXISTS inbox (
  inbox_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  received_at TEXT NOT NULL,
  completed_sequence INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_pending
  ON inbox (oren_id, status, received_at);
```

```ts
// packages/storage/src/inbox-store.ts
import type { EventEnvelope } from "@oren/kernel";
import type { ChronicleStore } from "./chronicle-store.js";
import type { SqliteDatabase } from "./database.js";

export class InboxStore {
  constructor(private readonly database: SqliteDatabase) {}

  enqueue(event: EventEnvelope): void {
    this.database.raw
      .prepare(`
        INSERT INTO inbox
          (inbox_id, oren_id, event_json, status, received_at)
        VALUES (?, ?, ?, 'pending', ?)
        ON CONFLICT(inbox_id) DO NOTHING
      `)
      .run(
        event.eventId,
        event.orenId,
        JSON.stringify(event),
        event.recordedAt,
      );
  }

  nextPending(orenId: string): EventEnvelope | null {
    const row = this.database.raw
      .prepare(`
        SELECT event_json FROM inbox
        WHERE oren_id = ? AND status = 'pending'
        ORDER BY received_at ASC, inbox_id ASC
        LIMIT 1
      `)
      .get(orenId) as { event_json: string } | undefined;
    return row ? (JSON.parse(row.event_json) as EventEnvelope) : null;
  }

  completeAsEvent(
    event: EventEnvelope,
    chronicle: ChronicleStore,
  ): number {
    return this.database.transaction(() => {
      const sequence = chronicle.append(event);
      this.database.raw
        .prepare(`
          UPDATE inbox
          SET status = 'completed', completed_sequence = ?
          WHERE inbox_id = ?
        `)
        .run(sequence, event.eventId);
      return sequence;
    });
  }

  pendingCount(orenId: string): number {
    const row = this.database.raw
      .prepare(`
        SELECT COUNT(*) AS count FROM inbox
        WHERE oren_id = ? AND status = 'pending'
      `)
      .get(orenId) as { count: number };
    return row.count;
  }
}
```

Export `InboxStore` from `packages/storage/src/index.ts`.

- [ ] **Step 4: Add the dependency-injected single-writer actor**

```ts
// packages/kernel/src/life-actor.ts
import type {
  DecisionBatch,
  EventEnvelope,
} from "./protocol.js";
import type { LifeState } from "./state.js";

export interface LifeActorPorts {
  loadState(): LifeState;
  takeNext(): EventEnvelope | null;
  commitInboxEvent(event: EventEnvelope): {
    sequence: number;
    event: EventEnvelope;
  };
  commitDecisionBatch(batch: DecisionBatch): Array<{
    sequence: number;
    event: EventEnvelope;
  }>;
}

export class LifeActor {
  private running = false;

  constructor(private readonly ports: LifeActorPorts) {}

  async processOne(): Promise<
    { event: EventEnvelope; state: LifeState } | null
  > {
    if (this.running) {
      throw new Error("LifeActor is already processing");
    }
    this.running = true;
    try {
      const event = this.ports.takeNext();
      if (!event) return null;
      this.ports.commitInboxEvent(event);
      return { event, state: this.ports.loadState() };
    } finally {
      this.running = false;
    }
  }

  commitDecisions(batch: DecisionBatch): LifeState {
    if (this.running) {
      throw new Error("LifeActor is already processing");
    }
    this.running = true;
    try {
      this.ports.commitDecisionBatch(batch);
      return this.ports.loadState();
    } finally {
      this.running = false;
    }
  }
}
```

Export `LifeActor` and `LifeActorPorts` from `packages/kernel/src/index.ts`.

- [ ] **Step 5: Add the serial ordering test**

Add this test inside the existing `describe("LifeActor", ...)` block:

```ts
it("commits queued facts in mailbox order", async () => {
  let state = createInitialLifeState("oren-1", "person-1");
  const queue: EventEnvelope[] = ["thread-1", "thread-2"].map(
    (threadId, index) => ({
      eventId: `event-${index + 1}`,
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: `2026-07-23T00:00:0${index}.000Z`,
      recordedAt: `2026-07-23T00:00:0${index}.000Z`,
      source: "test",
      causationId: null,
      correlationId: "correlation-order",
      payload: {
        type: "ThreadActivated",
        threadId,
        summary: threadId,
      },
    }),
  );
  let sequence = 0;
  const actor = new LifeActor({
    loadState: () => state,
    takeNext: () => queue.shift() ?? null,
    commitInboxEvent: (event) => {
      sequence += 1;
      state = reduceLifeState(state, sequence, event);
      return { sequence, event };
    },
    commitDecisionBatch: () => [],
  });

  await actor.processOne();
  await actor.processOne();

  expect(state.attention.activeThreadIds).toEqual([
    "thread-1",
    "thread-2",
  ]);
  expect(state.chronicleCursor).toBe(2);
});
```

- [ ] **Step 6: Run the task checks**

Run: `npm test -- packages/storage/test/inbox-store.test.ts packages/kernel/test/life-actor.test.ts && npm run typecheck`

Expected: PASS; inbox deduplicates inputs and one actor processes them serially.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel packages/storage
git commit -m "feat: add durable life actor inbox"
```

---

### Task 5: Implement LifeFrame and the Scripted Cognition Adapter

**Files:**
- Create: `packages/cognition/package.json`
- Create: `packages/cognition/src/cognition-adapter.ts`
- Create: `packages/cognition/src/life-frame.ts`
- Create: `packages/cognition/src/conductor.ts`
- Create: `packages/cognition/src/scripted-adapter.ts`
- Create: `packages/cognition/src/index.ts`
- Test: `packages/cognition/test/conductor.test.ts`

**Interfaces:**
- Consumes: `LifeState`, `EventEnvelope`, `Proposal`
- Produces: `LifeFrame`, `CognitionAdapter.run()`, `Conductor.deliberate()`, `ScriptedCognitionAdapter`

- [ ] **Step 1: Write the failing conductor test**

```ts
// packages/cognition/test/conductor.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  type EventEnvelope,
} from "@oren/kernel";
import {
  Conductor,
  ScriptedCognitionAdapter,
} from "../src/index.js";

describe("Conductor", () => {
  it("lets the adapter choose proposals from one LifeFrame", async () => {
    const trigger: EventEnvelope = {
      eventId: "wake-1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-23T02:00:00.000Z",
      recordedAt: "2026-07-23T02:00:00.000Z",
      source: "scheduler",
      causationId: null,
      correlationId: "episode-1",
      payload: {
        type: "WakeDue",
        scheduleId: "schedule-1",
        purpose: "advance thread-1",
      },
    };
    const adapter = new ScriptedCognitionAdapter([
      {
        type: "AdvanceThread",
        threadId: "thread-1",
        summary: "Read one source",
      },
      {
        type: "ScheduleWake",
        scheduleId: "schedule-2",
        dueAt: "2026-07-24T02:00:00.000Z",
        purpose: "continue thread-1",
      },
    ]);
    const conductor = new Conductor(adapter);

    const result = await conductor.deliberate(
      createInitialLifeState("oren-1", "person-1"),
      trigger,
      [],
    );

    expect(result.frame.triggerEventId).toBe("wake-1");
    expect(result.proposals).toHaveLength(2);
    expect(adapter.calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/cognition/test/conductor.test.ts`

Expected: FAIL because the cognition package does not exist.

- [ ] **Step 3: Add cognition ports and frame construction**

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

```ts
// packages/cognition/src/life-frame.ts
import type {
  EventEnvelope,
  JsonValue,
  LifeState,
} from "@oren/kernel";

export interface CapabilitySummary {
  name: string;
  riskTraits: string[];
  constraints: JsonValue;
}

export interface LifeFrame {
  triggerEventId: string;
  trigger: EventEnvelope["payload"];
  stateVersion: number;
  identity: LifeState["identity"];
  attention: LifeState["attention"];
  commitments: LifeState["commitments"];
  relationship: LifeState["relationship"];
  pendingOperationIds: string[];
  availableCapabilities: CapabilitySummary[];
  budgets: LifeState["budgets"];
  previousWakeReason: string | null;
}

export function createLifeFrame(
  state: LifeState,
  trigger: EventEnvelope,
  capabilities: CapabilitySummary[],
): LifeFrame {
  return {
    triggerEventId: trigger.eventId,
    trigger: structuredClone(trigger.payload),
    stateVersion: state.version,
    identity: structuredClone(state.identity),
    attention: structuredClone(state.attention),
    commitments: structuredClone(state.commitments),
    relationship: structuredClone(state.relationship),
    pendingOperationIds: [...state.pendingOperationIds],
    availableCapabilities: structuredClone(capabilities),
    budgets: structuredClone(state.budgets),
    previousWakeReason:
      trigger.payload.type === "WakeDue"
        ? trigger.payload.purpose
        : null,
  };
}
```

```ts
// packages/cognition/src/cognition-adapter.ts
import type { Proposal } from "@oren/kernel";
import type { LifeFrame } from "./life-frame.js";

export interface CognitionAdapter {
  run(frame: Readonly<LifeFrame>): Promise<Proposal[]>;
}
```

- [ ] **Step 4: Add the conductor and deterministic adapter**

```ts
// packages/cognition/src/conductor.ts
import type {
  EventEnvelope,
  LifeState,
  Proposal,
} from "@oren/kernel";
import type { CognitionAdapter } from "./cognition-adapter.js";
import {
  createLifeFrame,
  type CapabilitySummary,
  type LifeFrame,
} from "./life-frame.js";

export class Conductor {
  constructor(private readonly adapter: CognitionAdapter) {}

  async deliberate(
    state: LifeState,
    trigger: EventEnvelope,
    capabilities: CapabilitySummary[],
  ): Promise<{ frame: LifeFrame; proposals: Proposal[] }> {
    const frame = createLifeFrame(state, trigger, capabilities);
    const proposals = await this.adapter.run(structuredClone(frame));
    return { frame, proposals };
  }
}
```

```ts
// packages/cognition/src/scripted-adapter.ts
import type { Proposal } from "@oren/kernel";
import type { CognitionAdapter } from "./cognition-adapter.js";
import type { LifeFrame } from "./life-frame.js";

export class ScriptedCognitionAdapter implements CognitionAdapter {
  calls = 0;

  constructor(private readonly script: Proposal[]) {}

  async run(_frame: Readonly<LifeFrame>): Promise<Proposal[]> {
    this.calls += 1;
    return structuredClone(this.script);
  }
}
```

```ts
// packages/cognition/src/index.ts
export * from "./cognition-adapter.js";
export * from "./life-frame.js";
export * from "./conductor.js";
export * from "./scripted-adapter.js";
```

- [ ] **Step 5: Run the task checks**

Run: `npm install && npm test -- packages/cognition/test/conductor.test.ts && npm run typecheck`

Expected: PASS; the adapter sees one frame and returns typed proposals without mutating state.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/cognition
git commit -m "feat: add life-frame cognition protocol"
```

---

### Task 6: Enforce Grants and the Three Resource Boundaries

**Files:**
- Create: `packages/kernel/src/guard.ts`
- Modify: `packages/kernel/src/index.ts`
- Test: `packages/kernel/test/guard.test.ts`
- Create: `packages/storage/src/grant-store.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Consumes: `Proposal`, `LifeState`, capability risk traits
- Produces: `Grant`, `GuardContext`, `GuardDecision`, `evaluateProposal()`, `GrantStore`

- [ ] **Step 1: Write failing budget-separation tests**

```ts
// packages/kernel/test/guard.test.ts
import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  evaluateProposal,
  type GuardContext,
  type Proposal,
} from "../src/index.js";

const proposal: Proposal = {
  type: "RequestCapability",
  intentId: "intent-1",
  capability: "test.increment",
  arguments: { amount: 1 },
  riskTraits: ["read_only"],
  commitmentId: null,
};

function context(
  triggerKind: GuardContext["triggerKind"],
): GuardContext {
  return {
    now: "2026-07-23T00:00:00.000Z",
    triggerKind,
    episodeStep: 1,
    grants: [],
  };
}

describe("evaluateProposal", () => {
  it("blocks idle autonomy when its budget is empty", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    expect(evaluateProposal(state, proposal, context("autonomy"))).toEqual({
      accepted: false,
      reason: "autonomy_budget_exhausted",
      grantIds: [],
    });
  });

  it("does not apply the autonomy budget to foreground interaction", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    expect(evaluateProposal(state, proposal, context("interaction"))).toEqual({
      accepted: true,
      reason: "accepted",
      grantIds: [],
    });
  });

  it("stops one interaction episode at its technical step bound", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    expect(
      evaluateProposal(state, proposal, {
        ...context("interaction"),
        episodeStep: 9,
      }),
    ).toEqual({
      accepted: false,
      reason: "interaction_step_limit",
      grantIds: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test -- packages/kernel/test/guard.test.ts`

Expected: FAIL because `evaluateProposal` does not exist.

- [ ] **Step 3: Implement grants and proposal evaluation**

```ts
// packages/kernel/src/guard.ts
import type { GrantId } from "./ids.js";
import type { JsonValue, Proposal } from "./protocol.js";
import type { LifeState } from "./state.js";

export interface Grant {
  grantId: GrantId;
  issuer: string;
  subject: string;
  capabilityPattern: string;
  resourceScope: JsonValue;
  constraints: JsonValue;
  approvalMode: "always" | "within_scope";
  issuedAt: string;
  expiresAt: string | null;
  revocable: boolean;
  revokedAt: string | null;
  delegationChain: string[];
}

export interface GuardContext {
  now: string;
  triggerKind: "autonomy" | "interaction" | "commitment";
  episodeStep: number;
  grants: Grant[];
}

export interface GuardDecision {
  accepted: boolean;
  reason: string;
  grantIds: GrantId[];
}

function matchingGrants(
  proposal: Extract<Proposal, { type: "RequestCapability" }>,
  context: GuardContext,
): Grant[] {
  return context.grants.filter((grant) => {
    const active =
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > context.now);
    const matches =
      grant.capabilityPattern === proposal.capability ||
      grant.capabilityPattern === "*";
    return active && matches;
  });
}

export function evaluateProposal(
  state: LifeState,
  proposal: Proposal,
  context: GuardContext,
): GuardDecision {
  if (
    context.triggerKind === "interaction" &&
    context.episodeStep > state.budgets.interactionMaxSteps
  ) {
    return {
      accepted: false,
      reason: "interaction_step_limit",
      grantIds: [],
    };
  }

  if (
    context.triggerKind === "autonomy" &&
    state.budgets.autonomyRemaining <= 0
  ) {
    return {
      accepted: false,
      reason: "autonomy_budget_exhausted",
      grantIds: [],
    };
  }

  if (context.triggerKind === "commitment") {
    const commitmentId =
      proposal.type === "RequestCapability"
        ? proposal.commitmentId
        : null;
    if (
      commitmentId === null ||
      (state.budgets.commitmentRemaining[commitmentId] ?? 0) <= 0
    ) {
      return {
        accepted: false,
        reason: "commitment_budget_exhausted",
        grantIds: [],
      };
    }
  }

  if (proposal.type !== "RequestCapability") {
    return { accepted: true, reason: "accepted", grantIds: [] };
  }

  const requiresGrant = proposal.riskTraits.some((trait) =>
    [
      "external_side_effect",
      "uses_user_identity",
      "uses_sensitive_data",
      "billable",
      "destructive",
    ].includes(trait),
  );
  const grants = matchingGrants(proposal, context);
  if (requiresGrant && grants.length === 0) {
    return {
      accepted: false,
      reason: "grant_required",
      grantIds: [],
    };
  }

  return {
    accepted: true,
    reason: "accepted",
    grantIds: grants.map((grant) => grant.grantId),
  };
}
```

Export the guard types and function from `packages/kernel/src/index.ts`.

- [ ] **Step 4: Add durable grants**

Append to `applyMigrations()`:

```sql
CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS grants_for_oren
  ON grants (oren_id, revoked_at);
```

Create `GrantStore` with these exact methods:

```ts
// packages/storage/src/grant-store.ts
import type { Grant } from "@oren/kernel";
import type { SqliteDatabase } from "./database.js";

export class GrantStore {
  constructor(private readonly database: SqliteDatabase) {}

  put(orenId: string, grant: Grant): void {
    this.database.raw
      .prepare(`
        INSERT OR REPLACE INTO grants
          (grant_id, oren_id, grant_json, issued_at, revoked_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        grant.grantId,
        orenId,
        JSON.stringify(grant),
        grant.issuedAt,
        grant.revokedAt,
      );
  }

  active(orenId: string, now: string): Grant[] {
    const rows = this.database.raw
      .prepare(`
        SELECT grant_json FROM grants
        WHERE oren_id = ?
          AND revoked_at IS NULL
      `)
      .all(orenId) as unknown as Array<{ grant_json: string }>;
    return rows
      .map((row) => JSON.parse(row.grant_json) as Grant)
      .filter((grant) => grant.expiresAt === null || grant.expiresAt > now);
  }

  revoke(grantId: string, revokedAt: string): void {
    this.database.raw
      .prepare("UPDATE grants SET revoked_at = ? WHERE grant_id = ?")
      .run(revokedAt, grantId);
  }
}
```

Export `GrantStore` from `packages/storage/src/index.ts`.

- [ ] **Step 5: Add grant-required and commitment-budget tests**

Add these cases to `guard.test.ts`:

```ts
it("requires a grant for a billable effect", () => {
  const state = createInitialLifeState("oren-1", "person-1");
  const billable: Proposal = {
    ...proposal,
    riskTraits: ["billable"],
  };
  expect(evaluateProposal(state, billable, context("interaction")).reason)
    .toBe("grant_required");
});

it("uses a separate commitment budget", () => {
  const state = createInitialLifeState("oren-1", "person-1");
  state.budgets.commitmentRemaining["commitment-1"] = 0;
  const committed: Proposal = {
    ...proposal,
    commitmentId: "commitment-1",
  };
  expect(evaluateProposal(state, committed, context("commitment")).reason)
    .toBe("commitment_budget_exhausted");
});
```

- [ ] **Step 6: Run the task checks**

Run: `npm test -- packages/kernel/test/guard.test.ts && npm run typecheck`

Expected: PASS; autonomy, interaction, commitment, and grant decisions are distinct.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel packages/storage
git commit -m "feat: enforce grants and resource boundaries"
```

---

### Task 7: Build the Capability Registry and Test Extension

**Files:**
- Create: `packages/capabilities/package.json`
- Create: `packages/capabilities/src/manifest.ts`
- Create: `packages/capabilities/src/extension.ts`
- Create: `packages/capabilities/src/registry.ts`
- Create: `packages/capabilities/src/runtime.ts`
- Create: `packages/capabilities/src/index.ts`
- Test: `packages/capabilities/test/runtime.test.ts`
- Create: `extensions/test-counter/package.json`
- Create: `extensions/test-counter/src/index.ts`

**Interfaces:**
- Consumes: `Effect`, `JsonValue`
- Produces: `ExtensionManifest`, `Invocation`, `CapabilityResult`, `Extension`, `ExtensionRegistry`, `CapabilityRuntime`

- [ ] **Step 1: Write the failing extension-runtime test**

```ts
// packages/capabilities/test/runtime.test.ts
import { describe, expect, it } from "vitest";
import { CounterExtension } from "@oren/test-counter";
import {
  CapabilityRuntime,
  ExtensionRegistry,
} from "../src/index.js";

describe("CapabilityRuntime", () => {
  it("discovers and invokes a typed extension without LifeState access", async () => {
    const registry = new ExtensionRegistry();
    const extension = new CounterExtension();
    registry.register(extension);
    const runtime = new CapabilityRuntime(
      registry,
      () => "2026-07-23T00:00:00.000Z",
    );

    const result = await runtime.invoke({
      invocationId: "invocation-1",
      orenId: "oren-1",
      intentId: "intent-1",
      capability: "test.increment",
      arguments: { amount: 2 },
      grantIds: [],
      stateVersion: 3,
      deadline: "2026-07-23T01:00:00.000Z",
      idempotencyKey: "effect-1",
      correlationId: "episode-1",
    });

    expect(result).toEqual({
      type: "Completed",
      receipt: { value: 2 },
    });
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/capabilities/test/runtime.test.ts`

Expected: FAIL because the capability packages do not exist.

- [ ] **Step 3: Define the extension protocol**

```json
// packages/capabilities/package.json
{
  "name": "@oren/capabilities",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/kernel": "*"
  }
}
```

```ts
// packages/capabilities/src/manifest.ts
import type { JsonValue } from "@oren/kernel";

export interface CapabilityDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  permissionRequirements: string[];
  riskTraits: string[];
  idempotency: "required";
  cancellable: boolean;
  timeoutMs: number;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  protocolVersion: 1;
  capabilities: CapabilityDefinition[];
  eventSources: string[];
}
```

```ts
// packages/capabilities/src/extension.ts
import type { JsonValue } from "@oren/kernel";
import type { ExtensionManifest } from "./manifest.js";

export interface Invocation {
  invocationId: string;
  orenId: string;
  intentId: string;
  capability: string;
  arguments: JsonValue;
  grantIds: string[];
  stateVersion: number;
  deadline: string;
  idempotencyKey: string;
  correlationId: string;
}

export type CapabilityResult =
  | { type: "Progress"; message: string }
  | { type: "Completed"; receipt: JsonValue }
  | {
      type: "Failed";
      category:
        | "Retryable"
        | "NeedsReconciliation"
        | "NeedsAttention"
        | "Terminal";
      message: string;
    };

export interface Extension {
  readonly manifest: ExtensionManifest;
  invoke(invocation: Readonly<Invocation>): Promise<CapabilityResult>;
  cancel?(invocationId: string): Promise<CapabilityResult>;
  status?(idempotencyKey: string): Promise<CapabilityResult>;
}
```

- [ ] **Step 4: Add registry and runtime**

```ts
// packages/capabilities/src/registry.ts
import type { Extension } from "./extension.js";
import type { CapabilityDefinition } from "./manifest.js";

export class ExtensionRegistry {
  private readonly extensions = new Map<string, Extension>();
  private readonly capabilities = new Map<string, Extension>();

  register(extension: Extension): void {
    if (this.extensions.has(extension.manifest.id)) {
      throw new Error(`Extension already registered: ${extension.manifest.id}`);
    }
    for (const capability of extension.manifest.capabilities) {
      if (this.capabilities.has(capability.name)) {
        throw new Error(`Capability already registered: ${capability.name}`);
      }
      this.capabilities.set(capability.name, extension);
    }
    this.extensions.set(extension.manifest.id, extension);
  }

  extensionFor(capability: string): Extension {
    const extension = this.capabilities.get(capability);
    if (!extension) throw new Error(`Unknown capability: ${capability}`);
    return extension;
  }

  listCapabilities(): string[] {
    return [...this.capabilities.keys()].sort();
  }

  listDefinitions(): CapabilityDefinition[] {
    return [...this.capabilities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, extension]) => {
        const definition = extension.manifest.capabilities.find(
          (item) => item.name === name,
        );
        if (!definition) throw new Error(`Missing definition: ${name}`);
        return structuredClone(definition);
      });
  }
}
```

```ts
// packages/capabilities/src/runtime.ts
import type {
  CapabilityResult,
  Invocation,
} from "./extension.js";
import type { ExtensionRegistry } from "./registry.js";

export class CapabilityRuntime {
  constructor(
    private readonly registry: ExtensionRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async invoke(
    invocation: Invocation,
  ): Promise<CapabilityResult> {
    const extension = this.registry.extensionFor(invocation.capability);
    const definition = extension.manifest.capabilities.find(
      (item) => item.name === invocation.capability,
    );
    if (!definition) {
      throw new Error(`Missing definition: ${invocation.capability}`);
    }
    const deadline = Date.parse(invocation.deadline);
    if (!Number.isFinite(deadline) || deadline <= Date.parse(this.now())) {
      return {
        type: "Failed",
        category: "Terminal",
        message: "Invocation deadline has passed",
      };
    }
    return extension.invoke(Object.freeze(structuredClone(invocation)));
  }
}
```

```ts
// packages/capabilities/src/index.ts
export * from "./manifest.js";
export * from "./extension.js";
export * from "./registry.js";
export * from "./runtime.js";
```

- [ ] **Step 5: Add the deterministic counter extension**

```json
// extensions/test-counter/package.json
{
  "name": "@oren/test-counter",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/capabilities": "*"
  }
}
```

```ts
// extensions/test-counter/src/index.ts
import type {
  CapabilityResult,
  Extension,
  ExtensionManifest,
  Invocation,
} from "@oren/capabilities";

export class CounterExtension implements Extension {
  private value = 0;
  private readonly receipts = new Map<string, CapabilityResult>();

  readonly manifest: ExtensionManifest = {
    id: "test-counter",
    version: "1.0.0",
    protocolVersion: 1,
    capabilities: [
      {
        name: "test.increment",
        description: "Increment a deterministic in-memory counter",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "number" } },
          required: ["amount"],
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        permissionRequirements: [],
        riskTraits: ["reversible"],
        idempotency: "required",
        cancellable: false,
        timeoutMs: 1000,
      },
    ],
    eventSources: [],
  };

  async invoke(
    invocation: Readonly<Invocation>,
  ): Promise<CapabilityResult> {
    const existing = this.receipts.get(invocation.idempotencyKey);
    if (existing) return structuredClone(existing);
    const argumentsValue = invocation.arguments as { amount?: unknown };
    if (typeof argumentsValue.amount !== "number") {
      return {
        type: "Failed",
        category: "Terminal",
        message: "amount must be a number",
      };
    }
    this.value += argumentsValue.amount;
    const result: CapabilityResult = {
      type: "Completed",
      receipt: { value: this.value },
    };
    this.receipts.set(
      invocation.idempotencyKey,
      structuredClone(result),
    );
    return result;
  }
}
```

- [ ] **Step 6: Run the task checks**

Run: `npm install && npm test -- packages/capabilities/test/runtime.test.ts && npm run typecheck`

Expected: PASS; the runtime invokes a discovered capability and returns `{ value: 2 }`.

- [ ] **Step 7: Commit**

```bash
git add package-lock.json packages/capabilities extensions/test-counter
git commit -m "feat: add capability extension protocol"
```

---

### Task 8: Add Durable Effects, Operations, and Recovery

**Files:**
- Create: `packages/storage/src/outbox-store.ts`
- Create: `packages/storage/src/operation-store.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/outbox-store.test.ts`
- Create: `packages/app/package.json`
- Create: `packages/app/src/effect-dispatcher.ts`
- Create: `packages/app/src/index.ts`
- Test: `packages/app/test/effect-dispatcher.test.ts`

**Interfaces:**
- Consumes: `Effect`, `CapabilityRuntime`, `InboxStore`
- Produces: `OutboxStore`, `OperationStore`, `EffectDispatcher.dispatchNext()`

- [ ] **Step 1: Write the failing crash-safe dispatch test**

```ts
// packages/app/test/effect-dispatcher.test.ts
import { describe, expect, it } from "vitest";
import {
  CapabilityRuntime,
  ExtensionRegistry,
} from "@oren/capabilities";
import { CounterExtension } from "@oren/test-counter";
import {
  applyMigrations,
  InboxStore,
  OperationStore,
  OutboxStore,
  SqliteDatabase,
} from "@oren/storage";
import { EffectDispatcher } from "../src/index.js";

describe("EffectDispatcher", () => {
  it("does not execute an already completed idempotency key twice", async () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const outbox = new OutboxStore(database);
    const operations = new OperationStore(database);
    const inbox = new InboxStore(database);
    const registry = new ExtensionRegistry();
    registry.register(new CounterExtension());
    const runtime = new CapabilityRuntime(registry);
    const dispatcher = new EffectDispatcher(
      database,
      outbox,
      operations,
      inbox,
      runtime,
    );

    outbox.enqueue({
      effectId: "effect-1",
      orenId: "oren-1",
      intentId: "intent-1",
      capability: "test.increment",
      arguments: { amount: 2 },
      grantIds: [],
      stateVersion: 1,
      deadline: "2099-07-23T00:00:00.000Z",
      idempotencyKey: "increment-once",
      correlationId: "episode-1",
    });

    await dispatcher.dispatchNext("oren-1");
    outbox.requeue("effect-1");
    await dispatcher.dispatchNext("oren-1");

    expect(operations.completedReceipt("increment-once")).toEqual({
      value: 2,
    });
    expect(inbox.pendingCount("oren-1")).toBe(1);
  });
});
```

```ts
// packages/storage/test/outbox-store.test.ts
import { describe, expect, it } from "vitest";
import type { Effect } from "@oren/kernel";
import {
  applyMigrations,
  OutboxStore,
  SqliteDatabase,
} from "../src/index.js";

describe("OutboxStore", () => {
  it("enqueues one durable effect by effect id", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const outbox = new OutboxStore(database);
    const effect: Effect = {
      effectId: "effect-1",
      orenId: "oren-1",
      intentId: "intent-1",
      capability: "test.increment",
      arguments: { amount: 2 },
      grantIds: [],
      stateVersion: 1,
      deadline: "2099-07-23T00:00:00.000Z",
      idempotencyKey: "increment-once",
      correlationId: "episode-1",
    };

    outbox.enqueue(effect);
    outbox.enqueue(effect);

    expect(outbox.nextPending("oren-1")).toEqual(effect);
    outbox.markDispatched("effect-1");
    expect(outbox.nextPending("oren-1")).toBeNull();
    expect(outbox.recoverDispatched()).toBe(1);
    expect(outbox.nextPending("oren-1")).toEqual(effect);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/app/test/effect-dispatcher.test.ts packages/storage/test/outbox-store.test.ts`

Expected: FAIL because outbox, operations, app package, and dispatcher do not exist.

- [ ] **Step 3: Add outbox and operation tables**

Append to `applyMigrations()`:

```sql
CREATE TABLE IF NOT EXISTS outbox (
  effect_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'completed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_pending
  ON outbox (oren_id, status, created_at);

CREATE TABLE IF NOT EXISTS operations (
  idempotency_key TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL,
  oren_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  updated_at TEXT NOT NULL
);
```

```ts
// packages/storage/src/outbox-store.ts
import type { Effect } from "@oren/kernel";
import type { SqliteDatabase } from "./database.js";

export class OutboxStore {
  constructor(private readonly database: SqliteDatabase) {}

  enqueue(effect: Effect): void {
    this.database.raw
      .prepare(`
        INSERT INTO outbox
          (effect_id, oren_id, effect_json, status, created_at)
        VALUES (?, ?, ?, 'pending', ?)
        ON CONFLICT(effect_id) DO NOTHING
      `)
      .run(
        effect.effectId,
        effect.orenId,
        JSON.stringify(effect),
        new Date().toISOString(),
      );
  }

  nextPending(orenId: string): Effect | null {
    const row = this.database.raw
      .prepare(`
        SELECT effect_json FROM outbox
        WHERE oren_id = ? AND status = 'pending'
        ORDER BY created_at ASC, effect_id ASC
        LIMIT 1
      `)
      .get(orenId) as { effect_json: string } | undefined;
    return row ? (JSON.parse(row.effect_json) as Effect) : null;
  }

  markDispatched(effectId: string): void {
    this.setStatus(effectId, "dispatched");
  }

  markCompleted(effectId: string): void {
    this.setStatus(effectId, "completed");
  }

  requeue(effectId: string): void {
    this.setStatus(effectId, "pending");
  }

  recoverDispatched(): number {
    const result = this.database.raw
      .prepare(`
        UPDATE outbox
        SET status = 'pending'
        WHERE status = 'dispatched'
      `)
      .run();
    return Number(result.changes);
  }

  private setStatus(
    effectId: string,
    status: "pending" | "dispatched" | "completed",
  ): void {
    this.database.raw
      .prepare("UPDATE outbox SET status = ? WHERE effect_id = ?")
      .run(status, effectId);
  }
}
```

```ts
// packages/storage/src/operation-store.ts
import type { Effect, JsonValue } from "@oren/kernel";
import type { SqliteDatabase } from "./database.js";

export class OperationStore {
  constructor(private readonly database: SqliteDatabase) {}

  begin(effect: Effect, now: string): void {
    this.database.raw
      .prepare(`
        INSERT INTO operations (
          idempotency_key, effect_id, oren_id, capability,
          status, result_json, updated_at
        ) VALUES (?, ?, ?, ?, 'running', NULL, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .run(
        effect.idempotencyKey,
        effect.effectId,
        effect.orenId,
        effect.capability,
        now,
      );
  }

  complete(
    effect: Effect,
    receipt: JsonValue,
    now: string,
  ): void {
    this.database.raw
      .prepare(`
        UPDATE operations
        SET status = 'completed', result_json = ?, updated_at = ?
        WHERE idempotency_key = ?
      `)
      .run(JSON.stringify(receipt), now, effect.idempotencyKey);
  }

  fail(
    effect: Effect,
    result: unknown,
    now: string,
  ): void {
    this.database.raw
      .prepare(`
        UPDATE operations
        SET status = 'failed', result_json = ?, updated_at = ?
        WHERE idempotency_key = ?
      `)
      .run(JSON.stringify(result), now, effect.idempotencyKey);
  }

  progress(
    effect: Effect,
    result: unknown,
    now: string,
  ): void {
    this.database.raw
      .prepare(`
        UPDATE operations
        SET status = 'running', result_json = ?, updated_at = ?
        WHERE idempotency_key = ?
      `)
      .run(JSON.stringify(result), now, effect.idempotencyKey);
  }

  completedReceipt(idempotencyKey: string): JsonValue | null {
    const row = this.database.raw
      .prepare(`
        SELECT result_json FROM operations
        WHERE idempotency_key = ? AND status = 'completed'
      `)
      .get(idempotencyKey) as { result_json: string | null } | undefined;
    return row?.result_json
      ? (JSON.parse(row.result_json) as JsonValue)
      : null;
  }
}
```

Export `OutboxStore` and `OperationStore` from `packages/storage/src/index.ts`.

- [ ] **Step 4: Add the app package and dispatcher**

```json
// packages/app/package.json
{
  "name": "@oren/app",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/capabilities": "*",
    "@oren/cognition": "*",
    "@oren/kernel": "*",
    "@oren/storage": "*"
  }
}
```

```ts
// packages/app/src/effect-dispatcher.ts
import type { CapabilityRuntime } from "@oren/capabilities";
import type { EventEnvelope } from "@oren/kernel";
import type {
  InboxStore,
  OperationStore,
  OutboxStore,
  SqliteDatabase,
} from "@oren/storage";

export class EffectDispatcher {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly outbox: OutboxStore,
    private readonly operations: OperationStore,
    private readonly inbox: InboxStore,
    private readonly runtime: CapabilityRuntime,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  recoverInterruptedDispatches(): number {
    return this.outbox.recoverDispatched();
  }

  async dispatchNext(orenId: string): Promise<boolean> {
    const effect = this.outbox.nextPending(orenId);
    if (!effect) return false;

    const existing = this.operations.completedReceipt(
      effect.idempotencyKey,
    );
    if (existing !== null) {
      const now = this.clock();
      const event: EventEnvelope = {
        eventId: `result:${effect.effectId}`,
        orenId: effect.orenId,
        schemaVersion: 1,
        occurredAt: now,
        recordedAt: now,
        source: "capability-runtime",
        causationId: effect.effectId,
        correlationId: effect.correlationId,
        payload: {
          type: "CapabilityCompleted",
          effectId: effect.effectId,
          capability: effect.capability,
          receipt: existing,
        },
      };
      this.database.transaction(() => {
        this.inbox.enqueue(event);
        this.outbox.markCompleted(effect.effectId);
      });
      return true;
    }

    const now = this.clock();
    this.database.transaction(() => {
      this.operations.begin(effect, now);
      this.outbox.markDispatched(effect.effectId);
    });
    const result = await this.runtime.invoke({
      invocationId: effect.effectId,
      orenId: effect.orenId,
      intentId: effect.intentId,
      capability: effect.capability,
      arguments: effect.arguments,
      grantIds: effect.grantIds,
      stateVersion: effect.stateVersion,
      deadline: effect.deadline,
      idempotencyKey: effect.idempotencyKey,
      correlationId: effect.correlationId,
    });

    if (result.type === "Progress") {
      this.operations.progress(effect, result, now);
      return true;
    }

    const event: EventEnvelope =
      result.type === "Completed"
        ? {
            eventId: `result:${effect.effectId}`,
            orenId: effect.orenId,
            schemaVersion: 1,
            occurredAt: now,
            recordedAt: now,
            source: "capability-runtime",
            causationId: effect.effectId,
            correlationId: effect.correlationId,
            payload: {
              type: "CapabilityCompleted",
              effectId: effect.effectId,
              capability: effect.capability,
              receipt: result.receipt,
            },
          }
        : {
            eventId: `result:${effect.effectId}`,
            orenId: effect.orenId,
            schemaVersion: 1,
            occurredAt: now,
            recordedAt: now,
            source: "capability-runtime",
            causationId: effect.effectId,
            correlationId: effect.correlationId,
            payload: {
              type: "CapabilityFailed",
              effectId: effect.effectId,
              capability: effect.capability,
              category: result.category,
              message: result.message,
            },
          };

    this.database.transaction(() => {
      if (result.type === "Completed") {
        this.operations.complete(effect, result.receipt, now);
      } else {
        this.operations.fail(effect, result, now);
      }
      this.outbox.markCompleted(effect.effectId);
      this.inbox.enqueue(event);
    });
    return true;
  }
}
```

Export `EffectDispatcher` from `packages/app/src/index.ts`.

- [ ] **Step 5: Run the task checks**

Run: `npm install && npm test -- packages/app/test/effect-dispatcher.test.ts packages/storage/test/outbox-store.test.ts && npm run typecheck`

Expected: PASS; the same idempotency key produces one counter increment and one durable result event.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/storage packages/app
git commit -m "feat: add durable effect dispatch"
```

---

### Task 9: Add Persistent Schedules and Idempotent Wake Delivery

**Files:**
- Create: `packages/storage/src/schedule-store.ts`
- Modify: `packages/storage/src/migrations.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/schedule-store.test.ts`
- Create: `packages/app/src/scheduler.ts`
- Modify: `packages/app/src/index.ts`
- Test: `packages/app/test/scheduler.test.ts`

**Interfaces:**
- Consumes: accepted `ScheduleWake` proposals
- Produces: `ScheduleStore.put()`, `ScheduleStore.due()`, `ScheduleStore.markDelivered()`, `Scheduler.poll()`

- [ ] **Step 1: Write the failing scheduler restart test**

```ts
// packages/app/test/scheduler.test.ts
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  InboxStore,
  ScheduleStore,
  SqliteDatabase,
} from "@oren/storage";
import { Scheduler } from "../src/index.js";

describe("Scheduler", () => {
  it("delivers one stable WakeDue event across repeated polls", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const schedules = new ScheduleStore(database);
    const inbox = new InboxStore(database);
    const scheduler = new Scheduler(schedules, inbox);
    schedules.put({
      scheduleId: "schedule-1",
      orenId: "oren-1",
      dueAt: "2026-07-23T01:00:00.000Z",
      purpose: "continue thread-1",
    });

    expect(scheduler.poll("2026-07-23T02:00:00.000Z")).toBe(1);
    expect(scheduler.poll("2026-07-23T02:00:00.000Z")).toBe(0);
    expect(inbox.pendingCount("oren-1")).toBe(1);
  });
});
```

```ts
// packages/storage/test/schedule-store.test.ts
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  ScheduleStore,
  SqliteDatabase,
} from "../src/index.js";

describe("ScheduleStore", () => {
  it("returns only undelivered schedules at or before now", () => {
    const database = new SqliteDatabase(":memory:");
    applyMigrations(database);
    const schedules = new ScheduleStore(database);
    schedules.put({
      scheduleId: "due",
      orenId: "oren-1",
      dueAt: "2026-07-23T01:00:00.000Z",
      purpose: "due",
    });
    schedules.put({
      scheduleId: "future",
      orenId: "oren-1",
      dueAt: "2026-07-25T01:00:00.000Z",
      purpose: "future",
    });

    expect(schedules.due("2026-07-24T00:00:00.000Z")).toEqual([
      {
        scheduleId: "due",
        orenId: "oren-1",
        dueAt: "2026-07-23T01:00:00.000Z",
        purpose: "due",
      },
    ]);
    schedules.markDelivered("due", "2026-07-24T00:00:00.000Z");
    expect(schedules.due("2026-07-24T00:00:00.000Z")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/app/test/scheduler.test.ts packages/storage/test/schedule-store.test.ts`

Expected: FAIL because schedule storage and scheduler do not exist.

- [ ] **Step 3: Add schedule persistence**

Append to `applyMigrations()`:

```sql
CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS schedules_due
  ON schedules (delivered_at, due_at);
```

```ts
// packages/storage/src/schedule-store.ts
import type { SqliteDatabase } from "./database.js";

export interface StoredSchedule {
  scheduleId: string;
  orenId: string;
  dueAt: string;
  purpose: string;
}

export class ScheduleStore {
  constructor(private readonly database: SqliteDatabase) {}

  put(schedule: StoredSchedule): void {
    this.database.raw
      .prepare(`
        INSERT INTO schedules
          (schedule_id, oren_id, due_at, purpose, delivered_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(schedule_id) DO NOTHING
      `)
      .run(
        schedule.scheduleId,
        schedule.orenId,
        schedule.dueAt,
        schedule.purpose,
      );
  }

  due(now: string): StoredSchedule[] {
    const rows = this.database.raw
      .prepare(`
        SELECT schedule_id, oren_id, due_at, purpose
        FROM schedules
        WHERE delivered_at IS NULL AND due_at <= ?
        ORDER BY due_at ASC, schedule_id ASC
      `)
      .all(now) as unknown as Array<{
        schedule_id: string;
        oren_id: string;
        due_at: string;
        purpose: string;
      }>;
    return rows.map((row) => ({
      scheduleId: row.schedule_id,
      orenId: row.oren_id,
      dueAt: row.due_at,
      purpose: row.purpose,
    }));
  }

  markDelivered(scheduleId: string, deliveredAt: string): void {
    this.database.raw
      .prepare(`
        UPDATE schedules
        SET delivered_at = ?
        WHERE schedule_id = ? AND delivered_at IS NULL
      `)
      .run(deliveredAt, scheduleId);
  }
}
```

- [ ] **Step 4: Add idempotent wake delivery**

```ts
// packages/app/src/scheduler.ts
import type { EventEnvelope } from "@oren/kernel";
import type {
  InboxStore,
  ScheduleStore,
} from "@oren/storage";

export class Scheduler {
  constructor(
    private readonly schedules: ScheduleStore,
    private readonly inbox: InboxStore,
  ) {}

  poll(now: string): number {
    let delivered = 0;
    for (const schedule of this.schedules.due(now)) {
      const event: EventEnvelope = {
        eventId: `wake:${schedule.scheduleId}:${schedule.dueAt}`,
        orenId: schedule.orenId,
        schemaVersion: 1,
        occurredAt: now,
        recordedAt: now,
        source: "scheduler",
        causationId: null,
        correlationId: `schedule:${schedule.scheduleId}`,
        payload: {
          type: "WakeDue",
          scheduleId: schedule.scheduleId,
          purpose: schedule.purpose,
        },
      };
      this.inbox.enqueue(event);
      this.schedules.markDelivered(schedule.scheduleId, now);
      delivered += 1;
    }
    return delivered;
  }
}
```

Export schedule storage and scheduler symbols from their package indexes.

- [ ] **Step 5: Run the task checks**

Run: `npm test -- packages/app/test/scheduler.test.ts packages/storage/test/schedule-store.test.ts && npm run typecheck`

Expected: PASS; repeated polls enqueue one stable wake event.

- [ ] **Step 6: Commit**

```bash
git add packages/storage packages/app
git commit -m "feat: add persistent life scheduler"
```

---

### Task 10: Compile Proposals and Run the End-to-End Life Slice

**Files:**
- Create: `packages/app/src/decision-compiler.ts`
- Create: `packages/app/src/life-runtime.ts`
- Create: `packages/app/src/demo.ts`
- Modify: `packages/app/src/index.ts`
- Modify: `packages/app/package.json`
- Modify: `package-lock.json`
- Test: `packages/app/test/life-runtime.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: all Phase 1 interfaces
- Produces: `DecisionCompiler.compile()`, `LifeRuntime.step()`, `npm run demo`

- [ ] **Step 1: Write the failing vertical-slice test**

The test must exercise this complete path:

```text
WakeDue inbox event
  → LifeActor appends and reduces it
  → Conductor returns FormIntent + RequestCapability + ScheduleWake
  → Guard accepts them under autonomy_budget
  → DecisionCompiler appends decision events and durable effect
  → EffectDispatcher invokes test.increment
  → CapabilityCompleted enters inbox
  → LifeActor consumes the result
  → Scheduler later emits the next WakeDue exactly once
  → fresh rehydration equals the in-memory LifeState
```

```ts
// packages/app/test/life-runtime.test.ts
import { describe, expect, it } from "vitest";
import { ScriptedCognitionAdapter } from "@oren/cognition";
import { CounterExtension } from "@oren/test-counter";
import { createInitialLifeState } from "@oren/kernel";
import { createTestRuntime } from "../src/life-runtime.js";

describe("LifeRuntime", () => {
  it("runs one autonomous wake through capability receipt and next wake", async () => {
    const runtime = createTestRuntime({
      orenId: "oren-1",
      personId: "person-1",
      initialState: {
        ...createInitialLifeState("oren-1", "person-1"),
        budgets: {
          autonomyRemaining: 3,
          interactionMaxSteps: 8,
          commitmentRemaining: {},
        },
      },
      adapter: new ScriptedCognitionAdapter([
        {
          type: "FormIntent",
          intentId: "intent-1",
          reason: "advance my own thread",
          proposedAction: "increment the test counter",
          expiresAt: "2099-07-23T00:00:00.000Z",
        },
        {
          type: "RequestCapability",
          intentId: "intent-1",
          capability: "test.increment",
          arguments: { amount: 2 },
          riskTraits: ["reversible"],
          commitmentId: null,
        },
        {
          type: "ScheduleWake",
          scheduleId: "schedule-2",
          dueAt: "2026-07-24T00:00:00.000Z",
          purpose: "continue my thread",
        },
      ]),
      extensions: [new CounterExtension()],
      now: () => "2026-07-23T00:00:00.000Z",
    });

    runtime.enqueueWake("schedule-1", "advance my thread");
    await runtime.step();
    await runtime.dispatchEffects();
    await runtime.step();

    expect(runtime.state().pendingOperationIds).toEqual([]);
    expect(runtime.state().intentions.map((item) => item.intentId))
      .toContain("intent-1");
    expect(runtime.state().schedules.map((item) => item.scheduleId))
      .toContain("schedule-2");
    expect(runtime.state().budgets.autonomyRemaining).toBe(2);
    expect(runtime.rehydrate()).toEqual(runtime.state());
    expect(runtime.pollSchedules("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(runtime.pollSchedules("2026-07-24T00:00:00.000Z")).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- packages/app/test/life-runtime.test.ts`

Expected: FAIL because `createTestRuntime`, `DecisionCompiler`, and `LifeRuntime` do not exist.

- [ ] **Step 3: Implement Proposal-to-decision compilation**

```ts
// packages/app/src/decision-compiler.ts
import type {
  CoreEvent,
  DecisionBatch,
  Effect,
  EventEnvelope,
  GrantId,
  LifeState,
  Proposal,
  ScheduledWake,
} from "@oren/kernel";

export interface CompiledDecision {
  events: EventEnvelope[];
  effects: Effect[];
  schedules: ScheduledWake[];
}

export interface CompileInput {
  state: LifeState;
  trigger: EventEnvelope;
  proposal: Proposal;
  proposalIndex: number;
  grantIds: GrantId[];
  triggerKind: "autonomy" | "interaction" | "commitment";
  now: string;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export class DecisionCompiler {
  compile(input: CompileInput): CompiledDecision {
    const {
      state,
      trigger,
      proposal,
      proposalIndex,
      grantIds,
      triggerKind,
      now,
    } = input;
    const base = `decision:${trigger.correlationId}:${proposalIndex}`;
    const events: EventEnvelope[] = [];
    const effects: Effect[] = [];
    const schedules: ScheduledWake[] = [];
    const append = (suffix: string, payload: CoreEvent): void => {
      events.push({
        eventId: `${base}:${suffix}`,
        orenId: state.orenId,
        schemaVersion: 1,
        occurredAt: now,
        recordedAt: now,
        source: "conductor",
        causationId: trigger.eventId,
        correlationId: trigger.correlationId,
        payload,
      });
    };

    switch (proposal.type) {
      case "NoAction":
        break;
      case "AdvanceThread":
        append("thread", {
          type: "ThreadAdvanced",
          threadId: proposal.threadId,
          summary: proposal.summary,
        });
        break;
      case "CreateOrUpdateCommitment": {
        const existing = state.commitments.find(
          (item) => item.commitmentId === proposal.commitmentId,
        );
        if (existing) {
          append("commitment", {
            type: "CommitmentAdvanced",
            commitmentId: proposal.commitmentId,
            nextStep: proposal.nextStep,
          });
        } else {
          append("commitment", {
            type: "CommitmentCreated",
            commitmentId: proposal.commitmentId,
            summary: proposal.summary,
            nextStep: proposal.nextStep,
            budgetRemaining: 0,
          });
        }
        break;
      }
      case "FormIntent":
        append("intent", {
          type: "IntentFormed",
          intentId: proposal.intentId,
          reason: proposal.reason,
          proposedAction: proposal.proposedAction,
          expiresAt: proposal.expiresAt,
        });
        break;
      case "ScheduleWake":
        append("schedule", {
          type: "WakeScheduled",
          scheduleId: proposal.scheduleId,
          dueAt: proposal.dueAt,
          purpose: proposal.purpose,
        });
        schedules.push({
          scheduleId: proposal.scheduleId,
          orenId: state.orenId,
          dueAt: proposal.dueAt,
          purpose: proposal.purpose,
        });
        break;
      case "RequestCapability": {
        const effectId = `effect:${trigger.correlationId}:${proposalIndex}`;
        if (triggerKind === "autonomy") {
          append("budget", {
            type: "BudgetConsumed",
            budget: "autonomy",
            amount: 1,
            commitmentId: null,
          });
        } else if (
          triggerKind === "commitment" &&
          proposal.commitmentId !== null
        ) {
          append("budget", {
            type: "BudgetConsumed",
            budget: "commitment",
            amount: 1,
            commitmentId: proposal.commitmentId,
          });
        }
        append("effect", {
          type: "EffectRequested",
          effectId,
          capability: proposal.capability,
          intentId: proposal.intentId,
        });
        effects.push({
          effectId,
          orenId: state.orenId,
          intentId: proposal.intentId,
          capability: proposal.capability,
          arguments: structuredClone(proposal.arguments),
          grantIds: [...grantIds],
          stateVersion: state.version,
          deadline: addSeconds(now, 60),
          idempotencyKey: effectId,
          correlationId: trigger.correlationId,
        });
        break;
      }
    }

    return { events, effects, schedules };
  }

  merge(decisions: CompiledDecision[]): DecisionBatch {
    return {
      events: decisions.flatMap((item) => item.events),
      effects: decisions.flatMap((item) => item.effects),
      schedules: decisions.flatMap((item) => item.schedules),
    };
  }
}
```

Stable IDs derive from the trigger correlation and Proposal index. A `RequestCapability` consumes one Phase 1 budget unit when triggered by autonomy or a commitment; foreground interaction emits no budget-consumption event.

- [ ] **Step 4: Implement `LifeRuntime` as the composition root**

```ts
// packages/app/src/life-runtime.ts
import {
  CapabilityRuntime,
  ExtensionRegistry,
  type Extension,
} from "@oren/capabilities";
import {
  Conductor,
  type CognitionAdapter,
} from "@oren/cognition";
import {
  evaluateProposal,
  LifeActor,
  reduceLifeState,
  type DecisionBatch,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import {
  applyMigrations,
  ChronicleStore,
  GrantStore,
  InboxStore,
  OperationStore,
  OutboxStore,
  rehydrateLifeState,
  ScheduleStore,
  SnapshotStore,
  SqliteDatabase,
} from "@oren/storage";
import { DecisionCompiler } from "./decision-compiler.js";
import { EffectDispatcher } from "./effect-dispatcher.js";
import { Scheduler } from "./scheduler.js";

export interface TestRuntimeOptions {
  orenId: string;
  personId: string;
  initialState: LifeState;
  adapter: CognitionAdapter;
  extensions: Extension[];
  now(): string;
}

interface RuntimePorts {
  actor: LifeActor;
  conductor: Conductor;
  compiler: DecisionCompiler;
  grants: GrantStore;
  registry: ExtensionRegistry;
  dispatcher: EffectDispatcher;
  scheduler: Scheduler;
  inbox: InboxStore;
  chronicle: ChronicleStore;
  snapshots: SnapshotStore;
  stateRef(): LifeState;
  now(): string;
  personId: string;
}

export class LifeRuntime {
  private stepping = false;

  constructor(
    private readonly orenId: string,
    private readonly ports: RuntimePorts,
  ) {}

  enqueueWake(scheduleId: string, purpose: string): void {
    const now = this.ports.now();
    this.ports.inbox.enqueue({
      eventId: `wake:${scheduleId}:${now}`,
      orenId: this.orenId,
      schemaVersion: 1,
      occurredAt: now,
      recordedAt: now,
      source: "test",
      causationId: null,
      correlationId: `schedule:${scheduleId}`,
      payload: { type: "WakeDue", scheduleId, purpose },
    });
  }

  async step(): Promise<boolean> {
    if (this.stepping) throw new Error("LifeRuntime step already running");
    this.stepping = true;
    try {
      const accepted = await this.ports.actor.processOne();
      if (!accepted) return false;

      const trigger = accepted.event.payload.type;
      if (trigger !== "WakeDue" && trigger !== "UserMessageReceived") {
        return true;
      }

      const triggerKind =
        trigger === "UserMessageReceived" ? "interaction" : "autonomy";
      const definitions = this.ports.registry.listDefinitions();
      const { proposals } = await this.ports.conductor.deliberate(
        accepted.state,
        accepted.event,
        definitions.map((definition) => ({
          name: definition.name,
          riskTraits: [...definition.riskTraits],
          constraints: null,
        })),
      );
      const now = this.ports.now();
      const grants = this.ports.grants.active(this.orenId, now);
      const compiled = proposals.flatMap((proposal, proposalIndex) => {
        const decision = evaluateProposal(accepted.state, proposal, {
          now,
          triggerKind,
          episodeStep: proposalIndex + 1,
          grants,
        });
        if (!decision.accepted) return [];
        return [
          this.ports.compiler.compile({
            state: accepted.state,
            trigger: accepted.event,
            proposal,
            proposalIndex,
            grantIds: decision.grantIds,
            triggerKind,
            now,
          }),
        ];
      });
      this.ports.actor.commitDecisions(
        this.ports.compiler.merge(compiled),
      );
      return true;
    } finally {
      this.stepping = false;
    }
  }

  async dispatchEffects(): Promise<void> {
    while (await this.ports.dispatcher.dispatchNext(this.orenId)) {
      // The dispatcher stops when no pending outbox item remains.
    }
  }

  pollSchedules(now: string): number {
    return this.ports.scheduler.poll(now);
  }

  state(): LifeState {
    return structuredClone(this.ports.stateRef());
  }

  rehydrate(): LifeState {
    return rehydrateLifeState(
      this.orenId,
      this.ports.personId,
      this.ports.chronicle,
      this.ports.snapshots,
      reduceLifeState,
    );
  }
}

export function createTestRuntime(
  options: TestRuntimeOptions,
): LifeRuntime {
  const database = new SqliteDatabase(":memory:");
  applyMigrations(database);
  const chronicle = new ChronicleStore(database);
  const snapshots = new SnapshotStore(database);
  const inbox = new InboxStore(database);
  const outbox = new OutboxStore(database);
  const operations = new OperationStore(database);
  const schedules = new ScheduleStore(database);
  const grants = new GrantStore(database);
  let state = structuredClone(options.initialState);
  snapshots.save(options.orenId, state.chronicleCursor, state);

  const actor = new LifeActor({
    loadState: () => state,
    takeNext: () => inbox.nextPending(options.orenId),
    commitInboxEvent: (event) => {
      const sequence = inbox.completeAsEvent(event, chronicle);
      state = reduceLifeState(state, sequence, event);
      snapshots.save(options.orenId, sequence, state);
      return { sequence, event };
    },
    commitDecisionBatch: (batch: DecisionBatch) => {
      const committed = database.transaction(() => {
        const items = batch.events.map((event) => ({
          sequence: chronicle.append(event),
          event,
        }));
        for (const effect of batch.effects) outbox.enqueue(effect);
        for (const schedule of batch.schedules) schedules.put(schedule);
        return items;
      });
      for (const item of committed
        .filter((candidate) => candidate.sequence > state.chronicleCursor)
        .sort((left, right) => left.sequence - right.sequence)) {
        state = reduceLifeState(state, item.sequence, item.event);
      }
      snapshots.save(options.orenId, state.chronicleCursor, state);
      return committed;
    },
  });

  const registry = new ExtensionRegistry();
  for (const extension of options.extensions) {
    registry.register(extension);
  }
  const capabilityRuntime = new CapabilityRuntime(
    registry,
    options.now,
  );
  const dispatcher = new EffectDispatcher(
    database,
    outbox,
    operations,
    inbox,
    capabilityRuntime,
    options.now,
  );
  dispatcher.recoverInterruptedDispatches();
  const scheduler = new Scheduler(schedules, inbox);
  const runtime = new LifeRuntime(options.orenId, {
    actor,
    conductor: new Conductor(options.adapter),
    compiler: new DecisionCompiler(),
    grants,
    registry,
    dispatcher,
    scheduler,
    inbox,
    chronicle,
    snapshots,
    stateRef: () => state,
    now: options.now,
    personId: options.personId,
  });
  return runtime;
}
```

Export `DecisionCompiler`, `LifeRuntime`, and `createTestRuntime` from `packages/app/src/index.ts`. Phase 1 integrates capability-result events into state but does not ask the scripted adapter to deliberate again on a result; the real-model adapter plan adds resumable multi-step episodes.

- [ ] **Step 5: Add a deterministic demo command**

```json
{
  "name": "@oren/app",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@oren/capabilities": "*",
    "@oren/cognition": "*",
    "@oren/kernel": "*",
    "@oren/storage": "*",
    "@oren/test-counter": "*"
  },
  "scripts": {
    "demo": "node --experimental-strip-types src/demo.ts"
  }
}
```

```ts
// packages/app/src/demo.ts
import { ScriptedCognitionAdapter } from "@oren/cognition";
import { CounterExtension } from "@oren/test-counter";
import { createInitialLifeState } from "@oren/kernel";
import { createTestRuntime } from "./life-runtime.js";

const initial = createInitialLifeState("oren-demo", "person-demo");
initial.budgets.autonomyRemaining = 3;
const runtime = createTestRuntime({
  orenId: "oren-demo",
  personId: "person-demo",
  initialState: initial,
  adapter: new ScriptedCognitionAdapter([
    {
      type: "FormIntent",
      intentId: "intent-demo",
      reason: "verify the life-kernel slice",
      proposedAction: "increment the test counter",
      expiresAt: "2099-07-23T00:00:00.000Z",
    },
    {
      type: "RequestCapability",
      intentId: "intent-demo",
      capability: "test.increment",
      arguments: { amount: 1 },
      riskTraits: ["reversible"],
      commitmentId: null,
    },
    {
      type: "ScheduleWake",
      scheduleId: "schedule-next",
      dueAt: "2026-07-24T00:00:00.000Z",
      purpose: "continue the demo thread",
    },
  ]),
  extensions: [new CounterExtension()],
  now: () => "2026-07-23T00:00:00.000Z",
});

runtime.enqueueWake("schedule-first", "start the demo");
await runtime.step();
await runtime.dispatchEffects();
await runtime.step();

const state = runtime.state();
const rehydrated = runtime.rehydrate();
process.stdout.write(
  `${JSON.stringify({
    orenId: state.orenId,
    chronicleCursor: state.chronicleCursor,
    pendingOperations: state.pendingOperationIds.length,
    nextWake: state.schedules[0]?.dueAt ?? null,
    rehydrationMatches:
      JSON.stringify(rehydrated) === JSON.stringify(state),
  })}\n`,
);
```

Run: `npm install`

Expected: PASS and update the workspace lockfile for the demo dependency.

The demo prints one JSON object containing:

```json
{
  "orenId": "oren-demo",
  "chronicleCursor": 6,
  "pendingOperations": 0,
  "nextWake": "2026-07-24T00:00:00.000Z",
  "rehydrationMatches": true
}
```

The cursor is calculated from `runtime.state()`; this scripted slice produces six accepted events.

- [ ] **Step 6: Document Phase 1 commands**

Add this section to `README.md`:

````markdown
## Life kernel development

Requirements: Node.js 24.15 or newer and npm 11.12 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
npm --workspace @oren/app run demo
```

The demo uses a scripted cognition adapter and deterministic test extension.
It performs no network calls and does not represent the production Oren
experience; it verifies event replay, proposal guarding, extension dispatch,
receipts, and scheduled wake recovery.
````

- [ ] **Step 7: Run the vertical-slice checks**

Run: `npm test -- packages/app/test/life-runtime.test.ts`

Expected: PASS; the life slice completes with no pending operation and exact rehydration.

Run: `npm --workspace @oren/app run demo`

Expected: PASS and print JSON with `"rehydrationMatches": true`.

- [ ] **Step 8: Run the complete Phase 1 verification**

Run: `npm test`

Expected: PASS with all workspace tests passing and zero failed tests.

Run: `npm run typecheck`

Expected: PASS with no TypeScript diagnostics.

Run: `npm run build`

Expected: PASS and emit JavaScript and declarations under `dist/`.

- [ ] **Step 9: Commit**

```bash
git add package-lock.json packages/app README.md
git commit -m "feat: complete runnable Oren life-kernel slice"
```

---

## Phase 1 Completion Checklist

- [ ] One Oren’s state is rebuilt from snapshot plus ordered events.
- [ ] Duplicate inbox events and extension receipts do not apply twice.
- [ ] Only `LifeActor` commits accepted state-changing events.
- [ ] The scripted cognition adapter receives a bounded `LifeFrame`.
- [ ] Autonomous budget exhaustion does not affect foreground interaction.
- [ ] Accepted autonomous capability use emits a replayable budget-consumption event.
- [ ] Commitment budgets and Grants remain independent.
- [ ] Extensions receive only typed invocations and cannot mutate `LifeState`.
- [ ] Durable outbox recovery prevents duplicate effects.
- [ ] The scheduler emits one stable wake across repeated polling.
- [ ] End-to-end rehydration equals the current in-memory state.
- [ ] All tests, type checks, build, and demo commands pass.
