import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sayToOren } from "../../src/dialogue/reply.js";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import { LifeStore } from "../../src/store/life-store.js";
import type { Thread } from "../../src/types.js";
import { loadWill } from "../../src/will/store.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

async function homeWithThread(): Promise<{ home: string; store: LifeStore }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-say-will-"));
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
    quotes: [
      {
        text: "Understanding things for their own sake is a form of honesty with the world.",
        path: "alpha.md",
        chunk_id: "alpha.md#0",
        at: now,
      },
    ],
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

describe("sayToOren will spine", () => {
  it("does not open share when will-turn disallows (curt 嗯)", async () => {
    const { store, home } = await homeWithThread();
    const llm = new FakeLlmCompleter().enableAutoShape();
    const result = await sayToOren({ store, text: "嗯", llm });

    expect(result.artifact.share.opened).toBe(false);
    expect(result.willTurn?.turn_moves).toEqual(["curt", "acknowledge"]);
    expect(result.willTurn?.share_allowed).toBe(false);
    expect(result.orenTurns.length).toBe(1);

    const nowIso = new Date().toISOString();
    const will = await loadWill(store, nowIso);
    expect(will.toward_user).toBeTruthy();
    expect(will.toward_user.posture).toBe("quiet");

    const willPath = path.join(home, "data/life/will.json");
    await expect(fs.access(willPath)).resolves.toBeUndefined();

    const stream = await store.readStreamTail(30);
    expect(stream.some((e) => e.type === "will_turn")).toBe(true);
    expect(stream.some((e) => e.type === "expressed")).toBe(true);
    expect(stream.some((e) => e.type === "oren_reply")).toBe(true);

    // Will-turn then Express = at least 2 LLM calls
    expect(llm.callCount).toBeGreaterThanOrEqual(2);
  });

  it("writes will.json and freezes follow moves for normal chat", async () => {
    const { store, home } = await homeWithThread();
    const llm = new FakeLlmCompleter().enableAutoShape();
    const r = await sayToOren({
      store,
      text: "今天想聊聊注意力的事",
      llm,
    });

    expect(r.artifact.share.opened).toBe(false);
    expect(r.willTurn?.turn_moves).toEqual(["follow", "acknowledge"]);
    expect(r.willTurn?.share_allowed).toBe(false);

    const will = await loadWill(store, new Date().toISOString());
    expect(will.last_reason).toBeTruthy();
    const raw = await fs.readFile(path.join(home, "data/life/will.json"), "utf8");
    expect(JSON.parse(raw).toward_user).toBeTruthy();
  });
});
