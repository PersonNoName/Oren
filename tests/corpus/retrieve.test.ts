import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCorpusIndex } from "../../src/corpus/index.js";
import { planReading } from "../../src/corpus/retrieve.js";
import { defaultConfig, defaultTaste, type Thread } from "../../src/types.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/corpus");

function baseThread(partial: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    id: "th_cont",
    title: "continuity",
    status: "active",
    opened_at: now,
    last_engaged_at: now,
    sources: [],
    summary: "about continuity",
    open_questions: ["what is continuity?"],
    reading_log: [],
    contemplation_log: [],
    links: { related: [] },
    salience: 0.9,
    ...partial,
  };
}

describe("planReading", () => {
  it("prefers unread chunks for an active thread", async () => {
    const index = await buildCorpusIndex(fixtures);
    const alpha = index.docs.find((d) => d.path.includes("alpha"))!;
    const thread = baseThread({
      sources: [{ path: alpha.path, chunk_id: alpha.chunks[0]!.chunk_id }],
    });
    const plan = planReading({
      index,
      taste: defaultTaste(new Date().toISOString()),
      threads: { th_cont: thread },
      config: defaultConfig(),
      contemplateOrdinal: 1,
    });
    expect(plan.kind).toBe("read");
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items[0]?.prior_reads ?? 0).toBe(0);
    expect(plan.items[0]?.reason).toMatch(/unread|continue-unread|explore-unread/);
  });

  it("switches to pure think when everything was already read", async () => {
    const index = await buildCorpusIndex(fixtures);
    const log = index.docs.flatMap((d) =>
      d.chunks.map((c) => ({
        at: new Date().toISOString(),
        path: d.path,
        chunk_id: c.chunk_id,
      })),
    );
    const thread = baseThread({
      sources: log.map((e) => ({ path: e.path, chunk_id: e.chunk_id })),
      reading_log: log,
      quotes: log.slice(0, 2).map((e) => ({
        text: "already internalized",
        path: e.path,
        chunk_id: e.chunk_id,
        at: e.at,
      })),
    });
    const plan = planReading({
      index,
      taste: defaultTaste(new Date().toISOString()),
      threads: { th_cont: thread },
      config: defaultConfig(),
      contemplateOrdinal: 2,
    });
    expect(plan.kind).toBe("think");
    expect(plan.items).toHaveLength(0);
    expect(plan.thread_id).toBe("th_cont");
    expect(plan.intent).toMatch(/think/);
  });

  it("explores unread on ordinal multiple", async () => {
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
    expect(plan.kind).toBe("read");
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.items[0]?.reason).toMatch(/explore/);
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
