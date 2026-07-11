import { describe, expect, it } from "vitest";
import { integrate } from "../../src/tick/integrate.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type LifeState,
  type Thread,
} from "../../src/types.js";

function baseState(threads: Record<string, Thread> = {}): LifeState {
  const now = new Date().toISOString();
  return {
    meta: {
      oren_id: "x",
      schema_version: 1,
      created_at: now,
      last_tick_at: null,
      tick_count: 0,
    },
    config: defaultConfig(),
    taste: defaultTaste(now),
    affect: defaultAffect(now),
    threads,
  };
}

describe("integrate", () => {
  it("creates and updates threads", () => {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "th1",
      title: "t",
      status: "active",
      opened_at: now,
      last_engaged_at: now,
      sources: [],
      summary: "old",
      open_questions: [],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.5,
    };
    const r = integrate(
      baseState(),
      {
        mode: "contemplate",
        reason: "t",
        thread_ops: [{ op: "create", thread }],
        stream_events: [],
      },
      now,
    );
    expect(r.state.threads.th1?.summary).toBe("old");

    const r2 = integrate(
      r.state,
      {
        mode: "contemplate",
        reason: "t",
        thread_ops: [{ op: "update", id: "th1", fields: { summary: "new" } }],
        stream_events: [],
      },
      now,
    );
    expect(r2.state.threads.th1?.summary).toBe("new");
  });

  it("rejects unknown thread update", () => {
    expect(() =>
      integrate(
        baseState(),
        {
          mode: "organize",
          reason: "x",
          thread_ops: [{ op: "update", id: "nope", fields: {} }],
          stream_events: [],
        },
        new Date().toISOString(),
      ),
    ).toThrow(/unknown thread/);
  });

  it("ignores taste nudges when disabled", () => {
    const state = baseState();
    const before = state.taste.values.length;
    const r = integrate(
      state,
      {
        mode: "contemplate",
        reason: "x",
        taste_ops: [
          { op: "nudge", dimension: "value", statement: "new value", reason: "test" },
        ],
        stream_events: [],
      },
      new Date().toISOString(),
    );
    expect(r.state.taste.values.length).toBe(before);
    expect(r.applied.taste_nudges_applied).toBe(0);
  });
});
