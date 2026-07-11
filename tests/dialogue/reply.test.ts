import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sayToOren } from "../../src/dialogue/reply.js";
import { readDialogueTail } from "../../src/dialogue/store.js";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import { LifeStore } from "../../src/store/life-store.js";
import type { Thread } from "../../src/types.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

async function homeWithThread(): Promise<{ home: string; store: LifeStore }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-say-"));
  temps.push(home);
  await LifeStore.init(home);
  const store = new LifeStore(home);
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "th_abc12345",
    title: "Honesty with the world",
    status: "active",
    opened_at: now,
    last_engaged_at: now,
    sources: [{ path: "alpha.md" }],
    summary: "Understanding for its own sake.",
    open_questions: ["What is honesty here?"],
    reading_log: [],
    contemplation_log: [],
    links: { related: [] },
    salience: 0.8,
  };
  await store.saveThread(thread);
  return { home, store };
}

describe("sayToOren", () => {
  it("records dialogue and can open share on knock", async () => {
    const { store } = await homeWithThread();
    const llm = new FakeLlmCompleter().enableAutoShape();
    const r = await sayToOren({
      store,
      text: "what are you reading lately?",
      llm,
    });
    expect(r.orenTurn.text.length).toBeGreaterThan(5);
    expect(r.artifact.share.opened).toBe(true);
    expect(r.artifact.share.thread_id).toBe("th_abc12345");

    const tail = await readDialogueTail(store, 10);
    expect(tail.filter((t) => t.role === "user").length).toBe(1);
    expect(tail.filter((t) => t.role === "oren").length).toBe(1);

    const stream = await store.readStreamTail(20);
    expect(stream.some((e) => e.type === "user_message")).toBe(true);
    expect(stream.some((e) => e.type === "oren_reply")).toBe(true);
    expect(stream.some((e) => e.type === "inner_share")).toBe(true);

    const state = await store.load();
    expect(state.affect.absence.visit_count).toBeGreaterThanOrEqual(1);
  });

  it("may keep gate closed on casual hello", async () => {
    const { store } = await homeWithThread();
    const llm = new FakeLlmCompleter().enableAutoShape();
    const r = await sayToOren({ store, text: "hey, just saying hi", llm });
    expect(r.orenTurn.text.length).toBeGreaterThan(0);
    expect(r.artifact.share.opened).toBe(false);
  });
});
