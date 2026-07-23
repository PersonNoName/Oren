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
