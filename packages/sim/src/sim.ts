import { ScenarioRunner } from "./runner.js";
import { buildClosureWeeksScenario } from "./scenarios/closure-weeks.js";

export async function runSimCli(): Promise<number> {
  const report = await new ScenarioRunner().run(buildClosureWeeksScenario());
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const exitCode = await runSimCli();
process.exitCode = exitCode;
