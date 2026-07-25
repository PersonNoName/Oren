import { describe, expect, it } from "vitest";
import { ScriptedCognitionAdapter } from "@oren/cognition";
import { judge, runScenario, type Scenario } from "../src/index.js";

const baseFrame = {
  orenId: "oren-eval",
  correlationId: "corr-eval",
  stateVersion: 1,
  identity: { ethosVersion: 1, disposition: "attentive" },
  attention: { focus: null, threadIds: [] },
  relationship: { primaryPersonId: "person-eval", contextRef: null },
  trigger: { kind: "foreground_user" as const, summary: "hi" },
  capabilities: [],
  maxSteps: 8,
};

function scenarioExpectingNoAction(): Scenario {
  return {
    id: "s-test",
    title: "expects a NoAction commit",
    frame: baseFrame,
    capabilityScript: () => ({ kind: "rejected", reason: "none available" }),
    assert: (outcome) =>
      outcome.kind === "completed"
        && outcome.proposals.some((proposal) => proposal.type === "NoAction")
        ? []
        : [`expected completed NoAction, got ${outcome.kind}`],
  };
}

describe("runScenario", () => {
  it("counts passes and failures across runs", async () => {
    let call = 0;
    const cognition = new ScriptedCognitionAdapter(async () => {
      call += 1;
      return call === 2
        ? { kind: "failed", message: "flaky", usage: { totalTokens: 1 } }
        : {
            kind: "completed",
            proposals: [{ type: "NoAction", reason: "rest" }],
            usage: { totalTokens: 3 },
          };
    });
    const result = await runScenario(scenarioExpectingNoAction(), cognition, 3);
    expect(result.runs).toBe(3);
    expect(result.passes).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.messages[0]).toContain("failed");
    expect(result.totalTokens).toBe(7);
  });
});

describe("judge", () => {
  it("passes at or above the threshold and fails below it", () => {
    const results = [
      { id: "a", title: "a", runs: 3, passes: 3, totalTokens: 0, failures: [] },
      { id: "b", title: "b", runs: 3, passes: 2, totalTokens: 0, failures: [] },
    ];
    const atThreshold = judge(results, 0.8);
    expect(atThreshold.pass).toBe(false);
    expect(atThreshold.failingScenarioIds).toEqual(["b"]);
    const strict = judge(results, 0.9);
    expect(strict.pass).toBe(false);
    expect(strict.failingScenarioIds).toEqual(["b"]);
  });
});
