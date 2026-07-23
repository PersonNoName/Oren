import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("repository recovery", () => {
  it("reclaims an expired outbox lease after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-"));
    const path = join(directory, "life.db");
    const first = new SqliteLifeRepository(openDatabase(path));
    first.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    expect(first.claimOutbox("dead-worker", 1, "2026-07-23T00:00:00.000Z")).toHaveLength(1);
    first.close();

    const second = new SqliteLifeRepository(openDatabase(path));
    expect(second.claimOutbox("live-worker", 1, "2026-07-23T00:10:00.000Z")).toHaveLength(1);
    second.close();
  });
});
