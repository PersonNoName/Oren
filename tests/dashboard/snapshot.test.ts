import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDashboardSnapshot } from "../../src/dashboard/snapshot.js";
import { LifeStore } from "../../src/store/life-store.js";

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
  });
});

