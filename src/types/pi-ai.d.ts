declare module "@earendil-works/pi-ai" {
  export function createModels(options?: unknown): {
    getModel(provider: string, id: string): unknown;
    setProvider?(provider: unknown): void;
    completeSimple(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  };
  export function createProvider(input: unknown): unknown;
  export function envApiKeyAuth(name: string, vars: string[]): unknown;
}

declare module "@earendil-works/pi-ai/providers/all" {
  export function builtinModels(options?: unknown): {
    getModel(provider: string, id: string):
      | {
          id: string;
          provider?: string;
          baseUrl?: string;
          [key: string]: unknown;
        }
      | undefined;
    setProvider?(provider: unknown): void;
    completeSimple(
      model: unknown,
      context: {
        systemPrompt?: string;
        messages: { role: "user"; content: string; timestamp: number }[];
      },
      options?: Record<string, unknown>,
    ): Promise<{
      stopReason?: string;
      errorMessage?: string;
      content: { type: string; text?: string }[];
    }>;
  };
}

declare module "@earendil-works/pi-ai/api/openai-completions.lazy" {
  export function openAICompletionsApi(): unknown;
}
