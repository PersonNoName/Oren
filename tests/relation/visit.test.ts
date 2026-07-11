import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAbsence, recordVisit } from "../../src/relation/visit.js";
import { LifeStore } from "../../src/store/life-store.js";
import { defaultAffect } from "../../src/types.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("recordVisit", () => {
  it("updates affect and stream", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-visit-"));
    temps.push(home);
    await LifeStore.init(home);
    const store = new LifeStore(home);
    const r = await recordVisit(store, { note: "hello briefly" });
    expect(r.affect.absence.visit_count).toBe(1);
    expect(r.affect.absence.last_note).toBe("hello briefly");
    expect(r.affect.absence.last_user_contact_at).toBeTruthy();

    const state = await store.load();
    expect(state.affect.absence.visit_count).toBe(1);
    const tail = await store.readStreamTail(5);
    expect(tail.some((e) => e.type === "user_visit")).toBe(true);

    const line = describeAbsence(state.affect);
    expect(line).toMatch(/到访|片刻|小时|天/);
  });

  it("describeAbsence with no visits", () => {
    const a = defaultAffect(new Date().toISOString());
    expect(describeAbsence(a)).toMatch(/尚未记录到访/);
  });
});
