// tests/will/store.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LifeStore } from "../../src/store/life-store.js";
import { saveAgenda } from "../../src/agenda/store.js";
import { loadWill, saveWill, synthesizeWillFromLife } from "../../src/will/store.js";
import { defaultAgenda, defaultWill } from "../../src/types.js";

describe("WillStore", () => {
  let home: string;
  let store: LifeStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-will-"));
    store = await LifeStore.init(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("synthesizes from agenda when will.json missing", async () => {
    const now = "2026-07-12T12:00:00.000Z";
    const ag = defaultAgenda(now);
    ag.planning_note = "读一点再想";
    ag.queue = ["i1"];
    ag.intents = {
      i1: {
        id: "i1",
        kind: "think",
        title: "想问题",
        status: "pending",
        priority: 1,
        created_at: now,
        source: "plan",
      },
    };
    await saveAgenda(store, ag);

    const will = await loadWill(store, now);
    expect(will.session.queue).toEqual(["i1"]);
    expect(will.session.planning_note).toBe("读一点再想");
  });

  it("round-trips save/load", async () => {
    const now = "2026-07-12T12:00:00.000Z";
    const w = defaultWill(now);
    w.focus.summary = "在啃 alpha";
    await saveWill(store, w);
    const loaded = await loadWill(store, now);
    expect(loaded.focus.summary).toBe("在啃 alpha");
  });
});
