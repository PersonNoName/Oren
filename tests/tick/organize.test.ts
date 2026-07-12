import { describe, expect, it } from "vitest";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import {
  buildOrganizePatch,
  parseOrganizeArtifact,
  planOrganize,
} from "../../src/tick/organize.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type LifeState,
  type Thread,
} from "../../src/types.js";

function th(id: string, salience: number): Thread {
  return {
    id,
    title: id,
    status: "active",
    opened_at: new Date().toISOString(),
    last_engaged_at: new Date().toISOString(),
    sources: [],
    summary: "",
    open_questions: [],
    reading_log: [],
    contemplation_log: [],
    links: { related: [] },
    salience,
  };
}

function stateWith(threads: Record<string, Thread>): LifeState {
  const now = new Date().toISOString();
  return {
    meta: {
      oren_id: "o",
      schema_version: 1,
      created_at: now,
      last_tick_at: now,
      tick_count: 1,
    },
    config: defaultConfig(),
    taste: defaultTaste(now),
    affect: defaultAffect(now),
    threads,
  };
}

describe("planOrganize", () => {
  it("dormants excess active threads", () => {
    const config = defaultConfig();
    config.limits.max_active_threads = 2;
    const threads = {
      a: th("a", 0.1),
      b: th("b", 0.2),
      c: th("c", 0.9),
    };
    const r = planOrganize({
      threads,
      config,
      now: new Date().toISOString(),
    });
    expect(r.thread_ops.some((o) => o.op === "dormant")).toBe(true);
    expect(r.thread_ops.length).toBe(1);
  });

  it("soft-dormants stale low-salience threads", () => {
    const config = defaultConfig();
    config.organize.stale_ms = 1000;
    config.organize.dormant_salience_below = 0.2;
    const old = new Date(Date.now() - 60_000).toISOString();
    const threads = {
      a: { ...th("a", 0.1), last_engaged_at: old },
      b: th("b", 0.9),
    };
    const r = planOrganize({
      threads,
      config,
      now: new Date().toISOString(),
    });
    expect(r.thread_ops).toEqual([{ op: "dormant", id: "a" }]);
    expect(r.reason).toBe("soft_dormant_stale");
  });
});

describe("llm organize", () => {
  it("parses organize artifact", () => {
    const a = parseOrganizeArtifact(
      JSON.stringify({
        organize_note: "merged themes",
        ops: [{ op: "update", id: "th_1", summary: "cleaner" }],
      }),
    );
    expect(a.organize_note).toBe("merged themes");
    expect(a.ops[0]).toMatchObject({ op: "update", id: "th_1" });
  });

  it("buildOrganizePatch applies fake llm update", async () => {
    const thread = {
      ...th("th_abc12345", 0.7),
      title: "Attention",
      summary: "old summary",
      open_questions: ["q?"],
    };
    const state = stateWith({ th_abc12345: thread });
    const llm = new FakeLlmCompleter().enableAutoShape();
    const { patch, artifact } = await buildOrganizePatch({
      state,
      llm,
      tickId: "tick_test",
      now: new Date().toISOString(),
    });
    expect(artifact.organize_note.length).toBeGreaterThan(0);
    expect(patch.mode).toBe("organize");
    expect(patch.thread_ops?.some((o) => o.op === "update")).toBe(true);
  });
});

