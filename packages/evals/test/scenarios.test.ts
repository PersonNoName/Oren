import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedCognitionAdapter } from "@oren/cognition";
import { allScenarios, runEvals } from "../src/index.js";

describe("allScenarios", () => {
  it("defines at least 8 scenarios with unique ids and valid frames", () => {
    const scenarios = allScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(8);
    const ids = scenarios.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of scenarios) {
      expect(scenario.frame.maxSteps).toBeGreaterThan(0);
      expect(scenario.frame.identity.ethosVersion).toBe(1);
    }
  });

  it("every scenario's assertions reject a plainly wrong outcome", () => {
    for (const scenario of allScenarios()) {
      const messages = scenario.assert(
        { kind: "aborted", usage: { totalTokens: 0 } },
        [],
      );
      expect(messages.length, scenario.id).toBeGreaterThan(0);
    }
  });
});

describe("runEvals", () => {
  it("exits 0 with instructions when model env is unconfigured", async () => {
    const lines: string[] = [];
    const code = await runEvals(
      { OREN_CONFIG_SEARCH_FROM: mkdtempSync(join(tmpdir(), "oren-eval-empty-")) },
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("OREN_MODEL_PROVIDER");
  });

  it("reports per-scenario results and fails below threshold with injected cognition", async () => {
    const lines: string[] = [];
    const alwaysRests = new ScriptedCognitionAdapter(async () => ({
      kind: "completed",
      proposals: [{ type: "NoAction", reason: "rest" }],
      usage: { totalTokens: 1 },
    }));
    const code = await runEvals(
      { OREN_EVAL_RUNS: "1", OREN_EVAL_THRESHOLD: "0.9" },
      (line) => lines.push(line),
      alwaysRests,
    );
    expect(code).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("overall");
    expect(output).toContain("s01");
  });

  it("rejects invalid runs or threshold values", async () => {
    const lines: string[] = [];
    const code = await runEvals(
      { OREN_EVAL_RUNS: "zero" },
      (line) => lines.push(line),
      new ScriptedCognitionAdapter(async () => ({
        kind: "completed",
        proposals: [],
        usage: { totalTokens: 0 },
      })),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("OREN_EVAL_RUNS");
  });
});
