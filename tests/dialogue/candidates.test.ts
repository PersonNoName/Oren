import { describe, expect, it } from "vitest";
import {
  collectTalkCandidates,
  formatTalkCandidatesForPrompt,
} from "../../src/dialogue/candidates.js";
import { defaultAgenda, type Intent, type Thread } from "../../src/types.js";

describe("talk candidates", () => {
  it("collects threads and pending say/think from agenda", () => {
    const thread: Thread = {
      id: "th_1",
      title: "注意力",
      status: "active",
      opened_at: "t",
      last_engaged_at: "t",
      sources: [],
      summary: "s",
      open_questions: ["无对象注意？"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.9,
    };
    const say: Intent = {
      id: "in_say",
      kind: "say",
      title: "想打个招呼",
      status: "pending",
      priority: 1,
      created_at: "t",
      source: "plan",
      hints: { why: "独处一阵" },
    };
    const agenda = defaultAgenda("t");
    agenda.queue = [say.id];
    agenda.intents = { [say.id]: say };

    const c = collectTalkCandidates({
      threads: { th_1: thread },
      agenda,
      recentMonologues: ["刚才想到形-场"],
    });
    expect(c.some((x) => x.source === "thread")).toBe(true);
    expect(c.some((x) => x.source === "agenda" && x.intent_id === "in_say")).toBe(true);
    expect(c.some((x) => x.source === "monologue")).toBe(true);
    expect(formatTalkCandidatesForPrompt(c)).toMatch(/线索|计划候选/);
  });
});
