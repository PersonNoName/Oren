import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDemo } from "../src/demo.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("runDemo", () => {
  it("seeds life and runs warm ticks without serving", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-demo-"));
    temps.push(home);
    process.env.OREN_TICK_LLM = "fake";
    process.env.OREN_SAY_LLM = "fake";
    const result = await runDemo({ home, port: 8791, serve: false });
    expect(result.home).toBe(home);
    const meta = JSON.parse(
      await fs.readFile(path.join(home, "data/life/meta.json"), "utf8"),
    ) as { tick_count: number };
    expect(meta.tick_count).toBeGreaterThanOrEqual(2);
  });
});
