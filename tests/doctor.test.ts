import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { LifeStore } from "../src/store/life-store.js";

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
});
