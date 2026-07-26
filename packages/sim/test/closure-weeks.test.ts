import { describe, expect, it } from "vitest";
import { ScenarioRunner } from "../src/runner.js";
import {
  buildClosureWeeksScenario,
  CLOSURE_WEEKS_SCENARIO_ID,
} from "../src/scenarios/closure-weeks.js";

describe("s-closure-weeks", () => {
  it("passes the offline closure scenario", async () => {
    const report = await new ScenarioRunner().run(buildClosureWeeksScenario());
    expect(report.scenarioId).toBe(CLOSURE_WEEKS_SCENARIO_ID);
    expect(report.ok).toBe(true);
  }, 60_000);
});
