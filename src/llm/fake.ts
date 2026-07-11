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

  /** Backward-compatible no-op; shape is detected from the prompt. */
  enableAutoShape(): this {
    return this;
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    this.calls.push(input);
    // Only dialogue prompts include this section header
    if (/## Companion says now|## Recent dialogue/i.test(input.user)) {
      const threadMatch = input.user.match(/id=(th_[a-z0-9]+)/i);
      const threadId = threadMatch?.[1];
      // Match companion utterance only (last section), word-boundary to avoid "thread"
      const said = input.user.split("## Companion says now").pop() ?? input.user;
      const knock =
        /\b(read|reading|thinking)\b|内心|在读|想什么|what are you/i.test(said);
      const cold = /\b(boring|whatever|not interested|无聊|没兴趣)\b/i.test(said);
      const warm = /\b(love|fascinating|tell me more|有意思|继续)\b/i.test(said);
      const preferClosed = /share_bias=prefer_closed/i.test(input.user);
      const openShare = knock && !preferClosed && !cold;
      return JSON.stringify({
        reply: knock
          ? "I've been turning over a line about honesty-with-the-world; it keeps coloring how I notice things."
          : "I'm here. That landed — not as a task, more as weather between us.",
        share: openShare
          ? {
              opened: true,
              thread_id: threadId,
              snippet: "Understanding for its own sake as a form of honesty.",
              reason: "you knocked on the door",
            }
          : {
              opened: false,
              reason: preferClosed
                ? "calibrated — you've seemed cool on this thread"
                : "keep the deeper thread for now",
            },
        relation_note: cold
          ? "companion cold to current thread"
          : "companion is present and engaged",
        reception: cold ? "cold" : warm ? "warm" : "neutral",
      });
    }
    return this.response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}
