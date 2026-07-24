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

  it("records one autonomy reservation by durable episode identity", () => {
    const initial = {
      ...createInitialLifeState("oren-1", "person-1"),
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    };
    const consumed = envelope({
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 0,
      amount: 3,
    });

    expect(reduceLifeState(initial, consumed)).toMatchObject({
      budgets: { autonomyRemaining: 2 },
      autonomyReservations: {
        "episode-1": {
          amount: 3,
          baseStateVersion: 0,
          correlationId: "corr-1",
        },
      },
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 6])(
    "rejects hostile autonomy amount %s without mutating state",
    (amount) => {
      const initial = {
        ...createInitialLifeState("oren-1", "person-1"),
        budgets: {
          autonomyRemaining: 5,
          interactionMaxSteps: 8,
          commitmentRemaining: {},
        },
      };

      expect(() => reduceLifeState(initial, envelope({
        type: "AutonomyConsumed",
        episodeId: "episode-1",
        baseStateVersion: 0,
        amount,
      }))).toThrow(/autonomy/i);
      expect(initial.budgets.autonomyRemaining).toBe(5);
    },
  );

  it("rejects a duplicate autonomy event for an already reserved episode", () => {
    const initial = {
      ...createInitialLifeState("oren-1", "person-1"),
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    };
    const first = reduceLifeState(initial, envelope({
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 0,
      amount: 2,
    }));

    expect(() => reduceLifeState(first, envelope({
      type: "AutonomyConsumed",
      episodeId: "episode-1",
      baseStateVersion: 1,
      amount: 2,
    }))).toThrow(/already reserved/i);
  });
});

function envelope(payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    eventId: "event-1",
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt: "2026-07-23T00:00:00.000Z",
    recordedAt: "2026-07-23T00:00:00.000Z",
    source: "test",
    causationId: null,
    correlationId: "corr-1",
    payload,
  };
}
