import type { LlmCompleter } from "./types.js";

export type PiModels = {
  getModel: (provider: string, id: string) => PiModel | undefined;
  completeSimple: (
    model: PiModel,
    context: {
      systemPrompt?: string;
      messages: { role: "user"; content: string; timestamp: number }[];
    },
    options?: Record<string, unknown>,
  ) => Promise<{
    stopReason?: string;
    errorMessage?: string;
    content: { type: string; text?: string }[];
  }>;
};

export type PiModel = {
  id: string;
  provider?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

/**
 * Completer backed by @earendil-works/pi-ai v0.80+ (Models collection API).
 *
 * Auth: provider env keys (e.g. ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN).
 * Also maps ANTHROPIC_AUTH_TOKEN → ANTHROPIC_OAUTH_TOKEN for Claude-style envs.
 * Optional ANTHROPIC_BASE_URL overrides model.baseUrl for gateway proxies.
 */
export class PiAiCompleter implements LlmCompleter {
  private modelsPromise: Promise<PiModels> | null = null;

  constructor(private readonly modelSpec: string) {
    ensureAnthropicTokenEnv();
  }

  private async models(): Promise<PiModels> {
    if (!this.modelsPromise) {
      this.modelsPromise = (async () => {
        const mod = await import("@earendil-works/pi-ai/providers/all");
        const builtinModels = (mod as { builtinModels?: () => PiModels }).builtinModels;
        if (typeof builtinModels !== "function") {
          throw new Error(
            "pi-ai providers/all.builtinModels() not found — need @earendil-works/pi-ai >= 0.80",
          );
        }
        return builtinModels();
      })();
    }
    return this.modelsPromise;
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    const models = await this.models();
    const { provider, modelId } = parseModelSpec(this.modelSpec);
    const found = models.getModel(provider, modelId);
    if (!found) {
      const hint =
        provider === "anthropic"
          ? "try anthropic:claude-sonnet-4-5"
          : "check provider:model id via pi-ai catalog";
      throw new Error(`Unknown model ${provider}:${modelId} (${hint})`);
    }

    const model = applyBaseUrlOverride(found, provider);

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
  if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN) {
    // some gateways accept the token as api key style
    // prefer OAUTH_TOKEN path above; do not overwrite API_KEY if set
  }
}

function applyBaseUrlOverride(model: PiModel, provider: string): PiModel {
  if (provider !== "anthropic") return model;
  const base = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return model;
  return { ...model, baseUrl: base.replace(/\/$/, "") };
}

function extractText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}
