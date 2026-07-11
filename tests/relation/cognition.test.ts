import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  absorbDialogueCognition,
  inferReception,
  shareBiasForThread,
} from "../../src/relation/cognition.js";
import { LifeStore } from "../../src/store/life-store.js";
import type { Thread } from "../../src/types.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("relation cognition", () => {
  it("infers cold reception from user text", () => {
    expect(inferReception("whatever, boring", "unknown")).toBe("cold");
    expect(inferReception("tell me more", "unknown")).toBe("warm");
  });

  it("records cold topics and biases share", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-rel-"));
    temps.push(home);
    await LifeStore.init(home);
    const store = new LifeStore(home);
    const thread: Thread = {
      id: "th_1",
      title: "Honesty with the world",
      status: "active",
      opened_at: new Date().toISOString(),
      last_engaged_at: new Date().toISOString(),
      sources: [],
      summary: "about honesty",
      open_questions: [],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.7,
    };
    const rel = await absorbDialogueCognition({
      store,
      userText: "boring, not interested",
      artifact: {
        reply: "ok",
        share: { opened: true, thread_id: "th_1", snippet: "honesty" },
        reception: "cold",
        relation_note: "cold to honesty thread",
      },
      share: { opened: true, thread_id: "th_1", snippet: "honesty" },
      seepage: [thread],
    });
    expect(rel.cold_topics.length).toBeGreaterThan(0);
    expect(shareBiasForThread(rel, thread)).toBe("prefer_closed");
  });
});
