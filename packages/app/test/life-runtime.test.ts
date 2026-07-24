import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScriptedCognitionAdapter,
  type CognitionPort,
} from "@oren/cognition";
import type { OrenExtension } from "@oren/extensions";
import {
  createInitialLifeState,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import { PiCognitionAdapter } from "@oren/pi-cognition";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  createMockModel,
  createSequenceStream,
} from "../../pi-cognition/test/fixtures.js";
import { LifeRuntime, type LifeRuntimeOptions } from "../src/index.js";

const TEST_NOW = "2026-07-25T00:00:00.000Z";
const FUTURE_WAKE = "2099-01-02T00:00:00.000Z";

function databasePath(prefix = "oren-runtime-"): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "life.db");
}

function sequenceIds(prefix = "id"): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function options(
  overrides: Partial<LifeRuntimeOptions> = {},
): LifeRuntimeOptions {
  return {
    now: () => TEST_NOW,
    nextId: sequenceIds(),
    ...overrides,
  };
}

function envelope(
  eventId: string,
  orenId: string,
  correlationId: string,
  payload: EventEnvelope["payload"],
): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt: TEST_NOW,
    recordedAt: TEST_NOW,
    source: "life-runtime-test",
    causationId: null,
    correlationId,
    payload,
  };
}

function stateWithAutonomy(
  orenId = "oren-1",
  personId = "person-1",
): LifeState {
  return {
    ...createInitialLifeState(orenId, personId),
    budgets: {
      autonomyRemaining: 32,
      interactionMaxSteps: 8,
      commitmentRemaining: {},
    },
  };
}

function queryableCounterFactory(
  receipts: Map<string, { readonly value: number }>,
  lifecycle?: { activated: number; deactivated: number },
): () => OrenExtension {
  return () => {
    let value = 0;
    return {
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
            timeoutMs: 1_000,
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
            timeoutMs: 1_000,
          },
        ],
      },
      async activate() {
        if (lifecycle) lifecycle.activated += 1;
      },
      async deactivate() {
        if (lifecycle) lifecycle.deactivated += 1;
      },
      async invoke(invocation) {
        if (invocation.capability === "test.read") {
          return { status: "completed", output: value, receipt: { observed: true } };
        }
        value += Number(invocation.arguments.by);
        const receipt = { value };
        receipts.set(invocation.effectId, receipt);
        return { status: "completed", output: value, receipt };
      },
      async query(effectId) {
        const receipt = receipts.get(effectId);
        return receipt
          ? { status: "completed", output: receipt.value, receipt }
          : { status: "uncertain", message: "No durable counter receipt" };
      },
    };
  };
}

