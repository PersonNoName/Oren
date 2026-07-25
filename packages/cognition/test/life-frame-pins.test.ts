import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import { createLifeFrame, type MemoryPin } from "@oren/cognition";

const PIN: MemoryPin = {
  memoryId: "m1", kind: "oren_judgment", text: "判断：用户在准备演讲",
  confidence: 0.6, occurredAt: "2026-07-20T00:00:00.000Z",
};

describe("createLifeFrame memory pins", () => {
  it("defaults to no pins and caps pins at five", () => {
    const base = {
      state: createInitialLifeState("oren-1", "person-1"),
      correlationId: "c1",
      trigger: { kind: "foreground_user" as const, summary: "hi" },
      capabilities: [],
      maxSteps: 8,
    };
    expect(createLifeFrame(base).memoryPins).toEqual([]);
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...PIN, memoryId: `m${index}`,
    }));
    const frame = createLifeFrame({ ...base, memoryPins: many });
    expect(frame.memoryPins).toHaveLength(5);
    expect(frame.memoryPins[0]!.memoryId).toBe("m0");
  });
});
