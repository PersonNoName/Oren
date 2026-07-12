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

  it("acts before replan even when actions_since_plan is high", () => {
    const now = new Date();
    const it = intent({ id: "in_2", kind: "think", title: "keep going" });
    const agenda = defaultAgenda(now.toISOString());
    agenda.queue = [it.id];
    agenda.intents = { [it.id]: it };
    agenda.actions_since_plan = 99;
    agenda.planning_note = "旧计划";
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: null,
    });
    expect(d.action).toBe("act");
    if (d.action === "act") expect(d.intent.id).toBe("in_2");
  });

  it("idle_light when fresh plan has no actionable work", () => {
    const now = new Date();
    const blocked = intent({
      id: "in_s",
      kind: "seek",
      title: "以后查",
      status: "blocked",
      blocked_reason: "seek_not_authorized",
    });
    const agenda = defaultAgenda(now.toISOString());
    agenda.created_at = now.toISOString();
    agenda.planning_note = "刚排完：先记下想查的";
    agenda.queue = [blocked.id];
    agenda.intents = { [blocked.id]: blocked };
    agenda.actions_since_plan = 0;
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now: new Date(now.getTime() + 60_000),
      lastUserContactAt: null,
    });
    expect(d.action).toBe("idle_light");
  });

  it("plans after replan gap when still no actionable", () => {
    const now = new Date();
    const agenda = defaultAgenda(now.toISOString());
    agenda.created_at = new Date(now.getTime() - 25 * 60_000).toISOString();
    agenda.planning_note = "旧计划";
    agenda.actions_since_plan = 0;
    const d = decideAgendaTick({
      agenda,
      config: defaultConfig(),
      now,
      lastUserContactAt: null,
    });
    expect(d.action).toBe("plan");
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
