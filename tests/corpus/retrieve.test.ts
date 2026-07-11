import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCorpusIndex } from "../../src/corpus/index.js";
import { planReading } from "../../src/corpus/retrieve.js";
import { defaultConfig, defaultTaste, type Thread } from "../../src/types.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/corpus");

describe("planReading", () => {
  it("continues high-salience thread sources", async () => {
    const index = await buildCorpusIndex(fixtures);
    const alpha = index.docs.find((d) => d.path.includes("alpha"))!;
    const thread: Thread = {
      id: "th_cont",
      title: "continuity",
      status: "active",
      opened_at: new Date().toISOString(),
      last_engaged_at: new Date().toISOString(),
      sources: [{ path: alpha.path, chunk_id: alpha.chunks[0]!.chunk_id }],
      summary: "about continuity",
      open_questions: ["what is continuity?"],
      reading_log: [],
      contemplation_log: [],
      links: { related: [] },
      salience: 0.9,
    };
    const plan = planReading({
      index,
      taste: defaultTaste(new Date().toISOString()),
      threads: { th_cont: thread },
      config: defaultConfig(),
      contemplateOrdinal: 1,
    });
    expect(plan.thread_id).toBe("th_cont");
    expect(plan.items[0]?.reason).toContain("continue-thread:th_cont");
  });

  it("explores on ordinal multiple", async () => {
    const index = await buildCorpusIndex(fixtures);
    const config = defaultConfig();
    config.contemplate.explore_every_n = 5;
    const plan = planReading({
      index,
      taste: defaultTaste(new Date().toISOString()),
      threads: {},
      config,
      contemplateOrdinal: 5,
    });
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items[0]?.reason).toBe("explore");
  });

  it("respects max_chunks", async () => {
    const index = await buildCorpusIndex(fixtures);
    const config = defaultConfig();
    config.contemplate.max_chunks = 1;
    const plan = planReading({
      index,
      taste: defaultTaste(new Date().toISOString()),
      threads: {},
      config,
      contemplateOrdinal: 1,
    });
    expect(plan.items.length).toBeLessThanOrEqual(1);
  });
});
