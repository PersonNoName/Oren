import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

describe("SqliteMemoryIndex projection", () => {
  it("projects user messages, expressions, and thread advances", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "UserMessageReceived", personId: "p1", text: "我在准备一场演讲" }),
      record(2, {
        type: "CognitionCompleted",
        episodeId: "ep1",
        baseStateVersion: 1,
        proposals: [
          { type: "ExpressToUser", text: "听起来很重要，主题是什么？", reason: "回应" },
          { type: "NoAction", reason: "-" },
        ],
      }),
      record(3, { type: "ThreadAdvanced", threadId: "t1", summary: "了解演讲主题" }),
    ]);
    const entries = await index.recall({ orenId: "oren-1", limit: 10 });
    expect(entries).toHaveLength(3);
    expect(entries.map(({ kind }) => kind).sort()).toEqual(
      ["oren_expression", "oren_judgment", "user_statement"],
    );
    expect(index.cursor()).toBe(3);
  });

  it("projects explicit memory events and applies revise/forget", async () => {
    const index = makeIndex();
    await index.project([
      record(1, {
        type: "MemoryRemembered", memoryId: "m1", kind: "oren_judgment",
        text: "判断：用户可能换工作", confidence: 0.7,
      }),
    ]);
    await index.project([
      record(2, {
        type: "BeliefRevised", memoryId: "m1", confidence: 0.1,
        revisedText: "判断已修订：用户决定留下", reason: "用户明确表态",
      }),
    ]);
    const [revised] = await index.recall({ orenId: "oren-1" });
    expect(revised).toMatchObject({
      memoryId: "m1", text: "判断已修订：用户决定留下", confidence: 0.1,
    });

    await index.project([
      record(3, { type: "MemoryForgotten", memoryId: "m1", reason: "已过时" }),
    ]);
    expect(await index.recall({ orenId: "oren-1" })).toHaveLength(0);
    const lowered = await index.recall({ orenId: "oren-1", includeLowered: true });
    expect(lowered[0]).toMatchObject({ memoryId: "m1", recallability: "lowered" });
  });

  it("skips revise/forget referencing unknown memoryId without throwing", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "BeliefRevised", memoryId: "ghost", confidence: 0.5, reason: "r" }),
      record(2, { type: "MemoryForgotten", memoryId: "ghost", reason: "r" }),
    ]);
    expect(await index.recall({ orenId: "oren-1", includeLowered: true })).toHaveLength(0);
    expect(index.cursor()).toBe(2);
  });

  it("filters by kind, thread, time range, and honors limit + keyword", async () => {
    const index = makeIndex();
    await index.project([
      record(1, { type: "UserMessageReceived", personId: "p1", text: "聊聊天气" },
        "2026-07-01T00:00:00.000Z"),
      record(2, { type: "UserMessageReceived", personId: "p1", text: "演讲的事有进展" },
        "2026-07-20T00:00:00.000Z"),
      record(3, { type: "ThreadAdvanced", threadId: "talk", summary: "演讲准备" },
        "2026-07-21T00:00:00.000Z"),
    ]);
    expect(await index.recall({ orenId: "oren-1", kinds: ["user_statement"] }))
      .toHaveLength(2);
    expect(await index.recall({ orenId: "oren-1", threadId: "talk" })).toHaveLength(1);
    expect(await index.recall({ orenId: "oren-1", since: "2026-07-10T00:00:00.000Z" }))
      .toHaveLength(2);
    const byKeyword = await index.recall({ orenId: "oren-1", text: "演讲", limit: 1 });
    expect(byKeyword).toHaveLength(1);
    expect(byKeyword[0]!.text).toContain("演讲");
  });

  it("is idempotent per sequence and rebuild matches incremental projection", async () => {
    const index = makeIndex();
    const records = [
      record(1, { type: "UserMessageReceived", personId: "p1", text: "第一条" }),
      record(2, {
        type: "MemoryRemembered", memoryId: "m1", kind: "external_fact", text: "事实一",
      }),
      record(3, { type: "MemoryForgotten", memoryId: "m1", reason: "r" }),
    ];
    await index.project(records);
    await index.project(records); // 重复投影不重复写
    const incremental = await index.recall({ orenId: "oren-1", includeLowered: true });

    await index.rebuild(() => records);
    const rebuilt = await index.recall({ orenId: "oren-1", includeLowered: true });
    expect(rebuilt).toEqual(incremental);
    expect(index.cursor()).toBe(3);
  });
});