describe("LifeRuntime restart slice", () => {
  it("recovers a pending first-attempt effect and replays exactly after restart", async () => {
    const path = databasePath();
    const nextId = sequenceIds("restart");
    const first = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Think about the counter");
    expect(first.inspect("oren-1").pendingEffectIds).toHaveLength(1);
    await first.close();

    const second = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await second.drain();
    const beforeRestart = second.inspect("oren-1");
    expect(beforeRestart.pendingEffectIds).toEqual([]);
    expect(beforeRestart.attention.currentFocus).toContain("counter");
    expect(beforeRestart.schedules).toEqual(["counter-follow-up"]);
    await second.close();

    const third = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await third.drain();
    expect(third.inspect("oren-1")).toEqual(beforeRestart);
    await third.close();
  });

  it("reconciles a reclaimed dispatched effect through query after restart", async () => {
    const path = databasePath("oren-query-runtime-");
    const receipts = new Map<string, { readonly value: number }>();
    const extensionFactory = queryableCounterFactory(receipts);
    const nextId = sequenceIds("query");
    const first = await LifeRuntime.createDeterministic(
      path,
      options({ nextId, extensionFactory }),
    );
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Increment once");
    await first.close();

    const repository = new SqliteLifeRepository(
      openDatabase(path),
      () => TEST_NOW,
      sequenceIds("lease"),
    );
    const claimed = repository.claimOutbox("crashed-dispatcher", 1, TEST_NOW);
    const effect = claimed[0]!;
    receipts.set(effect.effectId, { value: 1 });
    repository.close();

    const reclaimedAt = "2026-07-25T00:01:01.000Z";
    const second = await LifeRuntime.createDeterministic(path, options({
      nextId,
      now: () => reclaimedAt,
      extensionFactory,
    }));
    await second.drain();
    expect(second.inspect("oren-1").pendingEffectIds).toEqual([]);
    expect(second.inspect("oren-1").attention.currentFocus).toContain("counter");
    await second.close();
  });

  it("marks a reclaimed dispatched effect uncertain when query is unavailable", async () => {
    const path = databasePath("oren-no-query-runtime-");
    const nextId = sequenceIds("no-query");
    const first = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Increment once");
    await first.close();

    const repository = new SqliteLifeRepository(
      openDatabase(path),
      () => TEST_NOW,
      sequenceIds("lease"),
    );
    repository.claimOutbox("crashed-dispatcher", 1, TEST_NOW);
    repository.close();

    const second = await LifeRuntime.createDeterministic(path, options({
      nextId,
      now: () => "2026-07-25T00:01:01.000Z",
    }));
    await second.drain();
    expect(second.inspect("oren-1").pendingEffectIds).toEqual([]);
    await second.close();

    const audit = new SqliteLifeRepository(openDatabase(path));
    expect(audit.loadEvents("oren-1").some(
      ({ payload }) => payload.type === "EffectUncertain",
    )).toBe(true);
    audit.close();
  });

  it("resumes a pending durable Inbox effect result without dispatching again", async () => {
    const path = databasePath("oren-inbox-runtime-");
    const nextId = sequenceIds("inbox");
    const first = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Increment once");
    await first.close();

    const repository = new SqliteLifeRepository(
      openDatabase(path),
      () => TEST_NOW,
      sequenceIds("lease"),
    );
    const effect = repository.claimOutbox("crashed-dispatcher", 1, TEST_NOW)[0]!;
    repository.finishEffect(
      effect.effectId,
      effect.orenId,
      effect.effect.correlationId,
      {
        type: "EffectCompleted",
        effectId: effect.effectId,
        receipt: { value: 1 },
      },
    );
    repository.close();

    const second = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await second.drain();
    expect(second.inspect("oren-1")).toMatchObject({
      pendingEffectIds: [],
      attention: { currentFocus: "Understand the counter lifecycle" },
    });
    await second.close();
  });

  it("recovers the original cognition job after its autonomy reservation", async () => {
    const path = databasePath("oren-autonomy-runtime-");
    const repository = new SqliteLifeRepository(openDatabase(path), () => TEST_NOW);
    repository.initialize(stateWithAutonomy());
    repository.commit("oren-1", [
      envelope("request", "oren-1", "corr-autonomy", {
        type: "CognitionRequested",
        episodeId: "episode-autonomy",
        baseStateVersion: 1,
        triggerKind: "scheduled_wake",
      }),
    ]);
    repository.commitIfVersion("oren-1", 1, [
      envelope("reservation", "oren-1", "corr-autonomy", {
        type: "AutonomyConsumed",
        episodeId: "episode-autonomy",
        baseStateVersion: 1,
        amount: 8,
      }),
    ]);
    repository.close();

    const seenVersions: number[] = [];
    const cognition = new ScriptedCognitionAdapter(async (frame) => {
      seenVersions.push(frame.stateVersion);
      return {
        kind: "completed",
        proposals: [{
          type: "AdvanceThread",
          threadId: "recovered",
          summary: "Recovered reserved autonomy",
        }],
        usage: { totalTokens: 0 },
      };
    });
    const runtime = await LifeRuntime.create(path, cognition, options());
    await runtime.drain();
    expect(seenVersions).toEqual([2]);
    expect(runtime.inspect("oren-1").attention.currentFocus).toBe(
      "Recovered reserved autonomy",
    );
    await runtime.close();
  });

  it("delivers a due schedule after reopen and processes its new episode", async () => {
    const path = databasePath("oren-schedule-runtime-");
    const repository = new SqliteLifeRepository(openDatabase(path), () => TEST_NOW);
    repository.initialize(stateWithAutonomy());
    repository.commit("oren-1", [
      envelope("schedule", "oren-1", "corr-schedule", {
        type: "WakeScheduled",
        scheduleId: "due-on-restart",
        at: TEST_NOW,
        purpose: "Verify durable wake",
      }),
    ]);
    repository.close();

    const triggers: string[] = [];
    const cognition = new ScriptedCognitionAdapter(async (frame) => {
      triggers.push(frame.trigger.kind);
      return {
        kind: "completed",
        proposals: [{ type: "NoAction", reason: "Wake observed" }],
        usage: { totalTokens: 0 },
      };
    });
    const runtime = await LifeRuntime.create(path, cognition, options());
    await runtime.drain();
    expect(triggers).toEqual(["scheduled_wake"]);
    await runtime.close();
  });

  it("runs the same durable gates through Pi fake streams without a network", async () => {
    const path = databasePath("oren-pi-runtime-");
    const nextId = sequenceIds("pi");
    const streamFn = createSequenceStream([
      assistantMessage([{
        type: "toolCall",
        id: "read-1",
        name: "test.read",
        arguments: {},
      }]),
      assistantMessage([{
        type: "toolCall",
        id: "increment-1",
        name: "test.increment",
        arguments: { by: 1 },
      }]),
      assistantMessage([{
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
              at: FUTURE_WAKE,
              purpose: "Revisit the counter",
            },
          ],
        },
      }]),
    ]);
    const pi = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn,
      messageTimestamp: () => 1_700_000_000_000,
    });
    const first = await LifeRuntime.create(path, pi, options({ nextId }));
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage(
      "oren-1",
      "person-1",
      "Inspect and increment the counter",
    );
    await first.close();

    const second = await LifeRuntime.create(path, pi, options({ nextId }));
    await second.drain();
    const completed = second.inspect("oren-1");
    expect(completed).toMatchObject({
      pendingEffectIds: [],
      attention: { currentFocus: "Pi completed the counter lifecycle" },
      schedules: ["counter-follow-up"],
    });
    await second.close();

    const noMorePi: CognitionPort = {
      async run() {
        throw new Error("A durable replay must not need a Pi stream");
      },
    };
    const third = await LifeRuntime.create(path, noMorePi, options({ nextId }));
    await third.drain();
    expect(third.inspect("oren-1")).toEqual(completed);
    await third.close();
  });
});

