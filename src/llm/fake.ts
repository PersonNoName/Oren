import type { LlmCompleter } from "./types.js";

export class FakeLlmCompleter implements LlmCompleter {
  readonly calls: { system: string; user: string }[] = [];
  private response: string;
  private dialogueMode: boolean;

  constructor(response?: string) {
    this.dialogueMode = false;
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

  /** Next completes use dialogue-shaped JSON if user prompt looks like chat. */
  enableAutoShape(): this {
    this.dialogueMode = true;
    return this;
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    this.calls.push(input);
    if (this.dialogueMode || /Companion says now|## Recent dialogue/i.test(input.user)) {
      const threadMatch = input.user.match(/id=(th_[a-z0-9]+)/i);
      const threadId = threadMatch?.[1];
      // Match companion utterance only (last section), word-boundary to avoid "thread"
      const said = input.user.split("## Companion says now").pop() ?? input.user;
      const knock =
        /\b(read|reading|thinking)\b|内心|在读|想什么|what are you/i.test(said);
      return JSON.stringify({
        reply: knock
          ? "I've been turning over a line about honesty-with-the-world; it keeps coloring how I notice things."
          : "I'm here. That landed — not as a task, more as weather between us.",
        share: knock
          ? {
              opened: true,
              thread_id: threadId,
              snippet: "Understanding for its own sake as a form of honesty.",
              reason: "you knocked on the door",
            }
          : { opened: false, reason: "keep the deeper thread for now" },
        relation_note: "companion is present and engaged",
      });
    }
    return this.response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}
