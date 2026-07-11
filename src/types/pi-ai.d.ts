declare module "@earendil-works/pi-ai" {
  export function createModels(options?: unknown): unknown;
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
