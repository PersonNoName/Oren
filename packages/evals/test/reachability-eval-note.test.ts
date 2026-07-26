import { describe, expect, it } from "vitest";
import { DEFAULT_REACHABILITY, evaluateReachability } from "@oren/kernel";

describe("evaluateReachability (evals package acceptance note)", () => {
  const base = DEFAULT_REACHABILITY;

  it("defers proactive shares during quiet hours", () => {
    const decision = evaluateReachability(base, "2026-07-26T23:00:00.000Z", true);
    expect(decision.action).toBe("defer");
    if (decision.action === "defer") {
      expect(decision.cause).toBe("quiet_hours");
    }
  });

  it("defers proactive shares when daily frequency cap is hit", () => {
    const capped = {
      ...base,
      quietHours: null,
      proactiveDayKey: "2026-07-26",
      proactiveCountToday: 3,
      maxProactivePerDay: 3,
    };
    const decision = evaluateReachability(capped, "2026-07-26T12:00:00.000Z", true);
    expect(decision.action).toBe("defer");
    if (decision.action === "defer") {
      expect(decision.cause).toBe("frequency_cap");
    }
  });
});
