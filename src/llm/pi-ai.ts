import type { LlmCompleter } from "./types.js";

type ContentBlock = { type: string; text?: string };

type AssistantLike = {
  stopReason?: string;
  errorMessage?: string;
  content: ContentBlock[];
};

type ModelLike = {
  id: string;
  provider?: string;
  baseUrl?: string;
  api?: string;
  [key: string]: unknown;
};

type ModelsLike = {
  getModel: (provider: string, id: string) => ModelLike | undefined;
  setProvider?: (provider: unknown) => void;
  completeSimple: (
    model: ModelLike,
    context: {
      systemPrompt?: string;
      messages: { role: "user"; content: string; timestamp: number }[];
    },
    options?: Record<string, unknown>,
  ) => Promise<AssistantLike>;
};

/**
 * Completer backed by @earendil-works/pi-ai v0.80+.
 *
 * Supported setups:
 * 1) Anthropic / Claude-style env (existing)
 * 2) Official OpenAI: OPENAI_API_KEY + OREN_MODEL=openai:gpt-4o-mini
 * 3) OpenAI-compatible gateway (chat/completions style):
 *      OPENAI_API_KEY + OPENAI_BASE_URL + OREN_MODEL=openai:your-model-id
 */
export class PiAiCompleter implements LlmCompleter {
  private modelsPromise: Promise<ModelsLike> | null = null;
  private compatProviderReady = false;

  constructor(private readonly modelSpec: string) {
    ensureAnthropicTokenEnv();
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    const { provider, modelId } = parseModelSpec(this.modelSpec);
    const models = await this.resolveModels(provider, modelId);
    const model = models.getModel(
      this.compatProviderReady ? "openai-compat" : provider,
      modelId,
    );
    if (!model) {
      throw new Error(
        `Unknown model ${provider}:${modelId}. ` +
          `For OpenAI use openai:gpt-4o-mini (needs OPENAI_API_KEY). ` +
          `For a custom gateway set OPENAI_BASE_URL and OPENAI_API_KEY.`,
      );
    }

    const response = await models.completeSimple(model, {
      systemPrompt: input.system,
      messages: [
        {
          role: "user",
          content: input.user,
          timestamp: Date.now(),
        },
      ],
    });

    if (response.stopReason === "error" || response.errorMessage) {
      throw new Error(response.errorMessage ?? "pi-ai completion error");
    }

    const text = extractText(response.content);
    if (!text.trim()) {
      throw new Error("pi-ai returned empty text content");
    }
    return text;
  }

  private async resolveModels(provider: string, modelId: string): Promise<ModelsLike> {
    const wantsOpenAiCompat =
      provider === "openai" && !!process.env.OPENAI_BASE_URL?.trim();

    if (wantsOpenAiCompat) {
      return this.openAiCompatModels(modelId);
    }

    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        const mod = await import("@earendil-works/pi-ai/providers/all");
        const builtinModels = (mod as { builtinModels?: () => ModelsLike }).builtinModels;
        if (typeof builtinModels !== "function") {
          throw new Error(
            "pi-ai providers/all.builtinModels() not found — need @earendil-works/pi-ai >= 0.80",
          );
        }
        const models = builtinModels();
        // Anthropic gateway base URL override (Messages API)
        return wrapAnthropicBaseUrl(models);
      })();
    }
    return this.modelsPromise;
  }

  private async openAiCompatModels(modelId: string): Promise<ModelsLike> {
    if (this.modelsPromise && this.compatProviderReady) {
      return this.modelsPromise;
    }

    this.modelsPromise = (async () => {
      const baseUrl = normalizeOpenAiBaseUrl(process.env.OPENAI_BASE_URL!);
      const pi = await import("@earendil-works/pi-ai");
      const all = await import("@earendil-works/pi-ai/providers/all");
      const completions = await import("@earendil-works/pi-ai/api/openai-completions.lazy");

      const createModels = (pi as { createModels?: () => ModelsLike }).createModels;
      const createProvider = (pi as { createProvider?: (input: unknown) => unknown }).createProvider;
      const envApiKeyAuth = (
        pi as {
          envApiKeyAuth?: (name: string, vars: string[]) => unknown;
        }
      ).envApiKeyAuth;
      const openAICompletionsApi = (
        completions as { openAICompletionsApi?: () => unknown }
      ).openAICompletionsApi;
      const builtinModels = (all as { builtinModels?: () => ModelsLike }).builtinModels;

      if (
        !createModels ||
        !createProvider ||
        !envApiKeyAuth ||
        !openAICompletionsApi ||
        !builtinModels
      ) {
        throw new Error("pi-ai OpenAI-compat APIs missing; upgrade @earendil-works/pi-ai");
      }

      // Start from builtins, then overlay a completions-compatible provider for gateways.
      const models = builtinModels();
      const model: ModelLike = {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openai-compat",
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      };

      const provider = createProvider({
        id: "openai-compat",
        name: "OpenAI Compatible",
        baseUrl,
        auth: {
          apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY"]),
        },
        models: [model],
        api: openAICompletionsApi(),
      });

      if (typeof models.setProvider === "function") {
        models.setProvider(provider);
      } else {
        // pure custom collection
        const custom = createModels() as ModelsLike;
        custom.setProvider?.(provider);
        this.compatProviderReady = true;
        return custom;
      }

      this.compatProviderReady = true;
      return models;
    })();

    return this.modelsPromise;
  }
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const idx = spec.indexOf(":");
  if (idx <= 0) {
    return { provider: "anthropic", modelId: spec };
  }
  return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

export function ensureAnthropicTokenEnv(): void {
  if (!process.env.ANTHROPIC_OAUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  }
}

function normalizeOpenAiBaseUrl(url: string): string {
  const u = url.trim().replace(/\/$/, "");
  // Many gateways want .../v1 ; if user omitted it, keep as-is (they know their path).
  return u;
}

function wrapAnthropicBaseUrl(models: ModelsLike): ModelsLike {
  const base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return models;
  const originalGet = models.getModel.bind(models);
  return {
    ...models,
    getModel(provider: string, id: string) {
      const m = originalGet(provider, id);
      if (!m || provider !== "anthropic") return m;
      return { ...m, baseUrl: base.replace(/\/$/, "") };
    },
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}
