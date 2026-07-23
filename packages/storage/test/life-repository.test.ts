import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  reduceLifeState,
  type Effect,
  type EventEnvelope,
} from "@oren/kernel";
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
});

function event(eventId: string, orenId: string, payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt: "2026-07-23T00:00:00.000Z",
    recordedAt: "2026-07-23T00:00:00.000Z",
    source: "life-actor",
    causationId: null,
    correlationId: "corr-1",
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
