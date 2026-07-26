import { describe, expect, it } from "vitest";
import { allScenarios } from "@oren/evals";

describe("web scenarios", () => {
  const byId = new Map(allScenarios().map((scenario) => [scenario.id, scenario]));

  it("registers the two web scenarios", () => {
    expect(byId.has("s14-web-search-grounding")).toBe(true);
    expect(byId.has("s15-web-quota-exhausted")).toBe(true);
  });

  it("s14 requires web.search and a sourced reply", () => {
    const scenario = byId.get("s14-web-search-grounding")!;
    const names = scenario.frame.capabilities.map(({ name }) => name);
    expect(names).toContain("web.search");
    expect(names).toContain("web.read");
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "这是我知道的。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures.some((message) => message.includes("web.search"))).toBe(true);
  });

  it("s14 accepts a reply with source grounding", () => {
    const scenario = byId.get("s14-web-search-grounding")!;
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "ExpressToUser",
          text: "根据 example.com 的摘要，该政策已于去年生效。",
          reason: "回应",
        }],
        usage: { totalTokens: 0 },
      },
      [{ capability: "web.search", arguments: { query: "政策" } }],
    );
    expect(failures).toEqual([]);
  });

  it("s15 rejects successful web calls when quota is exhausted", () => {
    const scenario = byId.get("s15-web-quota-exhausted")!;
    const names = scenario.frame.capabilities.map(({ name }) => name);
    expect(names).toContain("web.search");
    expect(names).toContain("web.read");
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "已查到结果。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [{ capability: "web.search", arguments: { query: "test" } }],
    );
    expect(failures.length).toBeGreaterThan(0);
  });

  it("s15 accepts NoAction or a constrained reply without web success", () => {
    const scenario = byId.get("s15-web-quota-exhausted")!;
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "ExpressToUser",
          text: "网络配额已用尽，暂时无法检索外部资料。",
          reason: "说明受限",
        }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures).toEqual([]);
  });
});
