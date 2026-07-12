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
    expect(r.artifact.share.kind).toBe("read");
    expect(r.artifact.share.source_path).toBe("alpha.md");

    const tail = await readDialogueTail(store, 10);
    expect(tail.filter((t) => t.role === "user").length).toBe(1);
    expect(tail.filter((t) => t.role === "oren").length).toBeGreaterThanOrEqual(1);
    expect(r.orenTurns.length).toBeGreaterThanOrEqual(1);
    expect(r.artifact.utterances.length).toBeGreaterThanOrEqual(1);

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

  it("can write multi-bubble when engaged", async () => {
    const { store } = await homeWithThread();
    const llm = {
      async complete(input: { system: string; user: string }) {
        // First call is Will-turn (intent only; Express also mentions turn_moves)
        if (/意志层/.test(input.system + input.user)) {
          return JSON.stringify({
            turn_moves: ["weave", "acknowledge"],
            share_allowed: false,
            toward_user: {
              posture: "engage",
              share_drive: "low",
              ask_drive: "mid",
            },
            reason: "用户认真投入，跟住并轻织",
          });
        }
        return JSON.stringify({
          utterances: [
            "你说的这点我同意。",
            "我还在想注意力是不是也有不盯死对象的形态。",
            "你要是有空我们可以顺着这个掰两句。",
          ],
          stance: "weave",
          share: { opened: false },
          reception: "warm",
        });
      },
    };
    const r = await sayToOren({
      store,
      text: "我觉得注意力不一定要盯着一个对象，其实挺有意思的因为我也这么感觉",
      llm,
    });
    expect(r.orenTurns).toHaveLength(3);
    expect(r.artifact.stance).toBe("weave");
    expect(r.willTurn?.turn_moves).toContain("weave");
    const tail = await readDialogueTail(store, 10);
    expect(tail.filter((t) => t.role === "oren")).toHaveLength(3);
  });

  it("clamps bubbles when user is curt", async () => {
    const { store } = await homeWithThread();
    const llm = {
      async complete(input: { system: string; user: string }) {
        if (/意志层/.test(input.system + input.user)) {
          return JSON.stringify({
            turn_moves: ["curt", "acknowledge"],
            share_allowed: false,
            toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
            reason: "用户敷衍",
          });
        }
        return JSON.stringify({
          utterances: ["第一句。", "第二句还想说很多。", "第三句也不停。"],
          stance: "lead",
          share: { opened: false },
          reception: "cold",
        });
      },
    };
    const r = await sayToOren({ store, text: "嗯", llm });
    expect(r.orenTurns.length).toBe(1);
    expect(r.artifact.stance).toBe("follow");
    expect(r.willTurn?.turn_moves).toContain("curt");
  });

  it("repairs spoken reply that invents a book", async () => {
    const { store } = await homeWithThread();
    let expressCalls = 0;
    const llm = {
      async complete(input: { system: string; user: string }) {
        if (/意志层/.test(input.system + input.user)) {
          return JSON.stringify({
            turn_moves: ["follow", "acknowledge"],
            share_allowed: false,
            reason: "跟住提问",
          });
        }
        expressCalls += 1;
        if (expressCalls === 1) {
          return JSON.stringify({
            reply: "我最近在看一本草原植物学的老书，草被踩后会拐弯长。",
            share: { opened: false },
            reception: "neutral",
          });
        }
        // repair pass
        return JSON.stringify({
          reply: "在看本地 alpha.md，就几句关于理解与诚实的笔记，没有大部头。",
          share: { opened: false },
          reception: "neutral",
        });
      },
    };
    const r = await sayToOren({
      store,
      text: "你最近在读什么？",
      llm,
    });
    expect(expressCalls).toBeGreaterThanOrEqual(2);
    expect(r.orenTurn.text).toMatch(/alpha\.md/);
    expect(r.orenTurn.text).not.toMatch(/植物学/);
  });
});
