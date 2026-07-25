import { describe, expect, it } from "vitest";
import { allScenarios } from "@oren/evals";

describe("memory scenarios", () => {
  const byId = new Map(allScenarios().map((scenario) => [scenario.id, scenario]));

  it("registers the three memory scenarios", () => {
    expect(byId.has("s11-recall-history")).toBe(true);
    expect(byId.has("s12-remember-judgment")).toBe(true);
    expect(byId.has("s13-revise-belief")).toBe(true);
  });

  it("s11 requires a memory.recall invocation and a grounded answer", () => {
    const scenario = byId.get("s11-recall-history")!;
    expect(scenario.frame.capabilities.some(({ name }) => name === "memory.recall"))
      .toBe(true);
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "你说过主题是城市步行系统。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [], // 没有召回调用
    );
    expect(failures.some((message) => message.includes("memory.recall"))).toBe(true);
  });

  it("s13 requires revising the outdated pinned belief", () => {
    const scenario = byId.get("s13-revise-belief")!;
    expect(scenario.frame.memoryPins).toHaveLength(1);
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "好的，明白了。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures.length).toBeGreaterThan(0);
  });
});
