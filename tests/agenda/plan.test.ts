import { describe, expect, it } from "vitest";
import {
  materializeAgenda,
  parsePlanArtifact,
  ruleFallbackIntents,
} from "../../src/agenda/plan.js";
import { planLacksCuriosity } from "../../src/curiosity/helpers.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type LifeState,
  type Thread,
} from "../../src/types.js";

describe("agenda plan", () => {
  it("parses plan JSON including think mode", () => {
    const p = parsePlanArtifact(
      JSON.stringify({
        planning_note: "想搞懂通勤",
        intents: [
          {
            kind: "think",
            title: "随手记",
            hints: { mode: "note", why: "主动笔记" },
          },
          { kind: "seek", title: "look up X", hints: { query: "X" } },
        ],
      }),
    );
    expect(p.intents).toHaveLength(2);
    expect(p.intents[0]!.hints?.mode).toBe("note");
    expect(p.intents[1]!.kind).toBe("seek");
  });

  it("allows zero-read plans with think anchors", () => {
    const p = parsePlanArtifact(
      JSON.stringify({
        planning_note: "只想问题，不读库",
        intents: [
          {
            kind: "think",
            title: "想清楚：为何空",
            hints: { open_questions: ["为何空？"], mode: "ruminate" },
          },
          {
            kind: "think",
            title: "记一笔",
            hints: { mode: "note", why: "笔记" },
          },
          { kind: "idle", title: "歇" },
        ],
      }),
    );
    expect(p.intents.every((i) => i.kind !== "read")).toBe(true);
    expect(planLacksCuriosity(p.intents)).toBe(false);
  });

  it("rule fallback prefers questions over unread-only", () => {
    const th: Thread = {
      id: "th_q",
      title: "生活",
      status: "active",
      opened_at: "t",
      last_engaged_at: "t",
      sources: [],
      quotes: [],
      summary: "s",
      open_questions: ["我真正想过怎样的周末？"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.9,
    };
    const state: LifeState = {
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
      threads: { th_q: th },
    };
    const fb = ruleFallbackIntents(state, ["x.md"], "t", 3);
    expect(fb[0]!.kind).toBe("think");
    expect(fb.some((i) => i.hints?.mode === "note")).toBe(true);
  });

  it("blocks seek when not authorized", () => {
    const state: LifeState = {
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
    const agenda = materializeAgenda({
      parsed: {
        planning_note: "n",
        intents: [
          { kind: "think", title: "a" },
          { kind: "seek", title: "b", hints: { query: "q" } },
          { kind: "idle", title: "c" },
        ],
      },
      now: "t",
      config: state.config,
      state,
      unreadPaths: [],
      allowSeek: true,
      canSeek: false,
    });
    const seek = Object.values(agenda.intents).find((i) => i.kind === "seek");
    expect(seek?.status).toBe("blocked");
    expect(seek?.blocked_reason).toBe("seek_not_authorized");
  });
});
