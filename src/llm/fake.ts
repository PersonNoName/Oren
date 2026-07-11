import type { LlmCompleter } from "./types.js";

export class FakeLlmCompleter implements LlmCompleter {
  readonly calls: { system: string; user: string }[] = [];
  private response: string;

  constructor(response?: string) {
    this.response =
      response ??
      JSON.stringify({
        monologue:
          "I sit with this passage and notice a pattern of attention forming—not for anyone else, just the pull of the question itself.",
        refined_summary: "The text raises a durable question about continuity and meaning.",
        open_questions: ["What would follow if I re-read this with a slower clock?"],
        felt_intensity: 0.6,
      });
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    this.calls.push(input);
    return this.response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}
