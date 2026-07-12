import { describe, expect, it } from "vitest";
import { canPlanSay, decideAgendaTick } from "../../src/agenda/schedule.js";
import { defaultAgenda, defaultConfig, type Intent } from "../../src/types.js";

function intent(partial: Partial<Intent> & Pick<Intent, "id" | "kind" | "title">): Intent {
  return {
    status: "pending",
    priority: 0.5,
    created_at: new Date().toISOString(),
    source: "plan",
    ...partial,
  };
}

describe("decideAgendaTick", () => {
  it("pauses when user recently present", () => {
    const now = new Date();
    const agenda = defaultAgenda(now.toISOString());
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: new Date(now.getTime() - 30_000).toISOString(),
    });
    expect(d.action).toBe("idle_user_present");
  });

  it("plans when queue empty and user away", () => {
    const now = new Date();
    const agenda = defaultAgenda(now.toISOString());
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    expect(d.action).toBe("plan");
  });

  it("acts next pending when available", () => {
    const now = new Date();
    const it = intent({ id: "in_1", kind: "think", title: "t" });
    const agenda = defaultAgenda(now.toISOString());
    agenda.queue = [it.id];
    agenda.intents = { [it.id]: it };
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: null,
    });
    expect(d.action).toBe("act");
    if (d.action === "act") expect(d.intent.id).toBe("in_1");
  });

  it("acts pending say like other intents", () => {
    const now = new Date();
    const it = intent({ id: "in_say", kind: "say", title: "聊一句" });
    const agenda = defaultAgenda(now.toISOString());
    agenda.queue = [it.id];
    agenda.intents = { [it.id]: it };
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: null,
    });
    expect(d.action).toBe("act");
    if (d.action === "act") expect(d.intent.kind).toBe("say");
  });

  it("canPlanSay default true with no history", () => {
    expect(
      canPlanSay({
        config: defaultConfig(),
        now: new Date(),
        lastProactiveSayAt: null,
      }),
    ).toBe(true);
  });
});
