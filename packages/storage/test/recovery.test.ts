import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreEvent } from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("repository recovery", () => {
  it.each([
    { name: "syntactically malformed", effectJson: "{" },
    {
      name: "structurally malformed",
      effectJson: JSON.stringify({
        effectId: "effect-corrupt",
        orenId: "oren-1",
        correlationId: "effect-corrupt",
        capability: "test.increment",
        arguments: { by: Number.NaN },
        grantIds: "grant-1",
        stateVersion: 0,
      }),
    },
  ])("quarantines $name effect JSON and claims a valid later row", ({ effectJson }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-corrupt", "test.increment", { by: 1 });
    repo.enqueueRawEffect("oren-1", "effect-valid", "test.increment", { by: 2 });
    db.prepare("UPDATE outbox SET effect_json = ? WHERE effect_id = ?")
      .run(effectJson, "effect-corrupt");

    expect(repo.claimOutbox("worker-1", 1, "2026-07-23T00:00:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 1 },
    ]);
    expect(repo.claimOutbox("worker-2", 1, "2026-07-23T00:02:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 2 },
    ]);
    expect(db.prepare(`
      SELECT status, attempts, lease_owner FROM outbox WHERE effect_id = ?
    `).get("effect-corrupt")).toEqual({
      status: "pending",
      attempts: 0,
      lease_owner: null,
    });
  });

  it.each([
    {
      name: "missing operation",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("DELETE FROM operations WHERE effect_id = ?").run("effect-corrupt");
      },
    },
    {
      name: "mismatched Oren identity",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE operations SET oren_id = ? WHERE effect_id = ?")
          .run("oren-other", "effect-corrupt");
      },
    },
    {
      name: "mismatched capability",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE operations SET capability = ? WHERE effect_id = ?")
          .run("test.other", "effect-corrupt");
      },
    },
    {
      name: "incompatible nonterminal status",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE operations SET status = 'dispatched' WHERE effect_id = ?")
          .run("effect-corrupt");
      },
    },
    {
      name: "terminal operation",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        const receipt = JSON.stringify({
          type: "EffectCompleted",
          effectId: "effect-corrupt",
          receipt: { providerId: "already-finished" },
        });
        db.prepare(`
          UPDATE operations SET status = 'completed', receipt_json = ? WHERE effect_id = ?
        `).run(receipt, "effect-corrupt");
      },
    },
  ])("quarantines an outbox row with a $name and claims valid later work", ({ corrupt }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-corrupt", "test.increment", { by: 1 });
    repo.enqueueRawEffect("oren-1", "effect-valid", "test.increment", { by: 2 });
    db.exec("PRAGMA ignore_check_constraints = ON");
    corrupt(db);

    expect(repo.claimOutbox("worker-1", 1, "2026-07-23T00:00:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 1 },
    ]);
    expect(repo.claimOutbox("worker-2", 1, "2026-07-23T00:02:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 2 },
    ]);
    expect(db.prepare(`
      SELECT status, attempts, lease_owner FROM outbox WHERE effect_id = ?
    `).get("effect-corrupt")).toEqual({
      status: "pending",
      attempts: 0,
      lease_owner: null,
    });
  });

  it.each([
    { name: "dispatched row without a prior attempt", status: "dispatched", attempts: 0 },
    { name: "negative pending attempts", status: "pending", attempts: -1 },
    { name: "non-integral dispatched attempts", status: "dispatched", attempts: 1.5 },
    {
      name: "unsafe dispatched attempts",
      status: "dispatched",
      attempts: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("quarantines a $name and claims a valid later row", ({ status, attempts }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-corrupt", "test.increment", { by: 1 });
    repo.enqueueRawEffect("oren-1", "effect-valid", "test.increment", { by: 2 });
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(`
      UPDATE outbox
      SET status = ?, attempts = ?, lease_owner = NULL, lease_until = NULL
      WHERE effect_id = ?
    `).run(status, attempts, "effect-corrupt");
    db.prepare(`
      UPDATE operations SET status = ?, attempts = ? WHERE effect_id = ?
    `).run(status, attempts, "effect-corrupt");

    expect(repo.claimOutbox("worker-1", 1, "2026-07-23T00:00:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 1 },
    ]);
    expect(db.prepare(`
      SELECT reason FROM effect_quarantine WHERE effect_id = ?
    `).get("effect-corrupt")).toMatchObject({
      reason: expect.stringMatching(/attempt|state/i),
    });
  });

  it.each([
    { table: "outbox", status: "pending", attempts: -1 },
    { table: "operations", status: "pending", attempts: 1.5 },
    { table: "outbox", status: "pending", attempts: Number.MAX_SAFE_INTEGER + 1 },
    { table: "operations", status: "pending", attempts: 1 },
    { table: "outbox", status: "dispatched", attempts: 0 },
  ])("prevents invalid $table $status/$attempts state in a new database", ({
    table,
    status,
    attempts,
  }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });

    expect(() => db.prepare(`
      UPDATE ${table} SET status = ?, attempts = ? WHERE effect_id = ?
    `).run(status, attempts, "effect-1")).toThrow(/constraint/i);
  });

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

  it.each([
    {
      name: "different nonterminal statuses",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare(`
          UPDATE operations SET status = 'dispatched', attempts = 1 WHERE effect_id = ?
        `).run("effect-1");
      },
    },
    {
      name: "different dispatched attempt counts",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare(`
          UPDATE outbox SET status = 'dispatched', attempts = 1 WHERE effect_id = ?
        `).run("effect-1");
        db.prepare(`
          UPDATE operations SET status = 'dispatched', attempts = 2 WHERE effect_id = ?
        `).run("effect-1");
      },
    },
    {
      name: "paired dispatched state without a prior attempt",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare(`
          UPDATE outbox SET status = 'dispatched', attempts = 0 WHERE effect_id = ?
        `).run("effect-1");
        db.prepare(`
          UPDATE operations SET status = 'dispatched', attempts = 0 WHERE effect_id = ?
        `).run("effect-1");
      },
    },
    {
      name: "paired negative pending attempts",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE outbox SET attempts = -1 WHERE effect_id = ?").run("effect-1");
        db.prepare("UPDATE operations SET attempts = -1 WHERE effect_id = ?").run("effect-1");
      },
    },
    {
      name: "paired non-integral dispatched attempts",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare(`
          UPDATE outbox SET status = 'dispatched', attempts = 1.5 WHERE effect_id = ?
        `).run("effect-1");
        db.prepare(`
          UPDATE operations SET status = 'dispatched', attempts = 1.5 WHERE effect_id = ?
        `).run("effect-1");
      },
    },
    {
      name: "paired unsafe dispatched attempts",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        const unsafe = Number.MAX_SAFE_INTEGER + 1;
        db.prepare(`
          UPDATE outbox SET status = 'dispatched', attempts = ? WHERE effect_id = ?
        `).run(unsafe, "effect-1");
        db.prepare(`
          UPDATE operations SET status = 'dispatched', attempts = ? WHERE effect_id = ?
        `).run(unsafe, "effect-1");
      },
    },
  ])("rejects $name on first finish and creates no inbox item", ({ corrupt }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    db.exec("PRAGMA ignore_check_constraints = ON");
    corrupt(db);
    const beforeOutbox = db.prepare(`
      SELECT status, CAST(attempts AS TEXT) AS attempts, receipt_json
      FROM outbox WHERE effect_id = ?
    `).get("effect-1");
    const beforeOperation = db.prepare(`
      SELECT status, CAST(attempts AS TEXT) AS attempts, receipt_json
      FROM operations WHERE effect_id = ?
    `).get("effect-1");
    const payload = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1" },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;

    expect(() => repo.finishEffect("effect-1", "oren-1", "effect-1", payload)).toThrow(
      /state|attempt|inconsistent/i,
    );

    expect(db.prepare(`
      SELECT status, CAST(attempts AS TEXT) AS attempts, receipt_json
      FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual(beforeOutbox);
    expect(db.prepare(`
      SELECT status, CAST(attempts AS TEXT) AS attempts, receipt_json
      FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual(beforeOperation);
    expect(db.prepare("SELECT * FROM inbox").all()).toEqual([]);
  });

  it.each([
    { name: "unknown discriminant", payload: { type: "EffectBogus", effectId: "effect-1" } },
    { name: "completed without receipt", payload: { type: "EffectCompleted", effectId: "effect-1" } },
    {
      name: "completed with a non-object receipt",
      payload: { type: "EffectCompleted", effectId: "effect-1", receipt: [] },
    },
    {
      name: "completed with a non-finite receipt number",
      payload: { type: "EffectCompleted", effectId: "effect-1", receipt: { amount: Infinity } },
    },
    {
      name: "failed without a code",
      payload: { type: "EffectFailed", effectId: "effect-1", message: "failed" },
    },
    {
      name: "uncertain without a message",
      payload: { type: "EffectUncertain", effectId: "effect-1" },
    },
    {
      name: "terminal payload with extra fields",
      payload: {
        type: "EffectFailed",
        effectId: "effect-1",
        code: "FAILED",
        message: "failed",
        extra: true,
      },
    },
  ])("rejects a malformed $name without changing durable state", ({ payload }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });

    expect(() => repo.finishEffect(
      "effect-1",
      "oren-1",
      "effect-1",
      payload as never,
    )).toThrow(/terminal payload/);

    expect(db.prepare(`
      SELECT status, receipt_json FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare(`
      SELECT status, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", receipt_json: null });
    expect(db.prepare("SELECT * FROM inbox").all()).toEqual([]);
  });

  it.each([
    {
      name: "stateful toJSON",
      hook: (calls: { value: number }) => () => ({
        providerId: `tx-${calls.value += 1}`,
      }),
    },
    {
      name: "omitting toJSON",
      hook: (calls: { value: number }) => () => {
        calls.value += 1;
        return undefined;
      },
    },
    {
      name: "throwing toJSON",
      hook: (calls: { value: number }) => () => {
        calls.value += 1;
        throw new Error("must not serialize live receipt");
      },
    },
  ])("rejects a completed payload with $name without invoking it", ({ hook }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const calls = { value: 0 };
    const receipt = { providerId: "tx-hidden" };
    Object.defineProperty(receipt, "toJSON", { value: hook(calls) });
    const payload = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt,
    };

    expect(() => repo.finishEffect(
      "effect-1",
      "oren-1",
      "effect-1",
      payload as never,
    )).toThrow("Invalid effect terminal payload");

    expect(calls.value).toBe(0);
    expect(db.prepare(`
      SELECT status, attempts, receipt_json FROM outbox WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", attempts: 0, receipt_json: null });
    expect(db.prepare(`
      SELECT status, attempts, receipt_json FROM operations WHERE effect_id = ?
    `).get("effect-1")).toEqual({ status: "pending", attempts: 0, receipt_json: null });
    expect(db.prepare("SELECT * FROM inbox").all()).toEqual([]);
  });

  it("rejects a conflicting terminal result without overwriting the first result", () => {
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
    expect(() => repo.finishEffect("effect-1", "oren-1", "effect-1", failed)).toThrow(
      /conflicts with durable terminal result/,
    );

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

  it("treats a semantically equal terminal payload as idempotent", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const first = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { nested: { first: 1, second: 2 }, providerId: "tx-1" },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;
    const reordered = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1", nested: { second: 2, first: 1 } },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;

    repo.finishEffect("effect-1", "oren-1", "effect-1", first);
    expect(() => repo.finishEffect(
      "effect-1",
      "oren-1",
      "effect-1",
      reordered,
    )).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM inbox").get()).toEqual({ count: 1 });
  });

  it.each([
    {
      name: "attempt drift",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE operations SET attempts = 1 WHERE effect_id = ?").run("effect-1");
      },
    },
    {
      name: "paired invalid attempts",
      corrupt: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("UPDATE outbox SET attempts = -1 WHERE effect_id = ?").run("effect-1");
        db.prepare("UPDATE operations SET attempts = -1 WHERE effect_id = ?").run("effect-1");
      },
    },
  ])("rejects an idempotent terminal call with $name", ({ corrupt }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const completed = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1" },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;
    repo.finishEffect("effect-1", "oren-1", "effect-1", completed);
    db.exec("PRAGMA ignore_check_constraints = ON");
    corrupt(db);

    expect(() => repo.finishEffect(
      "effect-1",
      "oren-1",
      "effect-1",
      completed,
    )).toThrow(/state is inconsistent/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inbox").get()).toEqual({ count: 1 });
  });

  it.each([
    {
      name: "missing",
      corruptInbox: (db: ReturnType<typeof openDatabase>) => {
        db.prepare("DELETE FROM inbox WHERE inbox_id = ?").run("effect-result:effect-1");
      },
    },
    {
      name: "correlation-mismatched",
      corruptInbox: (db: ReturnType<typeof openDatabase>) => {
        const payload = {
          correlationId: "different-correlation",
          event: {
            type: "EffectCompleted",
            effectId: "effect-1",
            receipt: { providerId: "tx-1" },
          },
        };
        db.prepare("UPDATE inbox SET payload_json = ? WHERE inbox_id = ?")
          .run(JSON.stringify(payload), "effect-result:effect-1");
      },
    },
  ])("rejects an idempotent duplicate when its inbox result is $name", ({ corruptInbox }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.enqueueRawEffect("oren-1", "effect-1", "test.increment", { by: 1 });
    const completed = {
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { providerId: "tx-1" },
    } satisfies Extract<CoreEvent, { type: "EffectCompleted" }>;
    repo.finishEffect("effect-1", "oren-1", "effect-1", completed);
    corruptInbox(db);

    expect(() => repo.finishEffect(
      "effect-1",
      "oren-1",
      "effect-1",
      completed,
    )).toThrow(/terminal state is inconsistent/);
  });
});
