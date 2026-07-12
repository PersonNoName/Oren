// tests/will/tick-will.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import { LifeStore } from "../../src/store/life-store.js";
import { runTick } from "../../src/tick/engine.js";

describe("tick + will", () => {
  let home: string;
  const prevPlanLlm = process.env.OREN_PLAN_LLM;

  afterEach(async () => {
    if (prevPlanLlm === undefined) delete process.env.OREN_PLAN_LLM;
    else process.env.OREN_PLAN_LLM = prevPlanLlm;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("persists will.json after plan tick", async () => {
    process.env.OREN_PLAN_LLM = "fake";
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-tick-will-"));
    const store = await LifeStore.init(home);
    await fs.writeFile(
      path.join(home, "data/corpus/a.md"),
      "# A\nhello\n",
      "utf8",
    );

    const result = await runTick({
      home,
      forceMode: "plan",
      llm: new FakeLlmCompleter(),
    });

    expect(result.exitCode).toBe(0);
    const willRaw = await fs.readFile(store.paths.will, "utf8");
    const will = JSON.parse(willRaw) as { session?: { queue?: unknown } };
    expect(will.session).toBeTruthy();
    expect(Array.isArray(will.session?.queue)).toBe(true);
  });
});
