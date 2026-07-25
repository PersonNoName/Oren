import { describe, expect, it } from "vitest";
import { createInitialLifeState, LifeActor } from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";

describe("loadEventRecordsAfter", () => {
  it("returns canonical envelopes with ascending sequences after a cursor", () => {
    const repository = new SqliteLifeRepository(
      openDatabase(":memory:"),
      () => "2026-07-26T00:00:00.000Z",
    );
    repository.initialize(createInitialLifeState("oren-1", "person-1"));
    const actor = new LifeActor(
      repository,
      (() => { let id = 0; return () => `id-${id += 1}`; })(),
      () => "2026-07-26T00:00:00.000Z",
    );
    actor.handleUserMessage("oren-1", "person-1", "你好");

    const all = repository.loadEventRecordsAfter(0);
    expect(all.length).toBe(2); // UserMessageReceived + CognitionRequested
    expect(all[0]!.sequence).toBeLessThan(all[1]!.sequence);
    expect(all[0]!.envelope.payload.type).toBe("UserMessageReceived");

    const after = repository.loadEventRecordsAfter(all[0]!.sequence);
    expect(after).toHaveLength(1);
    expect(after[0]!.sequence).toBe(all[1]!.sequence);
  });
});
