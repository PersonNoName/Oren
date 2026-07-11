declare module "@earendil-works/pi-ai" {
  export function getModel(provider: string, modelId: string): unknown;
  export function streamSimple(
    model: unknown,
    context: unknown,
    opts?: unknown,
  ): AsyncIterable<Record<string, unknown>> & {
    result?: () => Promise<{ text?: string }>;
  };
  export function completeSimple(
    model: unknown,
    context: unknown,
  ): Promise<{ text?: string; content?: string }>;
}
