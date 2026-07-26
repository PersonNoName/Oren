import { describe, expect, it } from "vitest";
import { assertVerticalSliceEpisodes, type EpisodeRecord } from "../src/smoke-runner.js";

const FUTURE = "2999-01-01T00:00:00.000Z";

function episode(
  partial: Partial<EpisodeRecord> & Pick<EpisodeRecord, "trigger" | "kind">,
): EpisodeRecord {
  return {
    proposals: [],
    totalTokens: 1,
    ...partial,
  };
}

describe("assertVerticalSliceEpisodes", () => {
  it("accepts a single waiting then completed with ScheduleWake and Remember", () => {
    const failures = assertVerticalSliceEpisodes([
      episode({
        trigger: "foreground_user",
        kind: "waiting_for_effect",
      }),
      episode({
        trigger: "effect_result",
        kind: "completed",
        proposals: [
          {
            type: "Remember",
            text: "判断：计数器用于验证",
            kind: "oren_judgment",
            confidence: 0.7,
          },
          {
            type: "ScheduleWake",
            scheduleId: "w1",
            at: FUTURE,
            purpose: "follow up",
          },
        ],
      }),
    ]);
    expect(failures).toEqual([]);
  });

  it("rejects effect_result waiting loops and missing judgment", () => {
    const failures = assertVerticalSliceEpisodes([
      episode({ trigger: "foreground_user", kind: "waiting_for_effect" }),
      episode({ trigger: "effect_result", kind: "waiting_for_effect" }),
      episode({
        trigger: "effect_result",
        kind: "completed",
        proposals: [
          {
            type: "ScheduleWake",
            scheduleId: "w1",
            at: FUTURE,
            purpose: "follow up",
          },
        ],
      }),
    ]);
    expect(failures.some((line) => line.includes("at most one waiting_for_effect"))).toBe(true);
    expect(failures.some((line) => line.includes("must not re-invoke"))).toBe(true);
    expect(failures.some((line) => line.includes("oren_judgment"))).toBe(true);
  });

  it("rejects failed episodes", () => {
    const failures = assertVerticalSliceEpisodes([
      episode({
        trigger: "foreground_user",
        kind: "failed",
        message: "terminated",
      }),
    ]);
    expect(failures.some((line) => line.includes("unexpected failed"))).toBe(true);
  });
});
