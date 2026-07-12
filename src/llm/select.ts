import { FakeLlmCompleter } from "./fake.js";
import { PiAiCompleter } from "./pi-ai.js";
import type { LlmCompleter } from "./types.js";

export type LlmPurpose = "tick" | "say" | "organize" | "plan" | "will" | "default";

/**
 * Resolve completer for a purpose.
 * OREN_TICK_LLM / OREN_SAY_LLM / OREN_ORGANIZE_LLM / OREN_PLAN_LLM / OREN_WILL_LLM override OREN_LLM.
 *
 * Plan + organize deliberately do NOT inherit OREN_TICK_LLM=fake — they are
 * the "soul" costs and should use DeepSeek unless explicitly set to fake.
 * Will-turn follows the same unset default as plan (live if key, else fake).
 */
export function selectLlm(model: string, purpose: LlmPurpose = "default"): LlmCompleter {
  const mode = resolveMode(purpose);
  if (mode === "fake") {
    return new FakeLlmCompleter().enableAutoShape();
  }
  if (mode === "pi" || mode === "live") {
    return new PiAiCompleter(model);
  }
  // auto
  if (hasProviderKey()) {
    return new PiAiCompleter(model);
  }
  return new FakeLlmCompleter().enableAutoShape();
}

function resolveMode(purpose: LlmPurpose): string {
  if (purpose === "tick" && process.env.OREN_TICK_LLM) {
    return process.env.OREN_TICK_LLM.toLowerCase();
  }
  if (purpose === "say" && process.env.OREN_SAY_LLM) {
    return process.env.OREN_SAY_LLM.toLowerCase();
  }
  if (purpose === "will" || purpose === "organize" || purpose === "plan") {
    const envKey =
      purpose === "will"
        ? process.env.OREN_WILL_LLM
        : purpose === "plan"
          ? process.env.OREN_PLAN_LLM
          : process.env.OREN_ORGANIZE_LLM;
    if (envKey) return envKey.toLowerCase();
    if (process.env.OREN_LLM) return process.env.OREN_LLM.toLowerCase();
    return hasProviderKey() ? "pi" : "fake";
  }
  return (process.env.OREN_LLM ?? "auto").toLowerCase();
}

export function hasProviderKey(): boolean {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_OAUTH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_COMPAT_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY
  );
}
