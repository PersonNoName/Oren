import { describe, expect, it } from "vitest";
import {
  absorbUserIntoCuriosity,
  formatSeepageWithQuestions,
  injectCuriosityIntents,
  intentHasQuestionAnchor,
  planLacksCuriosity,
} from "../../src/curiosity/helpers.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type LifeState,
  type Thread,
} from "../../src/types.js";

function baseState(threads: Record<string, Thread>): LifeState {
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
    threads,
  };
}

describe("curiosity helpers", () => {
  it("detects question anchors", () => {
    expect(
      intentHasQuestionAnchor({
        kind: "think",
        title: "想清楚：城市为什么这么挤",
        hints: { open_questions: ["城市为什么这么挤"] },
      }),
    ).toBe(true);
    expect(
      intentHasQuestionAnchor({
        kind: "read",
        title: "读未读材料：alpha.md",
      }),
    ).toBe(false);
    expect(
      intentHasQuestionAnchor({
        kind: "read",
        title: "为问题翻：alpha.md",
        hints: { why: "推进：城市为什么这么挤" },
      }),
    ).toBe(true);
  });

  it("flags all-read plans without curiosity", () => {
    expect(
      planLacksCuriosity([
        { kind: "read", title: "读 a" },
        { kind: "read", title: "读 b" },
      ]),
    ).toBe(true);
    expect(
      planLacksCuriosity([
        {
          kind: "think",
          title: "想清楚：X",
          hints: { open_questions: ["X？"] },
        },
        { kind: "idle", title: "歇" },
      ]),
    ).toBe(false);
  });

  it("injects think/note when plan lacks curiosity", () => {
    const th: Thread = {
      id: "th_1",
      title: "城市生活",
      status: "active",
      opened_at: "t",
      last_engaged_at: "t",
      sources: [],
      quotes: [],
      summary: "在想通勤",
      open_questions: ["周末到底怎么过才不空？"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.8,
    };
    const state = baseState({ th_1: th });
    const next = injectCuriosityIntents(
      [
        { kind: "read" as const, title: "读 a.md" },
        { kind: "read" as const, title: "读 b.md" },
      ],
      state,
    );
    expect(next[0]!.kind).toBe("think");
    expect(next.some((i) => i.hints?.mode === "note")).toBe(true);
    expect(planLacksCuriosity(next)).toBe(false);
  });

  it("formats seepage with open questions", () => {
    const t: Thread = {
      id: "th_x",
      title: "人",
      status: "active",
      opened_at: "t",
      last_engaged_at: "t",
      sources: [],
      quotes: [],
      summary: "摘要一句",
      open_questions: ["他们为什么这样聊？"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.5,
    };
    const s = formatSeepageWithQuestions([t], 2);
    expect(s).toContain("他们为什么这样聊");
    expect(s).toContain("th_x");
  });

  it("absorbs substantial user answers into thread", () => {
    const th: Thread = {
      id: "th_1",
      title: "城市",
      status: "active",
      opened_at: "t",
      last_engaged_at: "t",
      sources: [],
      quotes: [],
      summary: "旧摘要",
      open_questions: ["周末到底怎么过才不空？"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.8,
    };
    const r = absorbUserIntoCuriosity({
      threads: { th_1: th },
      seepage: [th],
      userText: "周末我觉得可以去公园散步，不一定要很热闹。",
      now: "2026-07-12T12:00:00.000Z",
    });
    expect(r.absorbed).toBe(true);
    expect(r.threads.th_1!.summary).toContain("用户提到");
  });
});