describe("LifeRuntime fixed-point and lifecycle", () => {
  it("initializes an empty database idempotently and rejects identity conflicts", async () => {
    const runtime = await LifeRuntime.createDeterministic(databasePath(), options());
    await runtime.initialize("oren-1", "person-1");
    await runtime.initialize("oren-1", "person-1");
    await expect(runtime.initialize("oren-1", "person-2")).rejects.toThrow(/identity/i);
    await expect(runtime.initialize("oren-2", "person-1")).rejects.toThrow(/identity/i);
    await runtime.close();
  });

  it("drains newly-created durable work across multiple waves and then stays stable", async () => {
    const runtime = await LifeRuntime.createDeterministic(databasePath(), options());
    await runtime.initialize("oren-1", "person-1");
    await runtime.receiveUserMessage("oren-1", "person-1", "Increment once");
    await runtime.drain();
    const settled = runtime.inspect("oren-1");
    expect(settled.pendingEffectIds).toEqual([]);
    expect(settled.attention.currentFocus).toContain("counter");
    await runtime.drain();
    expect(runtime.inspect("oren-1")).toEqual(settled);
    await runtime.close();
  });

  it("quarantines a bad Inbox row without starving later valid work", async () => {
    const path = databasePath("oren-quarantine-runtime-");
    const nextId = sequenceIds("quarantine");
    const first = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "Increment once");
    await first.close();

    const db = openDatabase(path);
    db.prepare(`
      INSERT INTO inbox(inbox_id, oren_id, priority, available_at, payload_json)
      VALUES (?, ?, 9, ?, ?)
    `).run(
      "orphan-inbox",
      "missing-oren",
      TEST_NOW,
      JSON.stringify({
        correlationId: "orphan",
        event: {
          type: "WakeDue",
          scheduleId: "orphan",
          purpose: "No snapshot exists",
        },
      }),
    );
    db.close();

    const second = await LifeRuntime.createDeterministic(path, options({ nextId }));
    await second.drain();
    expect(second.inspect("oren-1").pendingEffectIds).toEqual([]);
    await second.close();

    const audit = openDatabase(path);
    expect(audit.prepare(`
      SELECT reason FROM inbox_quarantine WHERE inbox_id = ?
    `).get("orphan-inbox")).toBeDefined();
    audit.close();
  });

  it("surfaces bounded non-quiescence when immediate effects keep spawning", async () => {
    const looping = new ScriptedCognitionAdapter(async (frame, capabilityPort, signal) => {
      const increment = frame.capabilities.find(({ name }) => name === "test.increment")!;
      const result = await capabilityPort.invoke({
        orenId: frame.orenId,
        descriptor: increment,
        arguments: { by: 1 },
        stateVersion: frame.stateVersion,
        correlationId: frame.correlationId,
      }, signal);
      return result.kind === "waiting_for_effect"
        ? { ...result, usage: { totalTokens: 0 } }
        : {
            kind: "failed",
            message: "Expected a persistent effect",
            usage: { totalTokens: 0 },
          };
    });
    const runtime = await LifeRuntime.create(
      databasePath("oren-cap-runtime-"),
      looping,
      options({ maxDrainCycles: 2 }),
    );
    await runtime.initialize("oren-1", "person-1");
    await runtime.receiveUserMessage("oren-1", "person-1", "Loop effects");
    await expect(runtime.drain()).rejects.toThrow(/quiesce|cycle/i);
    await runtime.close();
  });

  it("owns a fresh extension instance and closes lifecycle resources once", async () => {
    const lifecycle = { activated: 0, deactivated: 0 };
    const observed: number[] = [];
    const cognition = new ScriptedCognitionAdapter(async (frame, capabilityPort, signal) => {
      const read = frame.capabilities.find(({ name }) => name === "test.read")!;
      const result = await capabilityPort.invoke({
        orenId: frame.orenId,
        descriptor: read,
        arguments: {},
        stateVersion: frame.stateVersion,
        correlationId: frame.correlationId,
      }, signal);
      if (result.kind === "completed") observed.push(Number(result.output));
      return {
        kind: "completed",
        proposals: [{ type: "NoAction", reason: "Read complete" }],
        usage: { totalTokens: 0 },
      };
    });
    const extensionFactory = queryableCounterFactory(new Map(), lifecycle);
    for (const suffix of ["a", "b"]) {
      const runtime = await LifeRuntime.create(
        databasePath(`oren-fresh-${suffix}-`),
        cognition,
        options({ extensionFactory }),
      );
      await runtime.initialize(`oren-${suffix}`, `person-${suffix}`);
      await runtime.receiveUserMessage(`oren-${suffix}`, `person-${suffix}`, "Read");
      await runtime.close();
      await runtime.close();
      expect(() => runtime.inspect(`oren-${suffix}`)).toThrow(/closed/i);
      await expect(runtime.drain()).rejects.toThrow(/closed/i);
    }
    expect(observed).toEqual([0, 0]);
    expect(lifecycle).toEqual({ activated: 2, deactivated: 2 });
  });
});
