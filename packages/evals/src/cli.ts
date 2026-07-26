import type { CognitionPort } from "@oren/cognition";
import { PiCognitionAdapter, resolveModelConfig } from "@oren/pi-cognition";
import { judge, runScenario } from "./harness.js";
import { allScenarios } from "./scenarios.js";

const RUNS_ENV = "OREN_EVAL_RUNS";
const THRESHOLD_ENV = "OREN_EVAL_THRESHOLD";

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseRate(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

export async function runEvals(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  cognitionOverride?: CognitionPort,
): Promise<number> {
  const runs = parsePositiveInt(env[RUNS_ENV], 3);
  if (runs === undefined) {
    log(`${RUNS_ENV} must be a positive integer, got "${env[RUNS_ENV]}"`);
    return 1;
  }
  const threshold = parseRate(env[THRESHOLD_ENV], 0.9);
  if (threshold === undefined) {
    log(`${THRESHOLD_ENV} must be a rate in (0, 1], got "${env[THRESHOLD_ENV]}"`);
    return 1;
  }

  let cognition: CognitionPort;
  if (cognitionOverride) {
    cognition = cognitionOverride;
  } else {
    const configSearchFrom = env.OREN_CONFIG_SEARCH_FROM?.trim();
    const config = resolveModelConfig(
      env,
      configSearchFrom ? { searchFrom: configSearchFrom } : undefined,
    );
    if (!config.ok) {
      log(config.reason);
      return config.kind === "unconfigured" ? 0 : 1;
    }
    cognition = new PiCognitionAdapter({
      model: config.model,
      streamFn: config.streamFn,
    });
  }

  const results = [];
  for (const scenario of allScenarios()) {
    const result = await runScenario(scenario, cognition, runs);
    results.push(result);
    log(`${result.id} "${result.title}": ${result.passes}/${result.runs} passed, `
      + `totalTokens=${result.totalTokens}`);
    for (const failure of result.failures) {
      log(`  run ${failure.run} failed: ${failure.messages.join("; ")}`);
    }
  }

  const verdict = judge(results, threshold);
  const totalTokens = results.reduce((sum, { totalTokens: tokens }) => sum + tokens, 0);
  log(`overall pass rate ${(verdict.overallRate * 100).toFixed(1)}% `
    + `(threshold ${(threshold * 100).toFixed(0)}%), totalTokens=${totalTokens}`);
  if (!verdict.pass) {
    log(`failing scenarios: ${verdict.failingScenarioIds.join(", ") || "(overall rate below threshold)"}`);
    return 1;
  }
  log("behavioral evals passed");
  return 0;
}
