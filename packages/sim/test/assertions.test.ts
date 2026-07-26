import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import { createSequencedCognition, defaultAssertions, ScenarioRunner } from "../src/index.js";

describe("defaultAssertions", () => {
  it("budgetMonotone fails when web quota rises", async () => {
    const orenId = "oren-1";
    const before = {
      ...createInitialLifeState(orenId, "person-1"),
      budgets: {
        autonomyRemaining: 10,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
        webQuotaRemaining: 5,
      },
    };
    const live = {
      ...before,
      budgets: { ...before.budgets, webQuotaRemaining: 8 },
    };
    const checkpoints = new Map([["c0", before]]);
    await expect(
      defaultAssertions.budgetMonotone!({
        runtime: { inspect: () => live } as never,
        orenId,
        checkpoints,
        clock: { now: () => "2026-01-01T00:00:00.000Z" } as never,
        args: { since: "c0" },
      }),
    ).rejects.toThrow(/quota|monotone|budget/i);
  });
});

describe("shareDelivered integration", () => {
  it("passes after ExpressToUser delivers to inbox", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "ExpressToUser", text: "Here is an update.", reason: "share" },
          { type: "NoAction", reason: "done" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "share-delivered-smoke",
      scripts: { default: cognition },
      steps: [
        { type: "message", text: "hello" },
        { type: "assert", name: "shareDelivered" },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.stepsCompleted).toBe(2);
  });
});
