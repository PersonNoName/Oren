import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDashboardSnapshot } from "../../src/dashboard/snapshot.js";
import { LifeStore } from "../../src/store/life-store.js";
import { defaultWill } from "../../src/types.js";
import { saveWill } from "../../src/will/store.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("buildDashboardSnapshot", () => {
  it("loads life meta and empty lists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-dash-"));
    temps.push(home);
    await LifeStore.init(home);
    const snap = await buildDashboardSnapshot(home);
    expect(snap.meta.oren_id).toBeTruthy();
    expect(snap.meta.tick_count).toBe(0);
    expect(snap.threads.active).toEqual([]);
    expect(snap.home).toBe(home);
    expect(snap.monologues).toEqual([]);
    expect(Array.isArray(snap.corpus)).toBe(true);
    expect(snap.taste.values.length).toBeGreaterThan(0);
    expect(snap.product.version).toBeTruthy();
    expect(snap.will).toBeTruthy();
    expect(snap.will?.focus_summary).toBeTruthy();
    expect(snap.will?.posture).toBe("quiet");
    expect(Array.isArray(snap.will?.queue_titles)).toBe(true);
  });

  it("surfaces will summary fields", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-dash-"));
    temps.push(home);
    const store = await LifeStore.init(home);
    const now = new Date().toISOString();
    const will = defaultWill(now);
    will.focus.summary = "继续读 alpha";
    will.toward_user = {
      posture: "engage",
      share_drive: "mid",
      ask_drive: "high",
    };
    will.session.queue = ["i1"];
    will.session.intents = {
      i1: {
        id: "i1",
        kind: "read",
        title: "读 alpha.md",
        status: "pending",
        priority: 1,
        created_at: now,
        source: "plan",
      },
    };
    await saveWill(store, will);
    const snap = await buildDashboardSnapshot(home);
    expect(snap.will).toEqual({
      focus_summary: "继续读 alpha",
      posture: "engage",
      share_drive: "mid",
      ask_drive: "high",
      queue_titles: ["读 alpha.md"],
    });
    // Agenda snapshot is derived from will.session (not a separate loadAgenda).
    expect(snap.agenda?.items).toEqual([
      {
        id: "i1",
        kind: "read",
        title: "读 alpha.md",
        status: "pending",
        blocked_reason: undefined,
        thread_id: undefined,
        due_start: undefined,
        due_end: undefined,
      },
    ]);
  });
});


