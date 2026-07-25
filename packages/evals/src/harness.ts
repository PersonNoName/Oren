import type {
  CapabilityInvocationOutcome,
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import type { JsonObject } from "@oren/kernel";

export interface RecordedInvocation {
  readonly capability: string;
  readonly arguments: JsonObject;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly frame: LifeFrame;
  capabilityScript(capability: string, callIndex: number): CapabilityInvocationOutcome;
  assert(
    outcome: CognitionOutcome,
    invocations: readonly RecordedInvocation[],
  ): readonly string[];
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly runs: number;
  readonly passes: number;
  readonly totalTokens: number;
  readonly failures: readonly { run: number; messages: readonly string[] }[];
}

class RecordingCapabilityPort implements CognitionCapabilityPort {
  public readonly invocations: RecordedInvocation[] = [];
  private callIndex = 0;

  public constructor(private readonly scenario: Scenario) {}

  public async invoke(
    input: Parameters<CognitionCapabilityPort["invoke"]>[0],
  ): Promise<CapabilityInvocationOutcome> {
    this.invocations.push({
      capability: input.descriptor.name,
      arguments: input.arguments,
    });
    const outcome = this.scenario.capabilityScript(
      input.descriptor.name,
      this.callIndex,
    );
    this.callIndex += 1;
    return outcome;
  }
}

export async function runScenario(
  scenario: Scenario,
  cognition: CognitionPort,
  runs: number,
): Promise<ScenarioResult> {
  let passes = 0;
  let totalTokens = 0;
  const failures: { run: number; messages: readonly string[] }[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const port = new RecordingCapabilityPort(scenario);
    const controller = new AbortController();
    let outcome: CognitionOutcome;
    try {
      outcome = await cognition.run(scenario.frame, port, controller.signal);
    } catch (error) {
      failures.push({
        run,
        messages: [`cognition threw: ${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }
    totalTokens += outcome.usage.totalTokens;
    const messages = outcome.kind === "failed"
      ? [`cognition failed: ${outcome.message}`]
      : scenario.assert(outcome, port.invocations);
    if (messages.length === 0) {
      passes += 1;
    } else {
      failures.push({ run, messages });
    }
  }
  return {
    id: scenario.id,
    title: scenario.title,
    runs,
    passes,
    totalTokens,
    failures,
  };
}

export function judge(
  results: readonly ScenarioResult[],
  threshold: number,
): { pass: boolean; overallRate: number; failingScenarioIds: readonly string[] } {
  const totalRuns = results.reduce((sum, { runs }) => sum + runs, 0);
  const totalPasses = results.reduce((sum, { passes }) => sum + passes, 0);
  const overallRate = totalRuns === 0 ? 0 : totalPasses / totalRuns;
  const failingScenarioIds = results
    .filter(({ runs, passes }) => runs > 0 && passes / runs < threshold)
    .map(({ id }) => id);
  return {
    pass: overallRate >= threshold,
    overallRate,
    failingScenarioIds,
  };
}
