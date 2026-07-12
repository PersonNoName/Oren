import { describe, expect, it } from "vitest";
import {
  actOnIntent,
  lastProactiveSayAt,
  summarizeDialogueForPlan,
} from "../../src/agenda/act.js";
import { materializeAgenda, parsePlanArtifact } from "../../src/agenda/plan.js";
import { canPlanSay } from "../../src/agenda/schedule.js";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import {
  defaultAffect,
  defaultAgenda,
  defaultConfig,
  defaultTaste,
  type Intent,
  type LifeState,
} from "../../src/types.js";
import type { CorpusIndex } from "../../src/corpus/index.js";

function baseState(): LifeState {
  return {
    meta: {
      oren_id: "o",
      schema_version: 1,
      created_at: "t",
      last_tick_at: null,
      tick_count: 0,
    },
    config: defaultConfig(),
    taste: defaultTaste("t"),
    affect: defaultAffect("t"),
    threads: {},
  };
}

const emptyIndex: CorpusIndex = {
  docs: [],
  updated_at: "t",
};

describe("agenda say (proactive chat)", () => {
  it("parses say kind and chat alias", () => {
    const p = parsePlanArtifact(
      JSON.stringify({
        planning_note: "想开口",
        intents: [
          { kind: "think", title: "先想" },
          { kind: "say", title: "跟你说一声", hints: { why: "有点想分享" } },
          { kind: "chat", title: "别名也应认" },
        ],
      }),
    );
    expect(p.intents.filter((i) => i.kind === "say")).toHaveLength(2);
  });

  it("materialize keeps at most one say and drops when canSay false", () => {
    const state = baseState();
    const parsed = {
      planning_note: "n",
      intents: [
        { kind: "think" as const, title: "a" },
        { kind: "say" as const, title: "s1", hints: { why: "w" } },
        { kind: "say" as const, title: "s2", hints: { why: "w2" } },
        { kind: "idle" as const, title: "rest" },
      ],
    };
    const withSay = materializeAgenda({
      parsed,
      now: "t",
      config: state.config,
      state,
      unreadPaths: [],
      allowSeek: true,
      canSeek: false,
      canSay: true,
    });
    expect(Object.values(withSay.intents).filter((i) => i.kind === "say")).toHaveLength(
      1,
    );

    const noSay = materializeAgenda({
      parsed,
      now: "t",
      config: state.config,
      state,
      unreadPaths: [],
      allowSeek: true,
      canSeek: false,
      canSay: false,
    });
    expect(Object.values(noSay.intents).filter((i) => i.kind === "say")).toHaveLength(0);
  });

  it("canPlanSay respects cooldown", () => {
    const config = defaultConfig();
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(
      canPlanSay({ config, now, lastProactiveSayAt: null }),
    ).toBe(true);
    expect(
      canPlanSay({
        config,
        now,
        lastProactiveSayAt: "2026-07-12T10:00:00.000Z", // 2h ago < 4h
      }),
    ).toBe(false);
    expect(
      canPlanSay({
        config,
        now,
        lastProactiveSayAt: "2026-07-12T07:00:00.000Z", // 5h ago
      }),
    ).toBe(true);
  });

  it("lastProactiveSayAt reads dialogue and done intents", () => {
    const agenda = defaultAgenda("t");
    const say: Intent = {
      id: "in_s",
      kind: "say",
      title: "s",
      status: "done",
      priority: 1,
      created_at: "t",
      source: "plan",
      outcome: { at: "2026-07-12T08:00:00.000Z", summary: "hi" },
    };
    agenda.intents[say.id] = say;
    expect(
      lastProactiveSayAt(
        [
          {
            id: "d1",
            ts: "2026-07-12T09:00:00.000Z",
            role: "oren",
            text: "yo",
            proactive: true,
          },
        ],
        agenda,
      ),
    ).toBe("2026-07-12T09:00:00.000Z");
  });

  it("act say produces proactive dialogue artifact", async () => {
    const state = baseState();
    const intent: Intent = {
      id: "in_say",
      kind: "say",
      title: "想轻轻跟你打个招呼",
      status: "pending",
      priority: 0.5,
      created_at: "t",
      source: "plan",
      hints: { why: "独处一阵了" },
    };
    const agenda = defaultAgenda("t");
    agenda.queue = [intent.id];
    agenda.intents = { [intent.id]: intent };

    const llm = new FakeLlmCompleter().enableAutoShape();
    const result = await actOnIntent({
      intent,
      agenda,
      state,
      index: emptyIndex,
      llm,
      tickId: "tick_test",
      now: "2026-07-12T12:00:00.000Z",
      dialogueTail: [],
    });

    expect(result.intent.status).toBe("done");
    expect(result.patch.reason).toMatch(/act:say/);
    const events = result.patch.stream_events ?? [];
    expect(events.some((e) => e.type === "oren_reply")).toBe(true);
    const art = result.artifact as { reply?: string; turn?: { proactive?: boolean } };
    expect(art.reply?.length).toBeGreaterThan(0);
    expect(art.turn?.proactive).toBe(true);
  });

  it("summarizeDialogueForPlan marks proactive", () => {
    const s = summarizeDialogueForPlan([
      { id: "1", ts: "t", role: "user", text: "hi" },
      { id: "2", ts: "t", role: "oren", text: "yo", proactive: true },
    ]);
    expect(s).toContain("Oren(主动)");
    expect(s).toContain("用户");
  });
});
