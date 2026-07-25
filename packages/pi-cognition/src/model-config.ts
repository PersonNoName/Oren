// packages/pi-cognition/src/model-config.ts
import {
  findEnvKeys,
  getModels,
  getProviders,
  streamSimple,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const MODEL_PROVIDER_ENV = "OREN_MODEL_PROVIDER";
export const MODEL_ID_ENV = "OREN_MODEL_ID";

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

  const keyNames = findEnvKeys(knownProvider) ?? [];
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
