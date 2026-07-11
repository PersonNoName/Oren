export interface LlmCompleter {
  complete(input: { system: string; user: string }): Promise<string>;
}
