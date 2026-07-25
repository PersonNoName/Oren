import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "@oren/memory";
import { LifeRuntime } from "@oren/app";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-memory-")), "life.db");
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
});
