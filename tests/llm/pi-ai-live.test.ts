import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiAiCompleter } from "../../src/llm/pi-ai.js";
import { corpusDir } from "../../src/paths.js";
import { LifeStore } from "../../src/store/life-store.js";
import { runTick } from "../../src/tick/engine.js";

const live = process.env.OREN_LIVE_LLM === "1";
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/corpus");

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe.runIf(live)("pi-ai live", () => {
  it("completes and contemplates via pi-ai", async () => {
    const completer = new PiAiCompleter(
      process.env.OREN_MODEL?.trim() || "anthropic:claude-sonnet-4-5",
    );
    const raw = await completer.complete({
      system: 'Return only JSON: {"monologue":"...","refined_summary":"...","open_questions":["..."]}',
      user: "One sentence monologue about libraries. JSON only.",
    });
    expect(raw.length).toBeGreaterThan(10);

    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-live-"));
    temps.push(home);
    await LifeStore.init(home);
    const store = new LifeStore(home);
    const state = await store.load();
    const cDir = corpusDir(home, state.config);
    await fs.mkdir(cDir, { recursive: true });
    await fs.copyFile(path.join(fixtures, "alpha.md"), path.join(cDir, "alpha.md"));

    const result = await runTick({
      home,
      forceMode: "contemplate",
      llm: completer,
    });
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe("contemplate");
    const tail = await store.readStreamTail(30);
    expect(tail.some((e) => e.type === "thought_written")).toBe(true);
    const after = await store.load();
    expect(Object.keys(after.threads).length).toBeGreaterThan(0);
  }, 120_000);
});
