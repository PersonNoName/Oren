import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { LifeStore } from "../src/store/life-store.js";
import { defaultWill } from "../src/types.js";
import { saveWill } from "../src/will/store.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  it("reports uninitialized home", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-doc-"));
    temps.push(home);
    const r = await runDoctor(home);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/NOT_INITIALIZED/);
  });

  it("reports initialized life", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-doc-"));
    temps.push(home);
    await LifeStore.init(home);
    const r = await runDoctor(home);
    expect(r.lines.join("\n")).toMatch(/life=ok/);
  });

  it("soft-notes missing will.json when life is ok", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-doc-"));
    temps.push(home);
    await LifeStore.init(home);
    const r = await runDoctor(home);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(/will=missing \(soft\)/);
  });

  it("shows focus snippet when will.json is present", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-doc-"));
    temps.push(home);
    const store = await LifeStore.init(home);
    const now = new Date().toISOString();
    const will = defaultWill(now);
    will.focus.summary = "想把语料里的线索串起来";
    will.toward_user.posture = "soft_check";
    await saveWill(store, will);
    const r = await runDoctor(home);
    expect(r.ok).toBe(true);
    const text = r.lines.join("\n");
    expect(text).toMatch(/will=ok/);
    expect(text).toMatch(/想把语料里的线索串起来/);
    expect(text).toMatch(/posture=soft_check/);
  });
});
