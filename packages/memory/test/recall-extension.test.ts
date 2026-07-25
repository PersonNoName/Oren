import { describe, expect, it } from "vitest";
import { isImmediateCapability } from "@oren/kernel";
import {
  createMemoryRecallExtension,
  type MemoryEntry,
  type RecallQuery,
} from "@oren/memory";

const ENTRY: MemoryEntry = {
  memoryId: "m1", orenId: "oren-1", kind: "user_statement",
  text: "我在准备演讲", sourceEventId: "e1",
  occurredAt: "2026-07-20T00:00:00.000Z",
  confidence: null, reviewCondition: null, threadId: null, recallability: "active",
};

function makeExtension(queries: RecallQuery[]) {
  return createMemoryRecallExtension({
    project: async () => {},
    rebuild: async () => {},
    cursor: () => 0,
    recall: async (query) => { queries.push(query); return [ENTRY]; },
  });
}

describe("createMemoryRecallExtension", () => {
  it("exposes memory.recall as an immediate capability without grants", () => {
    const extension = makeExtension([]);
    const [descriptor] = extension.manifest.capabilities;
    expect(descriptor!.name).toBe("memory.recall");
    expect(descriptor!.permissionRequirements).toEqual([]);
    expect(isImmediateCapability(descriptor!)).toBe(true);
  });

  it("parses arguments into a RecallQuery scoped to the invoking oren", async () => {
    const queries: RecallQuery[] = [];
    const extension = makeExtension(queries);
    const result = await extension.invoke({
      effectId: "ef1", orenId: "oren-1", capability: "memory.recall",
      arguments: { text: "演讲", kinds: ["user_statement"], limit: 3 },
      grantIds: [], stateVersion: 1, deadline: "2026-07-26T00:00:01.000Z",
    }, new AbortController().signal);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual([expect.objectContaining({ memoryId: "m1" })]);
    }
    expect(queries[0]).toMatchObject({
      orenId: "oren-1", text: "演讲", kinds: ["user_statement"], limit: 3,
    });
  });

  it("rejects malformed arguments instead of throwing", async () => {
    const extension = makeExtension([]);
    const result = await extension.invoke({
      effectId: "ef1", orenId: "oren-1", capability: "memory.recall",
      arguments: { kinds: ["diary"] },
      grantIds: [], stateVersion: 1, deadline: "2026-07-26T00:00:01.000Z",
    }, new AbortController().signal);
    expect(result.status).toBe("failed");
  });
});
