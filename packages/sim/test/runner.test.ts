import { describe, expect, it } from "vitest";
import { createSequencedCognition, ScenarioRunner } from "../src/index.js";

describe("ScenarioRunner", () => {
  it("runs message + advance with sequenced cognition and checkpoint", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "AdvanceThread", threadId: "thread-1", summary: "start clue" },
          { type: "ExpressToUser", text: "I heard you.", reason: "ack" },
          { type: "NoAction", reason: "done" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t2-smoke",
      scripts: { default: cognition },
      steps: [
        { type: "message", text: "hello" },
        { type: "checkpoint", name: "after-hello" },
        { type: "advance", ms: 3_600_000 },
        { type: "assert", name: "ok" },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.stepsCompleted).toBe(4);
  });
});
