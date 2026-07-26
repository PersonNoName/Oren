import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { CoreEvent, EventEnvelope } from "@oren/kernel";
import { SqliteMemoryIndex, type EventRecord } from "@oren/memory";

let eventCounter = 0;

function record(
  sequence: number,
  payload: CoreEvent,
  occurredAt = "2026-07-20T00:00:00.000Z",
): EventRecord {
  eventCounter += 1;
  const envelope: EventEnvelope = {
    eventId: `evt-${eventCounter}`,
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt,
    recordedAt: occurredAt,
    source: "test",
    causationId: null,
    correlationId: "corr-1",
    payload,
  };
  return { sequence, envelope };
}

function makeIndex(): SqliteMemoryIndex {
  return new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
    now: () => Date.parse("2026-07-26T00:00:00.000Z"),
  });
}

describe("ObservationRecorded projection", () => {
  beforeEach(() => {
    eventCounter = 0;
  });

  it("projects web_page into external_fact and rebuild matches", async () => {
    const index = makeIndex();
    const records = [
      record(1, {
        type: "ObservationRecorded",
        observationId: "obs-1",
        kind: "web_page",
        sourceUrl: "https://example.com/article",
        title: "示例文章",
        excerpt: "页面摘要内容",
        retrievedAt: "2026-07-20T00:00:00.000Z",
        confidence: 0.85,
      }),
    ];
    await index.project(records);

    const [entry] = await index.recall({
      orenId: "oren-1",
      kinds: ["external_fact"],
    });
    expect(entry).toMatchObject({
      memoryId: "mem:evt-1",
      kind: "external_fact",
      text: "来源观察（示例文章）：页面摘要内容",
      sourceEventId: "evt-1",
      confidence: 0.85,
    });

    await index.rebuild(() => records);
    const rebuilt = await index.recall({
      orenId: "oren-1",
      kinds: ["external_fact"],
    });
    expect(rebuilt).toEqual([entry]);
  });

  it("projects web_search_result with query in text", async () => {
    const index = makeIndex();
    await index.project([
      record(1, {
        type: "ObservationRecorded",
        observationId: "obs-2",
        kind: "web_search_result",
        sourceUrl: "https://example.com/result",
        excerpt: "搜索结果摘要",
        retrievedAt: "2026-07-20T00:00:00.000Z",
        query: "天气",
        confidence: 0.7,
      }),
    ]);

    const [entry] = await index.recall({
      orenId: "oren-1",
      kinds: ["external_fact"],
    });
    expect(entry).toMatchObject({
      memoryId: "mem:evt-1",
      text: "来源观察（搜索「天气」）：搜索结果摘要",
      confidence: 0.7,
    });
  });

  it("falls back to sourceUrl when title is absent", async () => {
    const index = makeIndex();
    await index.project([
      record(1, {
        type: "ObservationRecorded",
        observationId: "obs-3",
        kind: "web_page",
        sourceUrl: "https://example.com/no-title",
        excerpt: "无标题页面",
        retrievedAt: "2026-07-20T00:00:00.000Z",
        confidence: 0.6,
      }),
    ]);

    const [entry] = await index.recall({
      orenId: "oren-1",
      kinds: ["external_fact"],
    });
    expect(entry!.text).toBe(
      "来源观察（https://example.com/no-title）：无标题页面",
    );
  });
});
