import { describe, expect, it } from "vitest";
import { planOrganize } from "../../src/tick/organize.js";
import { defaultConfig, type Thread } from "../../src/types.js";

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
});
