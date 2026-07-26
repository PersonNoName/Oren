import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";

describe("VirtualClock", () => {
  it("starts at default origin and advances monotonically", () => {
    const clock = new VirtualClock();
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    clock.advanceBy(60_000);
    expect(clock.now()).toBe("2026-01-01T00:01:00.000Z");
    clock.advanceTo("2026-01-02T00:00:00.000Z");
    expect(clock.now()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects rewind and negative advanceBy", () => {
    const clock = new VirtualClock("2026-01-01T12:00:00.000Z");
    expect(() => clock.advanceTo("2026-01-01T11:00:00.000Z")).toThrow(/rewind|monotone/i);
    expect(() => clock.advanceBy(-1)).toThrow();
  });
});
