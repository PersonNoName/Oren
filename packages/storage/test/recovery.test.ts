import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { CoreEvent } from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";
import { migrate } from "../src/migrations.js";

describe("repository recovery", () => {
  it("upgrades the exact pre-Task-8 schema without losing valid rows or corrupt evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-upgrade-"));
    const path = join(directory, "life.db");
    const legacy = new DatabaseSync(path);
    createPreTask8Schema(legacy);
    legacy.exec(`
      CREATE INDEX outbox_by_status ON outbox(status, effect_id);
      CREATE INDEX operations_by_status_attempts ON operations(status, attempts);
    `);
    const completedReceipt = JSON.stringify({
      type: "EffectCompleted",
      effectId: "effect-terminal",
      receipt: { providerId: "tx-terminal" },
    });
    const insertOutbox = legacy.prepare(`
      INSERT INTO outbox(
        effect_id, oren_id, capability, effect_json, status,
        lease_owner, lease_until, attempts, receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOperation = legacy.prepare(`
      INSERT INTO operations(
        effect_id, oren_id, capability, status, attempts, receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPair = (
      effectId: string,
      status: string,
      attempts: number,
      capability = "test.increment",
      operationCapability = capability,
      receipt: string | null = null,
    ) => {
      insertOutbox.run(
        effectId,
        "oren-1",
        capability,
        legacyEffectJson(effectId, capability),
        status,
        null,
        null,
        attempts,
        receipt,
      );
      insertOperation.run(
        effectId,
        "oren-1",
        operationCapability,
        status,
        attempts,
        receipt,
      );
    };

    insertPair("effect-invalid-attempt", "pending", 1);
    insertOutbox.run(
      "effect-orphan-outbox",
      "oren-1",
      "test.increment",
      legacyEffectJson("effect-orphan-outbox"),
      "pending",
      null,
      null,
      0,
      null,
    );
    insertOperation.run(
      "effect-orphan-operation",
      "oren-1",
      "test.increment",
      "pending",
      0,
      null,
    );
    insertPair("effect-mismatched", "pending", 0, "test.increment", "test.other");
    insertPair("effect-terminal", "completed", 7, "test.increment", "test.increment", completedReceipt);
    legacy.prepare(`
      UPDATE outbox SET lease_owner = ?, lease_until = ? WHERE effect_id = ?
    `).run("legacy-worker", "2026-07-23T01:00:00.000Z", "effect-terminal");
    insertPair("effect-valid", "pending", 0);
    legacy.close();

    const upgraded = openDatabase(path);
    const schema = upgraded.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name IN ('outbox', 'operations')
      ORDER BY name
    `).all();
    expect(schema).toHaveLength(2);
    expect(schema.every((row) => String(row.sql).includes("typeof(attempts) = 'integer'"))).toBe(true);
    expect(() => upgraded.prepare(`
      UPDATE outbox SET status = 'pending', attempts = 1 WHERE effect_id = ?
    `).run("effect-valid")).toThrow(/constraint/i);
    expect(() => upgraded.prepare(`
      UPDATE operations SET status = 'dispatched', attempts = 0 WHERE effect_id = ?
    `).run("effect-valid")).toThrow(/constraint/i);
    expect(upgraded.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ('outbox_by_status', 'operations_by_status_attempts')
      ORDER BY name
    `).all()).toEqual([
      { name: "operations_by_status_attempts" },
      { name: "outbox_by_status" },
    ]);

    expect(upgraded.prepare(`
      SELECT effect_id FROM outbox WHERE quarantined = 0 ORDER BY effect_id
    `).all()).toEqual([
      { effect_id: "effect-terminal" },
      { effect_id: "effect-valid" },
    ]);
    expect(upgraded.prepare(`
      SELECT effect_id FROM operations WHERE quarantined = 0 ORDER BY effect_id
    `).all()).toEqual([
      { effect_id: "effect-terminal" },
      { effect_id: "effect-valid" },
    ]);
    expect(upgraded.prepare(`
      SELECT effect_id, quarantined FROM outbox WHERE quarantined = 1 ORDER BY effect_id
    `).all()).toEqual([
      { effect_id: "effect-invalid-attempt", quarantined: 1 },
      { effect_id: "effect-mismatched", quarantined: 1 },
      { effect_id: "effect-orphan-outbox", quarantined: 1 },
    ]);
    expect(upgraded.prepare(`
      SELECT effect_id, quarantined FROM operations WHERE quarantined = 1 ORDER BY effect_id
    `).all()).toEqual([
      { effect_id: "effect-invalid-attempt", quarantined: 1 },
      { effect_id: "effect-mismatched", quarantined: 1 },
      { effect_id: "effect-orphan-operation", quarantined: 1 },
    ]);
    expect(upgraded.prepare(`
      SELECT *
      FROM outbox
      WHERE effect_id = 'effect-terminal'
    `).get()).toEqual({
      effect_id: "effect-terminal",
      oren_id: "oren-1",
      capability: "test.increment",
      effect_json: legacyEffectJson("effect-terminal"),
      status: "completed",
      lease_owner: "legacy-worker",
      lease_until: "2026-07-23T01:00:00.000Z",
      attempts: 7,
      receipt_json: completedReceipt,
      quarantined: 0,
    });
    expect(upgraded.prepare(`
      SELECT *
      FROM operations
      WHERE effect_id = 'effect-terminal'
    `).get()).toEqual({
      effect_id: "effect-terminal",
      oren_id: "oren-1",
      capability: "test.increment",
      status: "completed",
      attempts: 7,
      receipt_json: completedReceipt,
      quarantined: 0,
    });

    const quarantine = upgraded.prepare(`
      SELECT
        effect_id,
        source_table,
        legacy_reason,
        legacy_outbox_json,
        legacy_operation_json
      FROM effect_quarantine
      WHERE source_table IS NOT NULL
      ORDER BY effect_id, source_table
    `).all();
    expect(quarantine.map((row) => [row.effect_id, row.source_table])).toEqual([
      ["effect-invalid-attempt", "operations"],
      ["effect-invalid-attempt", "outbox"],
      ["effect-mismatched", "operations"],
      ["effect-mismatched", "outbox"],
      ["effect-orphan-operation", "operations"],
      ["effect-orphan-outbox", "outbox"],
    ]);
    expect([...new Set(quarantine.map((row) => row.effect_id))]).toEqual([
      "effect-invalid-attempt",
      "effect-mismatched",
      "effect-orphan-operation",
      "effect-orphan-outbox",
    ]);
    expect(quarantine).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effect_id: "effect-invalid-attempt",
        source_table: "outbox",
        legacy_reason: expect.stringMatching(/status|attempt/i),
        legacy_outbox_json: expect.stringContaining("\"attempts_sql\":\"1\""),
        legacy_operation_json: null,
      }),
      expect.objectContaining({
        effect_id: "effect-invalid-attempt",
        source_table: "operations",
        legacy_reason: expect.stringMatching(/status|attempt/i),
        legacy_outbox_json: null,
        legacy_operation_json: expect.stringContaining("\"attempts_sql\":\"1\""),
      }),
      expect.objectContaining({
        effect_id: "effect-mismatched",
        source_table: "outbox",
        legacy_reason: expect.stringMatching(/inconsistent|mismatch/i),
        legacy_outbox_json: expect.stringContaining("\"capability_sql\":\"'test.increment'\""),
        legacy_operation_json: null,
      }),
      expect.objectContaining({
        effect_id: "effect-mismatched",
        source_table: "operations",
        legacy_reason: expect.stringMatching(/inconsistent|mismatch/i),
        legacy_outbox_json: null,
        legacy_operation_json: expect.stringContaining("\"capability_sql\":\"'test.other'\""),
      }),
      expect.objectContaining({
        effect_id: "effect-orphan-operation",
        source_table: "operations",
        legacy_reason: expect.stringMatching(/missing outbox/i),
        legacy_outbox_json: null,
        legacy_operation_json: expect.stringContaining("\"effect_id_sql\":\"'effect-orphan-operation'\""),
      }),
      expect.objectContaining({
        effect_id: "effect-orphan-outbox",
        source_table: "outbox",
        legacy_reason: expect.stringMatching(/missing operation/i),
        legacy_outbox_json: expect.stringContaining("\"effect_id_sql\":\"'effect-orphan-outbox'\""),
        legacy_operation_json: null,
      }),
    ]));
    expect(upgraded.prepare("SELECT * FROM inbox").all()).toEqual([]);

    const repo = new SqliteLifeRepository(upgraded);
    expect(() => repo.finishEffect(
      "effect-invalid-attempt",
      "oren-1",
      "effect-invalid-attempt",
      {
        type: "EffectUncertain",
        effectId: "effect-invalid-attempt",
        message: "must remain inert",
      },
    )).toThrow(/identity|quarantin/i);
    expect(repo.claimOutbox("worker-upgrade", 10, "2026-07-23T00:00:00.000Z")).toMatchObject([
      { effectId: "effect-valid", attempts: 1 },
    ]);
    const beforeReopen = upgraded.prepare(`
      SELECT * FROM effect_quarantine ORDER BY effect_id
    `).all();
    repo.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare(`
      SELECT * FROM effect_quarantine ORDER BY effect_id
    `).all()).toEqual(beforeReopen);
    expect(reopened.prepare(`
      SELECT effect_id, status, attempts
      FROM outbox
      WHERE quarantined = 0
      ORDER BY effect_id
    `).all()).toEqual([
      { effect_id: "effect-terminal", status: "completed", attempts: 7 },
      { effect_id: "effect-valid", status: "dispatched", attempts: 1 },
    ]);
    reopened.close();
  });

  it.each([
    { childState: "empty", populateChildren: false },
    { childState: "populated", populateChildren: true },
  ])("preserves $childState dependent foreign keys, views, and triggers during upgrade", ({
    populateChildren,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-dependencies-"));
    const path = join(directory, "life.db");
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON");
    createPreTask8Schema(legacy);
    legacy.exec(`
      CREATE TABLE dependency_audit (
        message TEXT NOT NULL
      );
      CREATE TABLE outbox_children (
        child_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES outbox(effect_id),
        note TEXT NOT NULL
      );
      CREATE TABLE operation_children (
        child_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES operations(effect_id),
        note TEXT NOT NULL
      );
      CREATE VIEW effect_dependency_view AS
      SELECT o.effect_id, o.status AS outbox_status, p.status AS operation_status
      FROM outbox AS o
      JOIN operations AS p ON p.effect_id = o.effect_id;
      CREATE TRIGGER outbox_child_audit
      AFTER INSERT ON outbox_children
      BEGIN
        INSERT INTO dependency_audit(message)
        SELECT 'child:' || NEW.effect_id || ':' || status
        FROM outbox
        WHERE effect_id = NEW.effect_id;
      END;
      CREATE TRIGGER outbox_owned_audit
      AFTER UPDATE OF lease_owner ON outbox
      BEGIN
        INSERT INTO dependency_audit(message)
        VALUES ('outbox:' || NEW.effect_id || ':' || COALESCE(NEW.lease_owner, 'none'));
      END;
      CREATE TRIGGER operations_owned_audit
      AFTER UPDATE OF receipt_json ON operations
      BEGIN
        INSERT INTO dependency_audit(message)
        VALUES ('operation:' || NEW.effect_id || ':' || COALESCE(NEW.receipt_json, 'none'));
      END;
      CREATE INDEX outbox_dependency_status ON outbox(status, effect_id);
      CREATE INDEX operation_dependency_status ON operations(status, effect_id);
    `);
    insertLegacyPair(legacy, "effect-valid", "pending", 0);
    insertLegacyPair(legacy, "effect-corrupt-referenced", "pending", 1);
    if (populateChildren) {
      legacy.exec(`
        INSERT INTO outbox_children VALUES
          ('outbox-child-valid', 'effect-valid', 'valid'),
          ('outbox-child-corrupt', 'effect-corrupt-referenced', 'corrupt');
        INSERT INTO operation_children VALUES
          ('operation-child-valid', 'effect-valid', 'valid'),
          ('operation-child-corrupt', 'effect-corrupt-referenced', 'corrupt');
        DELETE FROM dependency_audit;
      `);
    }
    const dependencySql = legacy.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name IN (
        'outbox_children',
        'operation_children',
        'effect_dependency_view',
        'outbox_child_audit',
        'outbox_owned_audit',
        'operations_owned_audit',
        'outbox_dependency_status',
        'operation_dependency_status'
      )
      ORDER BY type, name
    `).all();
    legacy.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name IN (
        'outbox_children',
        'operation_children',
        'effect_dependency_view',
        'outbox_child_audit',
        'outbox_owned_audit',
        'operations_owned_audit',
        'outbox_dependency_status',
        'operation_dependency_status'
      )
      ORDER BY type, name
    `).all()).toEqual(dependencySql);
    expect(upgraded.prepare("PRAGMA foreign_key_list(outbox_children)").all()).toMatchObject([
      { table: "outbox", from: "effect_id", to: "effect_id" },
    ]);
    expect(upgraded.prepare("PRAGMA foreign_key_list(operation_children)").all()).toMatchObject([
      { table: "operations", from: "effect_id", to: "effect_id" },
    ]);
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(upgraded.prepare(`
      SELECT effect_id, outbox_status, operation_status
      FROM effect_dependency_view
      ORDER BY effect_id
    `).all()).toEqual([
      {
        effect_id: "effect-corrupt-referenced",
        outbox_status: "pending",
        operation_status: "pending",
      },
      { effect_id: "effect-valid", outbox_status: "pending", operation_status: "pending" },
    ]);
    expect(upgraded.prepare(`
      SELECT quarantined FROM outbox WHERE effect_id = 'effect-corrupt-referenced'
    `).get()).toEqual({ quarantined: 1 });
    expect(upgraded.prepare(`
      SELECT quarantined FROM operations WHERE effect_id = 'effect-corrupt-referenced'
    `).get()).toEqual({ quarantined: 1 });

    upgraded.exec(`
      INSERT INTO outbox_children
      VALUES ('outbox-child-after', 'effect-valid', 'after upgrade');
      INSERT INTO operation_children
      VALUES ('operation-child-after', 'effect-valid', 'after upgrade');
      UPDATE outbox SET lease_owner = 'worker-after' WHERE effect_id = 'effect-valid';
      UPDATE operations SET receipt_json = '{"after":true}' WHERE effect_id = 'effect-valid';
    `);
    expect(() => upgraded.exec(`
      INSERT INTO outbox_children
      VALUES ('outbox-child-missing', 'effect-missing', 'must fail')
    `)).toThrow(/foreign key/i);
    expect(upgraded.prepare(`
      SELECT message FROM dependency_audit ORDER BY rowid
    `).all()).toEqual([
      { message: "child:effect-valid:pending" },
      { message: "outbox:effect-valid:worker-after" },
      { message: 'operation:effect-valid:{"after":true}' },
    ]);
    const stateBeforeReopen = {
      dependencies: upgraded.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name IN (
          'outbox_children',
          'operation_children',
          'effect_dependency_view',
          'outbox_child_audit',
          'outbox_owned_audit',
          'operations_owned_audit',
          'outbox_dependency_status',
          'operation_dependency_status'
        )
        ORDER BY type, name
      `).all(),
      outbox: upgraded.prepare("SELECT * FROM outbox ORDER BY rowid").all(),
      operations: upgraded.prepare("SELECT * FROM operations ORDER BY rowid").all(),
      quarantine: upgraded.prepare("SELECT * FROM effect_quarantine ORDER BY quarantine_id").all(),
    };
    upgraded.close();

    const reopened = openDatabase(path);
    expect({
      dependencies: reopened.prepare(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name IN (
          'outbox_children',
          'operation_children',
          'effect_dependency_view',
          'outbox_child_audit',
          'outbox_owned_audit',
          'operations_owned_audit',
          'outbox_dependency_status',
          'operation_dependency_status'
        )
        ORDER BY type, name
      `).all(),
      outbox: reopened.prepare("SELECT * FROM outbox ORDER BY rowid").all(),
      operations: reopened.prepare("SELECT * FROM operations ORDER BY rowid").all(),
      quarantine: reopened.prepare("SELECT * FROM effect_quarantine ORDER BY quarantine_id").all(),
    }).toEqual(stateBeforeReopen);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  it("rolls a failed dependency migration back and restores connection PRAGMAs", () => {
    const db = new DatabaseSync(":memory:");
    createPreTask8Schema(db);
    db.exec(`
      CREATE TABLE outbox_children (
        child_id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL REFERENCES outbox(effect_id)
      );
      CREATE VIEW effect_dependency_view AS
      SELECT effect_id, status FROM outbox;
      CREATE TRIGGER outbox_owned_audit
      AFTER UPDATE ON outbox
      BEGIN
        SELECT NEW.effect_id;
      END;
    `);
    insertLegacyPair(db, "effect-valid", "pending", 0);
    db.exec(`
      INSERT INTO outbox_children VALUES ('child-valid', 'effect-valid');
      PRAGMA foreign_keys = OFF;
      CREATE TABLE broken_parent (id TEXT PRIMARY KEY);
      CREATE TABLE broken_child (parent_id TEXT REFERENCES broken_parent(id));
      INSERT INTO broken_child VALUES ('missing-parent');
      PRAGMA foreign_keys = ON;
      PRAGMA legacy_alter_table = OFF;
    `);
    const schemaBefore = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      ORDER BY type, name
    `).all();
    const outboxBefore = db.prepare("SELECT rowid, * FROM outbox ORDER BY rowid").all();
    const operationsBefore = db.prepare("SELECT rowid, * FROM operations ORDER BY rowid").all();

    expect(() => migrate(db)).toThrow(/foreign key check/i);

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
    expect(db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      ORDER BY type, name
    `).all()).toEqual(schemaBefore);
    expect(db.prepare("SELECT rowid, * FROM outbox ORDER BY rowid").all()).toEqual(outboxBefore);
    expect(db.prepare("SELECT rowid, * FROM operations ORDER BY rowid").all()).toEqual(
      operationsBefore,
    );
    expect(db.prepare("PRAGMA foreign_key_list(outbox_children)").all()).toMatchObject([
      { table: "outbox" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([
      expect.objectContaining({ table: "broken_child", parent: "broken_parent" }),
    ]);

    db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
    expect(() => migrate(db)).toThrow(/foreign key check/i);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    expect(db.prepare("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 1 });
    expect(db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      ORDER BY type, name
    `).all()).toEqual(schemaBefore);
    expect(db.prepare("SELECT rowid, * FROM outbox ORDER BY rowid").all()).toEqual(outboxBefore);
    expect(db.prepare("SELECT rowid, * FROM operations ORDER BY rowid").all()).toEqual(
      operationsBefore,
    );
    db.close();
  });

  it("preserves every quarantined source row and byte with NULL keys and embedded NULs", () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-lossless-"));
    const path = join(directory, "life.db");
    const legacy = new DatabaseSync(path);
    createPreTask8Schema(legacy);
    legacy.exec(`
      INSERT INTO outbox(
        rowid, effect_id, oren_id, capability, effect_json, status,
        lease_owner, lease_until, attempts, receipt_json
      ) VALUES
        (
          -9223372036854775808,
          NULL,
          42,
          CAST(X'6265666F72650061667465722D41' AS TEXT),
          X'7B0062696E6172792D417D',
          'pending',
          X'00FF41',
          CAST(X'32303236002D41' AS TEXT),
          1.5,
          NULL
        ),
        (
          9223372036854775807,
          NULL,
          43.25,
          CAST(X'6265666F72650061667465722D42' AS TEXT),
          X'7B0062696E6172792D427D',
          'pending',
          X'00FF42',
          CAST(X'32303236002D42' AS TEXT),
          'not-an-attempt',
          CAST(X'726563656970740042' AS TEXT)
        ),
        (
          17,
          'effect-nul-mismatch',
          'oren-1',
          CAST(X'636170006F7574626F78' AS TEXT),
          CAST(X'656666656374006A736F6E' AS TEXT),
          'pending',
          NULL,
          NULL,
          0,
          X'010200'
        ),
        (
          18,
          X'696400626C6F62',
          X'6F72656E00626C6F62',
          X'63617000626C6F62',
          X'7B7D00626C6F62',
          'pending',
          NULL,
          NULL,
          0,
          NULL
        );
      INSERT INTO operations(
        rowid, effect_id, oren_id, capability, status, attempts, receipt_json
      ) VALUES
        (
          -9223372036854775808,
          NULL,
          52,
          X'6265666F72650061667465722D41',
          'pending',
          1.5,
          CAST(X'726563656970740041' AS TEXT)
        ),
        (
          9223372036854775807,
          NULL,
          53.25,
          X'6265666F72650061667465722D42',
          'pending',
          'not-an-attempt',
          X'00FE42'
        ),
        (
          29,
          'effect-nul-mismatch',
          'oren-1',
          X'636170006F7065726174696F6E',
          'pending',
          0,
          CAST(X'72656365697074006F70' AS TEXT)
        ),
        (
          30,
          X'696400626C6F62',
          X'6F72656E00626C6F62',
          X'63617000626C6F62',
          'pending',
          0,
          NULL
        );
    `);
    const sourceRows = [
      ...legacyStorageSnapshot(legacy, "outbox", [
        "effect_id",
        "oren_id",
        "capability",
        "effect_json",
        "status",
        "lease_owner",
        "lease_until",
        "attempts",
        "receipt_json",
      ]),
      ...legacyStorageSnapshot(legacy, "operations", [
        "effect_id",
        "oren_id",
        "capability",
        "status",
        "attempts",
        "receipt_json",
      ]),
    ];
    legacy.close();

    const upgraded = openDatabase(path);
    const evidenceRows = upgraded.prepare(`
      SELECT
        quarantine_id,
        effect_id,
        source_table,
        CAST(source_rowid AS TEXT) AS source_rowid,
        legacy_outbox_json,
        legacy_operation_json
      FROM effect_quarantine
      WHERE source_table IS NOT NULL
      ORDER BY source_table, source_rowid
    `).all();
    expect(evidenceRows).toHaveLength(sourceRows.length);
    expect(evidenceRows.every((row) => row.quarantine_id !== null)).toBe(true);
    expect(new Set(evidenceRows.map((row) => String(row.quarantine_id))).size).toBe(
      evidenceRows.length,
    );
    expect(upgraded.prepare("PRAGMA table_info(effect_quarantine)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "quarantine_id",
          type: "INTEGER",
          notnull: 1,
          pk: 1,
        }),
      ]),
    );

    for (const source of sourceRows) {
      const evidence = evidenceRows.find((row) => (
        row.source_table === source.sourceTable
        && row.source_rowid === source.sourceRowid
      ));
      expect(evidence, `${source.sourceTable} rowid ${source.sourceRowid}`).toBeDefined();
      const json = source.sourceTable === "outbox"
        ? evidence?.legacy_outbox_json
        : evidence?.legacy_operation_json;
      expect(typeof json).toBe("string");
      const encoded = JSON.parse(String(json)) as Record<string, unknown>;
      expect(encoded).toMatchObject(source.storage);
    }
    const encodedCapabilities = evidenceRows.map((row) => {
      const json = row.legacy_outbox_json ?? row.legacy_operation_json;
      return (JSON.parse(String(json)) as Record<string, unknown>).capability_hex;
    });
    expect(encodedCapabilities).toEqual(expect.arrayContaining([
      "6265666F72650061667465722D41",
      "6265666F72650061667465722D42",
      "636170006F7574626F78",
      "636170006F7065726174696F6E",
    ]));
    expect(upgraded.prepare(`
      SELECT CAST(rowid AS TEXT) AS source_rowid
      FROM outbox
      WHERE effect_id IS NULL AND quarantined = 1
      ORDER BY rowid
    `).all()).toEqual([
      { source_rowid: "-9223372036854775808" },
      { source_rowid: "9223372036854775807" },
    ]);
    expect(upgraded.prepare(`
      SELECT CAST(rowid AS TEXT) AS source_rowid
      FROM operations
      WHERE effect_id IS NULL AND quarantined = 1
      ORDER BY rowid
    `).all()).toEqual([
      { source_rowid: "-9223372036854775808" },
      { source_rowid: "9223372036854775807" },
    ]);
    const beforeReopen = upgraded.prepare(`
      SELECT
        quarantine_id,
        effect_id,
        reason,
        quarantined_at,
        source_table,
        CAST(source_rowid AS TEXT) AS source_rowid,
        legacy_reason,
        legacy_outbox_json,
        legacy_operation_json
      FROM effect_quarantine
      ORDER BY quarantine_id
    `).all();
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare(`
      SELECT
        quarantine_id,
        effect_id,
        reason,
        quarantined_at,
        source_table,
        CAST(source_rowid AS TEXT) AS source_rowid,
        legacy_reason,
        legacy_outbox_json,
        legacy_operation_json
      FROM effect_quarantine
      ORDER BY quarantine_id
    `).all()).toEqual(beforeReopen);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  it("evolves existing quarantine rows to non-null surrogate keys without changing evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "oren-storage-quarantine-evolution-"));
    const path = join(directory, "life.db");
    const legacy = new DatabaseSync(path);
    createPreTask8Schema(legacy);
    legacy.exec(`
      CREATE TABLE effect_quarantine (
        effect_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        legacy_reason TEXT,
        legacy_outbox_json TEXT,
        legacy_operation_json TEXT
      );
      INSERT INTO effect_quarantine VALUES
        (
          NULL,
          'manual null evidence A',
          '2026-07-23T00:00:00.000Z',
          'legacy A',
          '{"bytes":"0041"}',
          NULL
        ),
        (
          NULL,
          'manual null evidence B',
          '2026-07-23T00:00:01.000Z',
          'legacy B',
          NULL,
          '{"bytes":"0042"}'
        ),
        (
          'effect-manual',
          'manual effect evidence',
          '2026-07-23T00:00:02.000Z',
          NULL,
          NULL,
          NULL
        );
    `);
    insertLegacyPair(legacy, "effect-valid", "pending", 0);
    legacy.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare(`
      SELECT
        quarantine_id,
        effect_id,
        reason,
        quarantined_at,
        source_table,
        source_rowid,
        legacy_reason,
        legacy_outbox_json,
        legacy_operation_json
      FROM effect_quarantine
      ORDER BY quarantine_id
    `).all()).toEqual([
      {
        quarantine_id: 1,
        effect_id: null,
        reason: "manual null evidence A",
        quarantined_at: "2026-07-23T00:00:00.000Z",
        source_table: null,
        source_rowid: null,
        legacy_reason: "legacy A",
        legacy_outbox_json: '{"bytes":"0041"}',
        legacy_operation_json: null,
      },
      {
        quarantine_id: 2,
        effect_id: null,
        reason: "manual null evidence B",
        quarantined_at: "2026-07-23T00:00:01.000Z",
        source_table: null,
        source_rowid: null,
        legacy_reason: "legacy B",
        legacy_outbox_json: null,
        legacy_operation_json: '{"bytes":"0042"}',
      },
      {
        quarantine_id: 3,
        effect_id: "effect-manual",
        reason: "manual effect evidence",
        quarantined_at: "2026-07-23T00:00:02.000Z",
        source_table: null,
        source_rowid: null,
        legacy_reason: null,
        legacy_outbox_json: null,
        legacy_operation_json: null,
      },
    ]);
    expect(upgraded.prepare(`
      INSERT OR IGNORE INTO effect_quarantine(effect_id, reason, quarantined_at)
      VALUES ('effect-manual', 'must not replace', '2026-07-24T00:00:00.000Z')
    `).run().changes).toBe(0);
    const beforeReopen = upgraded.prepare(`
      SELECT * FROM effect_quarantine ORDER BY quarantine_id
    `).all();
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare(`
      SELECT * FROM effect_quarantine ORDER BY quarantine_id
    `).all()).toEqual(beforeReopen);
    reopened.close();
  });

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

function legacyEffectJson(effectId: string, capability = "test.increment"): string {
  return JSON.stringify({
    effectId,
    orenId: "oren-1",
    correlationId: effectId,
    capability,
    arguments: { by: 1 },
    grantIds: [],
    stateVersion: 0,
  });
}

function insertLegacyPair(
  db: DatabaseSync,
  effectId: string,
  status: string,
  attempts: number,
  capability = "test.increment",
  operationCapability = capability,
): void {
  db.prepare(`
    INSERT INTO outbox(
      effect_id, oren_id, capability, effect_json, status,
      lease_owner, lease_until, attempts, receipt_json
    ) VALUES (?, 'oren-1', ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(effectId, capability, legacyEffectJson(effectId, capability), status, attempts);
  db.prepare(`
    INSERT INTO operations(
      effect_id, oren_id, capability, status, attempts, receipt_json
    ) VALUES (?, 'oren-1', ?, ?, ?, NULL)
  `).run(effectId, operationCapability, status, attempts);
}

function legacyStorageSnapshot(
  db: DatabaseSync,
  table: "outbox" | "operations",
  columns: readonly string[],
): Array<{
  readonly sourceTable: string;
  readonly sourceRowid: string;
  readonly storage: Readonly<Record<string, unknown>>;
}> {
  const storageColumns = columns.flatMap((column) => [
    `typeof(${column}) AS ${column}_type`,
    `CASE
      WHEN ${column} IS NULL THEN NULL
      WHEN typeof(${column}) = 'real'
        THEN hex(CAST(printf('%!.17g', ${column}) AS BLOB))
      ELSE hex(CAST(${column} AS BLOB))
    END AS ${column}_hex`,
    `CASE
      WHEN ${column} IS NULL THEN NULL
      WHEN typeof(${column}) = 'real'
        THEN length(CAST(printf('%!.17g', ${column}) AS BLOB))
      ELSE length(CAST(${column} AS BLOB))
    END AS ${column}_length`,
  ]).join(",\n");
  return db.prepare(`
    SELECT CAST(rowid AS TEXT) AS source_rowid, ${storageColumns}
    FROM ${table}
    ORDER BY rowid
  `).all().map((row) => {
    const storage = Object.fromEntries(columns.flatMap((column) => [
      [`${column}_type`, row[`${column}_type`]],
      [`${column}_hex`, row[`${column}_hex`]],
      [`${column}_length`, row[`${column}_length`]],
    ]));
    return {
      sourceTable: table,
      sourceRowid: String(row.source_rowid),
      storage,
    };
  });
}

function createPreTask8Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      oren_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_oren ON events(oren_id, sequence);

    CREATE TABLE IF NOT EXISTS snapshots (
      oren_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      cursor INTEGER NOT NULL,
      state_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox (
      inbox_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      priority INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS outbox (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
      lease_owner TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS operations (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS grants (
      grant_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      grant_json TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      delivered_at TEXT
    );
  `);
}
