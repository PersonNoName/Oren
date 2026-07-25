import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CapabilityInvocationOutcome,
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import { FakeEmbedder } from "@oren/memory";
import { LifeRuntime, recallPinsWithFallback } from "@oren/app";
import type { MemoryEntry, MemoryPort, RecallQuery } from "@oren/memory";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-memory-")), "life.db");
}

function fakeMemoryEntry(memoryId: string, text: string): MemoryEntry {
  return {
    memoryId,
    orenId: "oren-1",
    kind: "user_statement",
    text,
    sourceEventId: `evt-${memoryId}`,
    occurredAt: "2026-07-26T00:00:00.000Z",
    confidence: null,
    reviewCondition: null,
    threadId: null,
    recallability: "active",
  };
}

describe("LifeRuntime memory integration", () => {
  it("projects user messages into recallable memory and survives restart", async () => {
    const databasePath = tempDb();
    const first = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    await first.initialize("oren-1", "person-1");
    await first.receiveUserMessage("oren-1", "person-1", "请读取计数器，把它加一，然后安排一次后续查看。");
    await first.drain();
    const before = await first.recall("oren-1", { limit: 20 });
    expect(before.some(({ kind }) => kind === "user_statement")).toBe(true);
    await first.close();

    const second = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    try {
      const after = await second.recall("oren-1", { limit: 20 });
      expect(after).toEqual(before); // 重启后可召回，且与重启前一致
    } finally {
      await second.close();
    }
  });

  it("exposes memory.recall to cognition and injects memory pins", async () => {
    const databasePath = tempDb();
    const runtime = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "请读取计数器，把它加一，然后安排一次后续查看。");
      await runtime.drain();
      // memory.recall 能力已注册（不需要 grant，走即时通道）
      const entries = await runtime.recall("oren-1", { text: "计数器", limit: 5 });
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it("invokes memory.recall through the capability broker and sees non-empty pins in a later frame", async () => {
    const databasePath = tempDb();
    const capturedFrames: LifeFrame[] = [];
    let recallOutcome: CapabilityInvocationOutcome | undefined;
    const cognition: CognitionPort = {
      async run(
        frame: LifeFrame,
        capabilityPort: CognitionCapabilityPort,
        signal: AbortSignal,
      ): Promise<CognitionOutcome> {
        capturedFrames.push(frame);
        if (capturedFrames.length === 1) {
          return {
            kind: "completed",
            proposals: [{ type: "NoAction", reason: "seed memory" }],
            usage: { totalTokens: 0 },
          };
        }
        const recall = frame.capabilities.find(({ name }) => name === "memory.recall")!;
        recallOutcome = await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: recall,
          arguments: { limit: 5 },
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        }, signal);
        return {
          kind: "completed",
          proposals: [{ type: "NoAction", reason: "recalled via broker" }],
          usage: { totalTokens: 0 },
        };
      },
    };
    const runtime = await LifeRuntime.create(databasePath, cognition, {
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "第一条消息，先入库");
      await runtime.receiveUserMessage("oren-1", "person-1", "第二条消息，触发召回");

      expect(recallOutcome?.kind).toBe("completed");
      if (recallOutcome?.kind === "completed") {
        expect(Array.isArray(recallOutcome.output)).toBe(true);
        expect((recallOutcome.output as readonly unknown[]).length).toBeGreaterThan(0);
      }

      expect(capturedFrames).toHaveLength(2);
      expect(capturedFrames[1]!.memoryPins.length).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it("rebuildMemory from full event history preserves recall equality with incremental projection", async () => {
    const databasePath = tempDb();
    const runtime = await LifeRuntime.createDeterministic(databasePath, {
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "请读取计数器，把它加一，然后安排一次后续查看。");
      await runtime.drain();
      const beforeRebuild = await runtime.recall("oren-1", { limit: 50, includeLowered: true });
      expect(beforeRebuild.length).toBeGreaterThan(0);

      await runtime.rebuildMemory();
      const afterRebuild = await runtime.recall("oren-1", { limit: 50, includeLowered: true });
      expect(afterRebuild).toEqual(beforeRebuild);
    } finally {
      await runtime.close();
    }
  });
});

describe("recallPinsWithFallback", () => {
  function memoryStub(byQuery: (query: RecallQuery) => readonly MemoryEntry[]): MemoryPort {
    return {
      async recall(query) {
        return byQuery(query);
      },
      async project() {},
      async rebuild() {},
      cursor: () => 0,
    };
  }

  it("returns the focused recall untouched when it has results", async () => {
    const focused = [fakeMemoryEntry("m1", "line about the focus")];
    const memory = memoryStub((query) => (query.text === "focus" ? focused : []));
    const pins = await recallPinsWithFallback(memory, "oren-1", "focus");
    expect(pins).toEqual(focused);
  });

  it("falls back to a recency-only recall when the focused recall is empty", async () => {
    const recency = [fakeMemoryEntry("m2", "some other recent memory")];
    const memory = memoryStub((query) => (query.text === undefined ? recency : []));
    const pins = await recallPinsWithFallback(memory, "oren-1", "self-referential focus only");
    expect(pins).toEqual(recency);
  });

  it("does not fall back when there is no focus at all (recall already unfiltered)", async () => {
    let calls = 0;
    const memory = memoryStub(() => {
      calls += 1;
      return [];
    });
    const pins = await recallPinsWithFallback(memory, "oren-1", null);
    expect(pins).toEqual([]);
    expect(calls).toBe(1);
  });
});
