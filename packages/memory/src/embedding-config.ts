import type { EmbeddingPort } from "./types.js";

export const EMBEDDING_PROVIDER_ENV = "OREN_EMBEDDING_PROVIDER";
export const EMBEDDING_MODEL_ENV = "OREN_EMBEDDING_MODEL";
export const EMBEDDING_BASE_URL_ENV = "OREN_EMBEDDING_BASE_URL";

interface ProviderInfo {
  readonly baseUrl: string | undefined;
  readonly keyEnvVars: readonly string[];
}

const PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnvVars: ["OPENAI_API_KEY"] },
  // 任何 OpenAI 兼容端点：必须提供 OREN_EMBEDDING_BASE_URL
  "openai-compatible": { baseUrl: undefined, keyEnvVars: ["OREN_EMBEDDING_API_KEY"] },
};

export type EmbeddingConfigResult =
  | { readonly ok: true; readonly embedder: EmbeddingPort }
  | { readonly ok: false; readonly kind: "unconfigured" | "invalid"; readonly reason: string };

export function resolveEmbeddingConfig(
  env: Readonly<Record<string, string | undefined>>,
): EmbeddingConfigResult {
  const provider = env[EMBEDDING_PROVIDER_ENV]?.trim();
  const model = env[EMBEDDING_MODEL_ENV]?.trim();
  if (!provider || !model) {
    const missing = [
      !provider ? EMBEDDING_PROVIDER_ENV : null,
      !model ? EMBEDDING_MODEL_ENV : null,
    ].filter((name): name is string => name !== null);
    return {
      ok: false,
      kind: "unconfigured",
      reason: `Vector recall is disabled. Set ${missing.join(" and ")} `
        + `(plus the provider's API key env var) to enable it.`,
    };
  }
  const info = PROVIDERS[provider];
  if (!info) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Unknown embedding provider "${provider}". `
        + `Known providers: ${Object.keys(PROVIDERS).join(", ")}.`,
    };
  }
  const baseUrl = env[EMBEDDING_BASE_URL_ENV]?.trim() || info.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Provider "${provider}" requires ${EMBEDDING_BASE_URL_ENV}.`,
    };
  }
  const apiKey = info.keyEnvVars.map((name) => env[name]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!apiKey) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Missing API key for embedding provider "${provider}". `
        + `Set one of: ${info.keyEnvVars.join(", ")}.`,
    };
  }
  return { ok: true, embedder: new HttpEmbedder(baseUrl, model, apiKey) };
}

class HttpEmbedder implements EmbeddingPort {
  public constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {}

  public async embed(
    texts: readonly string[],
  ): Promise<ReadonlyArray<readonly number[]>> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status} ${response.statusText}`);
    }
    const body = await response.json() as {
      data?: ReadonlyArray<{ embedding?: readonly number[] }>;
    };
    const vectors = (body.data ?? []).map(({ embedding }) => embedding);
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector))) {
      throw new Error("Embedding response shape is invalid");
    }
    return vectors as ReadonlyArray<readonly number[]>;
  }
}
