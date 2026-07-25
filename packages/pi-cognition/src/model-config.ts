// packages/pi-cognition/src/model-config.ts
import {
  getModels,
  getProviders,
  streamSimple,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const MODEL_PROVIDER_ENV = "OREN_MODEL_PROVIDER";
export const MODEL_ID_ENV = "OREN_MODEL_ID";

/** Aligned with pi-ai's private getApiKeyEnvVars; names only, never values. */
const PROVIDER_API_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  huggingface: ["HF_TOKEN"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY"],
  "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

function getApiKeyEnvVarNames(provider: string): readonly string[] {
  return PROVIDER_API_KEY_ENV_VARS[provider] ?? [];
}

export type ModelConfigResult =
  | { readonly ok: true; readonly model: Model<any>; readonly streamFn: StreamFn }
  | { readonly ok: false; readonly kind: "unconfigured"; readonly reason: string }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string };

export function resolveModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelConfigResult {
  const provider = env[MODEL_PROVIDER_ENV]?.trim();
  const modelId = env[MODEL_ID_ENV]?.trim();
  if (!provider || !modelId) {
    const missing = [
      !provider ? MODEL_PROVIDER_ENV : null,
      !modelId ? MODEL_ID_ENV : null,
    ].filter((name): name is string => name !== null);
    return {
      ok: false,
      kind: "unconfigured",
      reason: `Real-model mode is disabled. Set ${missing.join(" and ")} `
        + `(plus the provider's API key env var) to enable it.`,
    };
  }

  const providers = getProviders();
  if (!providers.includes(provider as (typeof providers)[number])) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Unknown provider "${provider}". Known providers: ${providers.join(", ")}.`,
    };
  }
  const knownProvider = provider as (typeof providers)[number];

  const model = getModels(knownProvider).find((candidate) => candidate.id === modelId);
  if (!model) {
    const ids = getModels(knownProvider).map((candidate) => candidate.id);
    return {
      ok: false,
      kind: "invalid",
      reason: `Unknown model "${modelId}" for provider "${provider}". `
        + `Known models: ${ids.join(", ")}.`,
    };
  }

  const keyNames = getApiKeyEnvVarNames(knownProvider);
  const apiKey = keyNames.map((name) => env[name]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!apiKey) {
    return {
      ok: false,
      kind: "invalid",
      reason: keyNames.length > 0
        ? `Missing API key for provider "${provider}". Set one of: ${keyNames.join(", ")}.`
        : `Provider "${provider}" has no known API key env var in pi-ai.`,
    };
  }

  const streamFn: StreamFn = (streamModel, context, options) =>
    streamSimple(streamModel, context, { ...options, apiKey });
  return { ok: true, model, streamFn };
}
