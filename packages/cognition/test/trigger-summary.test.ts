import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@oren/kernel";
import {
  formatEffectResultSummary,
  resolveTriggerSummary,
} from "../src/trigger-summary.js";

function envelope(
  correlationId: string,
  payload: EventEnvelope["payload"],
  eventId = "e1",
): EventEnvelope {
  return {
    eventId,
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt: "2026-07-26T00:00:00.000Z",
    recordedAt: "2026-07-26T00:00:00.000Z",
    source: "test",
    causationId: null,
    correlationId,
    payload,
  };
}

describe("formatEffectResultSummary", () => {
  it("formats a completed effect with receipt", () => {
    expect(formatEffectResultSummary({
      capability: "test.increment",
      effectId: "effect-1",
      status: "completed",
      receipt: { value: 1 },
    })).toBe("test.increment 完成（effectId=effect-1，回执={\"value\":1}）。");
  });
});

describe("resolveTriggerSummary", () => {
  it("uses the user message text for foreground_user", () => {
    const summary = resolveTriggerSummary({
      triggerKind: "foreground_user",
      correlationId: "corr-1",
      events: [
        envelope("corr-1", {
          type: "UserMessageReceived",
          personId: "p1",
          text: "请把计数器加一",
        }),
      ],
    });
    expect(summary).toBe("请把计数器加一");
  });

  it("formats effect_result from EffectRequested + EffectCompleted", () => {
    const summary = resolveTriggerSummary({
      triggerKind: "effect_result",
      correlationId: "corr-1",
      events: [
        envelope("corr-1", {
          type: "EffectRequested",
          effect: {
            effectId: "effect-1",
            orenId: "oren-1",
            correlationId: "corr-1",
            capability: "test.increment",
            arguments: { by: 1 },
            grantIds: [],
            stateVersion: 1,
          },
        }, "req"),
        envelope("corr-1", {
          type: "EffectCompleted",
          effectId: "effect-1",
          receipt: { value: 2 },
        }, "done"),
      ],
    });
    expect(summary).toContain("test.increment 完成");
    expect(summary).toContain("effect-1");
    expect(summary).toContain("\"value\":2");
  });

  it("uses WakeDue purpose for scheduled_wake", () => {
    const summary = resolveTriggerSummary({
      triggerKind: "scheduled_wake",
      correlationId: "corr-wake",
      events: [
        envelope("corr-wake", {
          type: "WakeDue",
          scheduleId: "wake-1",
          purpose: "Revisit the counter",
        }),
      ],
    });
    expect(summary).toBe("Revisit the counter");
  });

  it("falls back to correlationId when source events are missing", () => {
    expect(resolveTriggerSummary({
      triggerKind: "foreground_user",
      correlationId: "corr-missing",
      events: [],
    })).toBe("corr-missing");
  });
});
