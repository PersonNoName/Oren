import type { Config } from "../types.js";

export function willConfig(config: Config) {
  if (config.will) return config.will;
  const ag = config.agenda;
  return {
    enabled: ag?.enabled ?? true,
    user_present_ms: ag?.user_present_ms ?? 2 * 60 * 1000,
    replan_after_actions: ag?.replan_after_actions ?? 3,
    say_cooldown_ms: ag?.say_cooldown_ms ?? 4 * 60 * 60 * 1000,
    max_open_moves: 12,
    min_session_intents: ag?.min_intents ?? 3,
    max_session_intents: ag?.max_intents ?? 7,
  };
}
