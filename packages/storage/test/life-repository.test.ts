import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  reduceLifeState,
  type Effect,
  type EventEnvelope,
  type Grant,
} from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("SqliteLifeRepository", () => {
  it("initializes identity and its required grant atomically and idempotently", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const initial = createInitialLifeState("oren-1", "person-1");
    const grant: Grant = {
      grantId: "runtime:oren-1:test-counter",
      capabilityPattern: "test.*",
      expiresAt: "9999-12-31T23:59:59.999Z",
      revoked: false,
    };

    repo.initializeWithGrant(initial, grant);
    repo.initializeWithGrant(initial, grant);

    expect(repo.listLifeIdentities()).toEqual([
      { orenId: "oren-1", personId: "person-1" },
    ]);
    expect(repo.loadGrants("oren-1")).toEqual([grant]);
  });

  it("rolls back identity initialization when the required grant conflicts", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const grant: Grant = {
      grantId: "runtime:oren-1:test-counter",
      capabilityPattern: "other.*",
      expiresAt: "9999-12-31T23:59:59.999Z",
      revoked: false,
    };
    repo.putGrant("oren-1", grant);

    expect(() => repo.initializeWithGrant(
      createInitialLifeState("oren-1", "person-1"),
      { ...grant, capabilityPattern: "test.*" },
    )).toThrow(/grant|conflict/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM snapshots").get()).toEqual({ count: 0 });
  });

  it("reconstructs pending cognition by exact correlation and base version identity", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    repo.commit("oren-1", [
      event("request-a", "oren-1", {
        type: "CognitionRequested",
        episodeId: "shared-episode",
        baseStateVersion: 1,
        triggerKind: "foreground_user",
      }, "corr-a"),
      event("request-b", "oren-1", {
        type: "CognitionRequested",
        episodeId: "shared-episode",
        baseStateVersion: 2,
        triggerKind: "foreground_user",
      }, "corr-b"),
      event("terminal-b", "oren-1", {
        type: "CognitionDenied",
        episodeId: "shared-episode",
        reason: "test terminal",
      }, "corr-b"),
    ]);

    expect(repo.loadPendingCognitionJobs()).toEqual([{
      orenId: "oren-1",
      episodeId: "shared-episode",
      baseStateVersion: 1,
      triggerKind: "foreground_user",
      correlationId: "corr-a",
    }]);
  });

  it("does not let a mismatched completed base version close a pending request", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    repo.commit("oren-1", [
      event("request", "oren-1", {
        type: "CognitionRequested",
        episodeId: "episode-1",
        baseStateVersion: 1,
        triggerKind: "foreground_user",
      }, "corr-1"),
      event("wrong-terminal", "oren-1", {
        type: "CognitionCompleted",
        episodeId: "episode-1",
        baseStateVersion: 99,
        proposals: [],
      }, "corr-1"),
    ]);

    expect(repo.loadPendingCognitionJobs()).toHaveLength(1);
  });

  it("closes a pending request with a new completion after intermediate episode facts", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    repo.commit("oren-1", [
      event("request", "oren-1", {
        type: "CognitionRequested",
        episodeId: "episode-1",
        baseStateVersion: 1,
        triggerKind: "foreground_user",
      }, "corr-1"),
      event("message", "oren-1", {
        type: "AssistantMessageDelivered",
        episodeId: "episode-1",
        messageId: "message-1",
        text: "hello",
        channel: "panel",
        status: "complete",
      }, "corr-1"),
      event("completion", "oren-1", {
        type: "CognitionCompleted",
        episodeId: "episode-1",
        baseStateVersion: 3,
        reason: "stop",
        usage: { totalTokens: 5 },
      }, "corr-1"),
    ]);

    expect(repo.loadPendingCognitionJobs()).toEqual([]);
  });

  it("continues exact pending reconstruction past malformed legacy history", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    repo.commit("oren-1", [
      event("request", "oren-1", {
        type: "CognitionRequested",
        episodeId: "episode-1",
        baseStateVersion: 1,
        triggerKind: "foreground_user",
      }),
    ]);
    db.prepare(`
      INSERT INTO events(event_id, oren_id, recorded_at, envelope_json)
      VALUES (?, ?, ?, ?)
    `).run("malformed", "oren-1", "2026-07-23T00:00:00.000Z", "{not-json");

    expect(repo.loadPendingCognitionJobs()).toEqual([{
      orenId: "oren-1",
      episodeId: "episode-1",
      baseStateVersion: 1,
      triggerKind: "foreground_user",
      correlationId: "corr-1",
    }]);
  });

  it("rejects an invalid initial state budget before snapshot persistence", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const initial = createInitialLifeState("oren-1", "person-1");

    expect(() => repo.initialize({
      ...initial,
      budgets: { ...initial.budgets, autonomyRemaining: -1 },
    })).toThrow(/budget/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM snapshots").get()).toEqual({ count: 0 });
  });

  it("consumes an autonomy event once with a durable state-version compare-and-swap", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize({
      ...createInitialLifeState("oren-1", "person-1"),
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    const consumed = event("event-1", "oren-1", {
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 0,
      amount: 3,
    });

    expect(repo.commitIfVersion("oren-1", 0, [consumed])).toBe(true);
    expect(repo.commitIfVersion("oren-1", 0, [{
      ...consumed,
      eventId: "event-2",
    }])).toBe(false);
    expect(repo.rehydrate("oren-1")).toMatchObject({
      version: 1,
      budgets: { autonomyRemaining: 2 },
    });
  });

  it("rejects a second autonomy charge for the same episode at the current version", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize({
      ...createInitialLifeState("oren-1", "person-1"),
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    repo.commitIfVersion("oren-1", 0, [event("event-1", "oren-1", {
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 0,
      amount: 2,
    })]);

    expect(() => repo.commitIfVersion("oren-1", 1, [event("event-2", "oren-1", {
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 1,
      amount: 2,
    })])).toThrow(/already reserved|unique/i);
    expect(repo.rehydrate("oren-1")).toMatchObject({
      version: 1,
      budgets: { autonomyRemaining: 3 },
    });
    expect(repo.loadEvents("oren-1")).toHaveLength(1);
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 6])(
    "atomically rejects hostile autonomy amount %s on public commit paths",
    (amount) => {
      const db = openDatabase(":memory:");
      const repo = new SqliteLifeRepository(db);
      repo.initialize({
        ...createInitialLifeState("oren-1", "person-1"),
        budgets: {
          autonomyRemaining: 5,
          interactionMaxSteps: 8,
          commitmentRemaining: {},
        },
      });
      const hostile = event("hostile", "oren-1", {
        type: "AutonomyConsumed",
        episodeId: "episode-hostile",
        baseStateVersion: 0,
        amount,
      });

      expect(() => repo.commit("oren-1", [hostile])).toThrow();
      expect(repo.loadEvents("oren-1")).toEqual([]);
      expect(repo.rehydrate("oren-1").budgets.autonomyRemaining).toBe(5);
    },
  );

  it.each([
    { name: "unknown event type", payload: { type: "FutureEvent", value: 1 } },
    {
      name: "extra event property",
      payload: { type: "CognitionDenied", episodeId: "episode-1", reason: "no", extra: true },
    },
    {
      name: "malformed known event",
      payload: { type: "CognitionCompleted", episodeId: "episode-1", baseStateVersion: 0, proposals: "no" },
    },
  ])("atomically rejects an exact-variant violation: $name", ({ payload }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));

    expect(() => repo.commit("oren-1", [
      event("valid", "oren-1", { type: "OrenInitialized", personId: "person-1" }),
      event("hostile", "oren-1", payload as unknown as EventEnvelope["payload"]),
    ])).toThrow(/event|payload/i);
    expect(repo.loadEvents("oren-1")).toEqual([]);
  });

  it("normalizes valid offset WakeScheduled instants and rejects invalid timestamps", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));

    repo.commit("oren-1", [event("schedule", "oren-1", {
      type: "WakeScheduled",
      scheduleId: "schedule-1",
      at: "2026-07-24T08:00:00+08:00",
      purpose: "reflect",
    })]);
    expect(db.prepare("SELECT due_at FROM schedules WHERE schedule_id = ?").get("schedule-1"))
      .toEqual({ due_at: "2026-07-24T00:00:00.000Z" });
    expect(() => repo.commit("oren-1", [event("invalid", "oren-1", {
      type: "WakeScheduled",
      scheduleId: "schedule-2",
      at: "zzzz",
      purpose: "never",
    })])).toThrow(/timestamp|instant/i);
    expect(() => repo.commit("oren-1", [event("invalid-calendar", "oren-1", {
      type: "WakeScheduled",
      scheduleId: "schedule-3",
      at: "2026-02-30T00:00:00.000Z",
      purpose: "never",
    })])).toThrow(/timestamp|instant/i);
    expect(repo.loadEvents("oren-1")).toHaveLength(1);
  });

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

  it("rehydrates only events after the durable snapshot cursor", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const initial = createInitialLifeState("oren-1", "person-1");
    repo.initialize(initial);
    const firstEvent = event("event-1", "oren-1", {
      type: "DispositionUpdated",
      disposition: "reflective",
      reason: "snapshot test",
    });
    const secondEvent = event("event-2", "oren-1", {
      type: "ThreadAdvanced",
      threadId: "thread-1",
      summary: "resume after compaction",
    });
    repo.appendAndEnqueueEffects("oren-1", [firstEvent, secondEvent], []);

    const compactedSnapshot = reduceLifeState(initial, firstEvent);
    db.prepare(`
      UPDATE snapshots SET version = ?, cursor = ?, state_json = ? WHERE oren_id = ?
    `).run(
      compactedSnapshot.version,
      compactedSnapshot.chronicleCursor,
      JSON.stringify(compactedSnapshot),
      "oren-1",
    );

    expect(repo.rehydrate("oren-1")).toEqual(reduceLifeState(compactedSnapshot, secondEvent));
  });

  it("rehydrates a compacted Oren by its per-Oren event cursor when events are interleaved", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const initial = createInitialLifeState("oren-a", "person-a");
    repo.initialize(initial);
    repo.initialize(createInitialLifeState("oren-b", "person-b"));
    const orenBFirst = event("event-b-1", "oren-b", {
      type: "DispositionUpdated",
      disposition: "alert",
      reason: "interleaved before oren-a",
    });
    const orenAFirst = event("event-a-1", "oren-a", {
      type: "DispositionUpdated",
      disposition: "reflective",
      reason: "covered by snapshot",
    });
    const orenBSecond = event("event-b-2", "oren-b", {
      type: "ThreadAdvanced",
      threadId: "thread-b",
      summary: "interleaved after oren-a snapshot event",
    });
    const orenASecond = event("event-a-2", "oren-a", {
      type: "ThreadAdvanced",
      threadId: "thread-a",
      summary: "must replay once",
    });
    repo.appendAndEnqueueEffects("oren-b", [orenBFirst], []);
    repo.appendAndEnqueueEffects("oren-a", [orenAFirst], []);
    repo.appendAndEnqueueEffects("oren-b", [orenBSecond], []);
    repo.appendAndEnqueueEffects("oren-a", [orenASecond], []);

    const compactedSnapshot = reduceLifeState(initial, orenAFirst);
    db.prepare(`
      UPDATE snapshots SET version = ?, cursor = ?, state_json = ? WHERE oren_id = ?
    `).run(
      compactedSnapshot.version,
      compactedSnapshot.chronicleCursor,
      JSON.stringify(compactedSnapshot),
      "oren-a",
    );

    expect(repo.rehydrate("oren-a")).toEqual(reduceLifeState(compactedSnapshot, orenASecond));
  });

  it.each([
    {
      name: "an event owned by another Oren",
      events: [
        event("event-valid", "oren-1", { type: "OrenInitialized", personId: "person-1" }),
        event("event-1", "oren-2", { type: "OrenInitialized", personId: "person-1" }),
      ],
      effects: [],
    },
    {
      name: "an EffectRequested payload with another Oren's effect",
      events: [
        event("event-valid", "oren-1", { type: "OrenInitialized", personId: "person-1" }),
        event("event-1", "oren-1", {
          type: "EffectRequested",
          effect: effect("effect-1", "oren-2"),
        }),
      ],
      effects: [],
    },
    {
      name: "an effect owned by another Oren",
      events: [event("event-valid", "oren-1", { type: "OrenInitialized", personId: "person-1" })],
      effects: [effect("effect-1", "oren-2")],
    },
  ])("rejects $name before writing the batch", ({ events, effects }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);

    expect(() => repo.appendAndEnqueueEffects("oren-1", events, effects)).toThrow(/orenId/);
    expect(repo.loadEvents("oren-1")).toEqual([]);
    expect(repo.claimOutbox("worker-1", 10)).toEqual([]);
  });

  it("rejects an EffectRequested payload without its nested effect before writing the batch", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const malformedEvent = event("event-1", "oren-1", {
      type: "EffectRequested",
    } as unknown as EventEnvelope["payload"]);

    expect(() => repo.appendAndEnqueueEffects("oren-1", [malformedEvent], [])).toThrow(
      "EffectRequested event event-1 has a mismatched orenId",
    );
    expect(repo.loadEvents("oren-1")).toEqual([]);
  });

  it("rolls back a raw effect when its operation insert conflicts", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO operations(effect_id, oren_id, capability, status)
      VALUES (?, ?, ?, 'pending')
    `).run("effect-1", "oren-1", "test.increment");

    expect(() => repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 })).toThrow();
    expect(repo.claimOutbox("worker-1", 1)).toEqual([]);
  });

  it("does not allow a grant identity to be reassigned to another Oren", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    const grant: Grant = {
      grantId: "grant-1",
      capabilityPattern: "test.*",
      expiresAt: "2026-08-01T00:00:00.000Z",
      revoked: false,
    };

    repo.putGrant("oren-1", grant);

    expect(() => repo.putGrant("oren-2", { ...grant, capabilityPattern: "other.*" })).toThrow(
      "Grant grant-1 already belongs to oren-1",
    );
    expect(repo.loadGrants("oren-1")).toEqual([grant]);
    expect(repo.loadGrants("oren-2")).toEqual([]);
  });

  it("revokeGrant sets revoked_at and excludes grant from loadGrants", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db, () => "2026-07-26T12:00:00.000Z");
    const grant: Grant = {
      grantId: "grant-1",
      capabilityPattern: "test.*",
      expiresAt: "2026-08-01T00:00:00.000Z",
      revoked: false,
    };
    repo.putGrant("oren-1", grant);

    expect(repo.revokeGrant("oren-1", "grant-1", "2026-07-26T12:00:00.000Z")).toBe(true);
    expect(repo.loadGrants("oren-1")).toEqual([]);
    expect(db.prepare("SELECT revoked_at FROM grants WHERE grant_id = ?").get("grant-1"))
      .toEqual({ revoked_at: "2026-07-26T12:00:00.000Z" });

    expect(repo.revokeGrant("oren-1", "grant-1", "2026-07-26T13:00:00.000Z")).toBe(false);
    expect(repo.revokeGrant("oren-1", "missing-grant", "2026-07-26T12:00:00.000Z")).toBe(false);
  });
});

function event(
  eventId: string,
  orenId: string,
  payload: EventEnvelope["payload"],
  correlationId = "corr-1",
): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt: "2026-07-23T00:00:00.000Z",
    recordedAt: "2026-07-23T00:00:00.000Z",
    source: "life-actor",
    causationId: null,
    correlationId,
    payload,
  };
}

function effect(effectId: string, orenId: string): Effect {
  return {
    effectId,
    orenId,
    correlationId: "corr-1",
    capability: "test.increment",
    arguments: { by: 1 },
    grantIds: [],
    stateVersion: 0,
  };
}
