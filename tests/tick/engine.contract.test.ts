import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import { corpusDir } from "../../src/paths.js";
import { LifeStore } from "../../src/store/life-store.js";
import { hashCorpusTree, runTick } from "../../src/tick/engine.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/corpus");
const temps: string[] = [];

afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

async function setupHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-eng-"));
  temps.push(home);
  await LifeStore.init(home);
  const store = new LifeStore(home);
  const state = await store.load();
  const cDir = corpusDir(home, state.config);
  await fs.mkdir(cDir, { recursive: true });
  for (const name of ["alpha.md", "beta.md"]) {
    await fs.copyFile(path.join(fixtures, name), path.join(cDir, name));
  }
  return home;
}

describe("runTick contract", () => {
  it("idle writes presence without llm", async () => {
    const home = await setupHome();
    const llm = new FakeLlmCompleter();
    const r = await runTick({ home, forceMode: "idle", llm });
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("idle");
    expect(llm.callCount).toBe(0);
    const tail = await new LifeStore(home).readStreamTail(20);
    expect(tail.some((e) => e.type === "presence_blank")).toBe(true);
  });

  it("contemplate creates thread and preserves corpus", async () => {
    const home = await setupHome();
    const store = new LifeStore(home);
    const state = await store.load();
    const cDir = corpusDir(home, state.config);
    const before = await hashCorpusTree(cDir);

    const llm = new FakeLlmCompleter();
    const r = await runTick({ home, forceMode: "contemplate", llm });
    expect(r.exitCode).toBe(0);
    expect(r.mode).toBe("contemplate");
    expect(llm.callCount).toBeGreaterThanOrEqual(1);

    const afterState = await store.load();
    expect(Object.keys(afterState.threads).length).toBeGreaterThan(0);
    const tail = await store.readStreamTail(50);
    expect(tail.some((e) => e.type === "thought_written")).toBe(true);
    expect(tail.some((e) => e.type === "corpus_read")).toBe(true);

    const snapPath = path.join(home, "data/life/ticks", `${r.tickId}.json`);
    const snap = JSON.parse(await fs.readFile(snapPath, "utf8")) as {
      reading_plan: { items: { reason: string }[] };
      applied_patch: unknown;
    };
    expect(snap.reading_plan.items[0]?.reason).toBeTruthy();
    expect(snap.applied_patch).toBeTruthy();

    const after = await hashCorpusTree(cDir);
    expect(after).toBe(before);
  });

  it("lock conflict returns exit 2", async () => {
    const home = await setupHome();
    const holder = new LifeStore(home);
    await holder.acquireLock();
    const r = await runTick({ home, forceMode: "idle", llm: new FakeLlmCompleter() });
    expect(r.exitCode).toBe(2);
    await holder.releaseLock();
  });
});
