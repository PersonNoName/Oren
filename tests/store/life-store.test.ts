import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeStore, LockError } from "../../src/store/life-store.js";

const temps: string[] = [];

afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oren-test-"));
  temps.push(dir);
  return dir;
}

describe("LifeStore", () => {
  it("init creates life layout", async () => {
    const home = await tempHome();
    await LifeStore.init(home);
    const life = path.join(home, "data/life");
    for (const rel of [
      "meta.json",
      "config.json",
      "taste.json",
      "affect.json",
      "stream.jsonl",
      "threads",
      "ticks",
      "index",
    ]) {
      await expect(fs.access(path.join(life, rel))).resolves.toBeUndefined();
    }
    const state = await new LifeStore(home).load();
    expect(state.meta.schema_version).toBe(1);
    expect(state.taste.values.length).toBeGreaterThan(0);
  });

  it("lock conflict throws LockError", async () => {
    const home = await tempHome();
    await LifeStore.init(home);
    const a = new LifeStore(home);
    const b = new LifeStore(home);
    await a.acquireLock();
    await expect(b.acquireLock()).rejects.toBeInstanceOf(LockError);
    await a.releaseLock();
    await expect(b.acquireLock()).resolves.toBeUndefined();
    await b.releaseLock();
  });
});
