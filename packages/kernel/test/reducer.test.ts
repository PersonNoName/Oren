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
