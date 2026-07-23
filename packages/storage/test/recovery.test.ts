import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreEvent } from "@oren/kernel";
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

  it("reclaims an outbox lease when it expires exactly at now", () => {
    const repo = new SqliteLifeRepository(openDatabase(":memory:"));
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });

    expect(repo.claimOutbox("first-worker", 1, "2026-07-23T00:00:00.000Z")).toHaveLength(1);
    expect(repo.claimOutbox("second-worker", 1, "2026-07-23T00:01:00.000Z")).toHaveLength(1);
  });

  it("atomically finishes an effect and creates exactly one terminal inbox item", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(
      db,
      () => "2026-07-23T00:02:00.000Z",
    );
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    repo.claimOutbox("worker-1", 1, "2026-07-23T00:00:00.000Z");
    const payload = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1", nested: { amount: 1 } },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;

    repo.finishEffect("effect-1", "oren-1", "effect-1", payload);
    repo.finishEffect("effect-1", "oren-1", "effect-1", payload);

    const outbox = db.prepare(`
      SELECT status, receipt_json, lease_owner, lease_until FROM outbox WHERE effect_id = ?
    `).get("effect-1");
    const operation = db.prepare(`
      SELECT status, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1");
    const inbox = db.prepare(`
      SELECT inbox_id, oren_id, priority, available_at, payload_json FROM inbox
    `).all();
    expect(outbox).toEqual({
      status: "completed",
      receipt_json: JSON.stringify(payload),
      lease_owner: null,
      lease_until: null,
    });
    expect(operation).toEqual({
      status: "completed",
      receipt_json: JSON.stringify(payload),
    });
    expect(inbox).toEqual([{
      inbox_id: "effect-result:effect-1",
      oren_id: "oren-1",
      priority: 4,
      available_at: "2026-07-23T00:02:00.000Z",
      payload_json: JSON.stringify({ correlationId: "effect-1", event: payload }),
    }]);
  });

  it.each([
    {
      name: "payload effectId",
      effectId: "effect-1",
      orenId: "oren-1",
      correlationId: "effect-1",
      payloadEffectId: "effect-other",
    },
    {
      name: "argument effectId",
      effectId: "effect-other",
      orenId: "oren-1",
      correlationId: "effect-1",
      payloadEffectId: "effect-other",
    },
    {
      name: "Oren identity",
      effectId: "effect-1",
      orenId: "oren-other",
      correlationId: "effect-1",
      payloadEffectId: "effect-1",
    },
    {
      name: "correlation identity",
      effectId: "effect-1",
      orenId: "oren-1",
      correlationId: "corr-other",
      payloadEffectId: "effect-1",
    },
  ])("rejects a mismatched $name without changing durable state", ({
    effectId,
    orenId,
    correlationId,
    payloadEffectId,
  }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const payload = {
      type: "EffectFailed",
      effectId: payloadEffectId,
      code: "DECLINED",
      message: "declined",
    } satisfies Extract<CoreEvent, { type: "EffectFailed" }>;

    expect(() => repo.finishEffect(effectId, orenId, correlationId, payload)).toThrow(/identity|not found/);

    expect(db.prepare(`
      SELECT status, receipt_json FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare(`
      SELECT status, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare("SELECT * FROM inbox").all()).toEqual([]);
  });

  it("rolls back both terminal transitions and creates no inbox item when inbox persistence fails", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    db.exec(`
      CREATE TRIGGER reject_effect_result
      BEFORE INSERT ON inbox
      BEGIN
        SELECT RAISE(ABORT, 'forced inbox failure');
      END
    `);
    const payload = {
      type: "EffectUncertain",
      effectId: "effect-1",
      message: "outcome unknown",
    } satisfies Extract<CoreEvent, { type: "EffectUncertain" }>;

    expect(() => repo.finishEffect("effect-1", "oren-1", "effect-1", payload)).toThrow(
      /forced inbox failure/,
    );

    expect(db.prepare(`
      SELECT status, receipt_json FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare(`
      SELECT status, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare("SELECT * FROM inbox").all()).toEqual([]);
  });

  it("does not overwrite the first terminal result on a later duplicate call", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const completed = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1" },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;
    const failed = {
      type: "EffectFailed",
      effectId: "effect-1",
      code: "LATE",
      message: "late contradictory result",
    } satisfies Extract<CoreEvent, { type: "EffectFailed" }>;

    repo.finishEffect("effect-1", "oren-1", "effect-1", completed);
    repo.finishEffect("effect-1", "oren-1", "effect-1", failed);

    expect(db.prepare(`
      SELECT status, receipt_json FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual({
      status: "completed",
      receipt_json: JSON.stringify(completed),
    });
    expect(db.prepare(`
      SELECT status, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual({
      status: "completed",
      receipt_json: JSON.stringify(completed),
    });
    expect(db.prepare("SELECT payload_json FROM inbox").all()).toEqual([{
      payload_json: JSON.stringify({ correlationId: "effect-1", event: completed }),
    }]);
  });
});
