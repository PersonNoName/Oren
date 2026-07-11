import type { Config, Mode } from "../types.js";

export function chooseMode(input: {
  force?: Mode;
  recentModes: Mode[];
  config: Config;
  hasReadableCorpus: boolean;
  activeThreadCount: number;
  rng: () => number;
}): { mode: Mode; reason: string } {
  if (input.force) {
    return { mode: input.force, reason: `force:${input.force}` };
  }

  const { recentModes, config, hasReadableCorpus, activeThreadCount, rng } = input;
  const maxConsec = config.mode.max_consecutive_contemplate;

  let consecutiveContemplate = 0;
  for (let i = recentModes.length - 1; i >= 0; i--) {
    if (recentModes[i] === "contemplate") consecutiveContemplate++;
    else break;
  }

  if (rng() < config.mode.idle_probability) {
    return { mode: "idle", reason: "idle_probability" };
  }

  if (activeThreadCount > config.limits.max_active_threads) {
    return { mode: "organize", reason: "too_many_active_threads" };
  }

  if (consecutiveContemplate >= maxConsec) {
    return { mode: "organize", reason: "max_consecutive_contemplate" };
  }

  if (!hasReadableCorpus) {
    return { mode: "idle", reason: "no_readable_corpus" };
  }

  return { mode: "contemplate", reason: "default_main_melody" };
}
