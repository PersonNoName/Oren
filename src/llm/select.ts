import { FakeLlmCompleter } from "./fake.js";
import { PiAiCompleter } from "./pi-ai.js";
import type { LlmCompleter } from "./types.js";

export type LlmPurpose = "tick" | "say" | "default";

/**
 * Resolve completer for a purpose.
 * OREN_TICK_LLM / OREN_SAY_LLM override OREN_LLM for cost control
 * (e.g. fake ticks + live dialogue).
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
