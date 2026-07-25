import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CoreEvent, EventEnvelope } from "@oren/kernel";
import { cosine, FakeEmbedder, SqliteMemoryIndex, type EventRecord } from "@oren/memory";

let counter = 0;
function userMessage(sequence: number, text: string): EventRecord {
  counter += 1;
  const payload: CoreEvent = { type: "UserMessageReceived", personId: "p1", text };
  const envelope: EventEnvelope = {
    eventId: `evt-${counter}`, orenId: "oren-1", schemaVersion: 1,
    occurredAt: "2026-07-20T00:00:00.000Z", recordedAt: "2026-07-20T00:00:00.000Z",
    source: "test", causationId: null, correlationId: "c1", payload,
  };
  return { sequence, envelope };
}

describe("FakeEmbedder", () => {
  it("is deterministic and shape-stable", async () => {
    const embedder = new FakeEmbedder();
    const [first] = await embedder.embed(["城市步行系统"]);
    const [second] = await embedder.embed(["城市步行系统"]);
    expect(first).toEqual(second);
    expect(first!.length).toBe(64);
  });

  it("scores overlapping text closer than unrelated text", async () => {
    const embedder = new FakeEmbedder();
    const [query, related, unrelated] = await embedder.embed([
      "关于演讲的进展",
      "演讲的事有进展",
      "今天的天气很好",
    ]);
    expect(cosine(query!, related!)).toBeGreaterThan(cosine(query!, unrelated!));
  });
});

describe("vector recall", () => {
  it("ranks semantically related entries first with an embedder", async () => {
    const index = new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
      embedder: new FakeEmbedder(),
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    await index.project([
      userMessage(1, "今天的天气很好"),
      userMessage(2, "演讲的事有进展"),
    ]);
    const results = await index.recall({ orenId: "oren-1", text: "关于演讲的进展", limit: 2 });
    expect(results[0]!.text).toBe("演讲的事有进展");
  });

  it("degrades to keyword + recency when no embedder is configured", async () => {
    const index = new SqliteMemoryIndex(new DatabaseSync(":memory:"), {
      now: () => Date.parse("2026-07-26T00:00:00.000Z"),
    });
    await index.project([
      userMessage(1, "今天的天气很好"),
      userMessage(2, "演讲的事有进展"),
    ]);
    const results = await index.recall({ orenId: "oren-1", text: "演讲", limit: 2 });
    expect(results[0]!.text).toBe("演讲的事有进展");
  });
});
