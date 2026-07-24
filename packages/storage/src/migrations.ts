import type { DatabaseSync } from "node:sqlite";

// `quarantined = 0` is the only active state: those rows must have textual
// application identity/effect columns, satisfy the status/attempt checks, and
// may be claimed or finished. `quarantined = 1` is an inert migration
// tombstone that preserves a corrupt legacy parent key and its original
// columns for dependent foreign keys and manual recovery.
const OUTBOX_COLUMNS = `
  effect_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  effect_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(
    quarantined = 1
    OR status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  ),
  lease_owner TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK(
    quarantined IN (0, 1)
    AND (
      quarantined = 1
      OR (
        typeof(effect_id) = 'text'
        AND typeof(oren_id) = 'text'
        AND typeof(capability) = 'text'
        AND typeof(effect_json) = 'text'
        AND typeof(attempts) = 'integer'
        AND attempts BETWEEN 0 AND 9007199254740991
        AND (status <> 'pending' OR attempts = 0)
        AND (status <> 'dispatched' OR attempts >= 1)
      )
    )
  )
`;

const OPERATIONS_COLUMNS = `
  effect_id TEXT PRIMARY KEY,
  oren_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK(
    quarantined = 1
    OR status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK(
    quarantined IN (0, 1)
    AND (
      quarantined = 1
      OR (
        typeof(effect_id) = 'text'
        AND typeof(oren_id) = 'text'
        AND typeof(capability) = 'text'
        AND typeof(attempts) = 'integer'
        AND attempts BETWEEN 0 AND 9007199254740991
        AND (status <> 'pending' OR attempts = 0)
        AND (status <> 'dispatched' OR attempts >= 1)
      )
    )
  )
`;

// Runtime quarantine records have a NULL source identity and are unique by
// effect_id. Migration evidence has a stable (source_table, source_rowid)
// identity, allowing duplicate and NULL legacy effect_id values without
// weakening the genuinely non-null quarantine_id primary key.
const QUARANTINE_COLUMNS = `
  quarantine_id INTEGER PRIMARY KEY NOT NULL,
  effect_id TEXT,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  source_table TEXT,
  source_rowid INTEGER,
  legacy_reason TEXT,
  legacy_outbox_json TEXT,
  legacy_operation_json TEXT,
  CHECK(
    (source_table IS NULL AND source_rowid IS NULL)
    OR (
      source_table IN ('outbox', 'operations')
      AND typeof(source_rowid) = 'integer'
    )
  )
`;

const VALID_OUTBOX_STATE = `
  o.status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  AND typeof(o.attempts) = 'integer'
  AND o.attempts BETWEEN 0 AND 9007199254740991
  AND (o.status <> 'pending' OR o.attempts = 0)
  AND (o.status <> 'dispatched' OR o.attempts >= 1)
`;

const VALID_OUTBOX_STORAGE = `
  typeof(o.effect_id) = 'text'
  AND typeof(o.oren_id) = 'text'
  AND typeof(o.capability) = 'text'
  AND typeof(o.effect_json) = 'text'
`;

const VALID_OPERATION_STATE = `
  p.status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  AND typeof(p.attempts) = 'integer'
  AND p.attempts BETWEEN 0 AND 9007199254740991
  AND (p.status <> 'pending' OR p.attempts = 0)
  AND (p.status <> 'dispatched' OR p.attempts >= 1)
`;

const VALID_OPERATION_STORAGE = `
  typeof(p.effect_id) = 'text'
  AND typeof(p.oren_id) = 'text'
  AND typeof(p.capability) = 'text'
`;

const CONSISTENT_PAIR = `
  p.oren_id = o.oren_id
  AND p.capability = o.capability
  AND p.status = o.status
  AND p.attempts = o.attempts
`;

interface SchemaObject {
  readonly sql: string;
}

const LEGACY_OUTBOX_TEXT_COLUMNS = [
  "effect_id",
  "oren_id",
  "capability",
  "effect_json",
  "status",
  "lease_owner",
  "lease_until",
  "receipt_json",
] as const;

const LEGACY_OPERATION_TEXT_COLUMNS = [
  "effect_id",
  "oren_id",
  "capability",
  "status",
  "receipt_json",
] as const;

export function migrate(db: DatabaseSync): void {
  const rebuildEffects = effectTablesNeedRebuild(db);
  const rebuildQuarantine = quarantineNeedsRebuild(db);
  const needsRelaxedRebuildPragmas = rebuildEffects || rebuildQuarantine;
  const originalForeignKeys = pragmaNumber(db, "foreign_keys");
  const originalLegacyAlterTable = pragmaNumber(db, "legacy_alter_table");
  let transactionStarted = false;

  try {
    if (needsRelaxedRebuildPragmas) {
      if (originalForeignKeys !== 0) db.exec("PRAGMA foreign_keys = OFF");
      if (originalLegacyAlterTable === 0) db.exec("PRAGMA legacy_alter_table = ON");
    }
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    createNonEffectTables(db);
    createOrEvolveQuarantine(db);
    migrateEffectTables(db);
    if (needsRelaxedRebuildPragmas) assertForeignKeysValid(db);
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      db.exec("ROLLBACK");
      transactionStarted = false;
    }
    throw error;
  } finally {
    if (needsRelaxedRebuildPragmas) {
      db.exec(`PRAGMA legacy_alter_table = ${originalLegacyAlterTable === 0 ? "OFF" : "ON"}`);
      db.exec(`PRAGMA foreign_keys = ${originalForeignKeys === 0 ? "OFF" : "ON"}`);
    }
  }
}

function createNonEffectTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      oren_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_oren ON events(oren_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS autonomy_reservation_by_episode
    ON events(
      oren_id,
      json_extract(
        CASE WHEN json_valid(envelope_json) THEN envelope_json ELSE '{}' END,
        '$.payload.episodeId'
      )
    )
    WHERE json_extract(
      CASE WHEN json_valid(envelope_json) THEN envelope_json ELSE '{}' END,
      '$.payload.type'
    ) = 'AutonomyConsumed';

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
      lease_token TEXT,
      lease_until TEXT,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inbox_quarantine (
      inbox_id TEXT PRIMARY KEY REFERENCES inbox(inbox_id),
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_claim_path
    ON inbox(processed_at, available_at, lease_until, priority DESC);

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

    CREATE TABLE IF NOT EXISTS schedule_quarantine (
      schedule_id TEXT PRIMARY KEY REFERENCES schedules(schedule_id),
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_claim_path
    ON schedules(delivered_at, due_at, schedule_id);
  `);
  const inboxColumns = new Set(
    db.prepare("PRAGMA table_info(inbox)").all().map((row) => String(row.name)),
  );
  if (!inboxColumns.has("lease_token")) {
    db.exec("ALTER TABLE inbox ADD COLUMN lease_token TEXT");
  }
}

function createOrEvolveQuarantine(db: DatabaseSync): void {
  const sql = tableSql(db, "effect_quarantine");
  if (sql === undefined) {
    createQuarantineTable(db, "effect_quarantine");
    createQuarantineIndexes(db);
    return;
  }
  if (hasRequiredQuarantineSchema(db)) {
    createQuarantineIndexes(db);
    return;
  }

  const objects = ownedSchemaObjects(db, ["effect_quarantine"]);
  const columns = new Set(
    db.prepare("PRAGMA table_info(effect_quarantine)").all().map((row) => String(row.name)),
  );
  createQuarantineTable(db, "__task8_effect_quarantine_new");
  db.exec(`
    INSERT INTO __task8_effect_quarantine_new(
      effect_id,
      reason,
      quarantined_at,
      source_table,
      source_rowid,
      legacy_reason,
      legacy_outbox_json,
      legacy_operation_json
    )
    SELECT
      effect_id,
      reason,
      quarantined_at,
      ${columns.has("source_table") ? "source_table" : "NULL"},
      ${columns.has("source_rowid") ? "source_rowid" : "NULL"},
      ${columns.has("legacy_reason") ? "legacy_reason" : "NULL"},
      ${columns.has("legacy_outbox_json") ? "legacy_outbox_json" : "NULL"},
      ${columns.has("legacy_operation_json") ? "legacy_operation_json" : "NULL"}
    FROM effect_quarantine
    ORDER BY rowid;
    DROP TABLE effect_quarantine;
    ALTER TABLE __task8_effect_quarantine_new RENAME TO effect_quarantine;
  `);
  createQuarantineIndexes(db);
  recreateSchemaObjects(db, objects);
}

function createQuarantineTable(db: DatabaseSync, name: string): void {
  db.exec(`CREATE TABLE ${name} (${QUARANTINE_COLUMNS})`);
}

function createQuarantineIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS effect_quarantine_runtime_effect
    ON effect_quarantine(effect_id)
    WHERE source_table IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS effect_quarantine_source_row
    ON effect_quarantine(source_table, source_rowid)
    WHERE source_table IS NOT NULL;
  `);
}

function migrateEffectTables(db: DatabaseSync): void {
  const outboxSql = tableSql(db, "outbox");
  const operationsSql = tableSql(db, "operations");
  if (outboxSql === undefined && operationsSql === undefined) {
    createEffectTable(db, "outbox", OUTBOX_COLUMNS);
    createEffectTable(db, "operations", OPERATIONS_COLUMNS);
    return;
  }
  if (!effectTablesNeedRebuild(db)) return;

  const objects = ownedSchemaObjects(db, ["outbox", "operations"]);
  if (outboxSql === undefined) createLegacyOutboxPlaceholder(db);
  if (operationsSql === undefined) createLegacyOperationsPlaceholder(db);

  createEffectTable(db, "__task8_outbox_new", OUTBOX_COLUMNS);
  createEffectTable(db, "__task8_operations_new", OPERATIONS_COLUMNS);
  classifyAndQuarantineInvalidLegacyRows(db);
  db.exec(`
    INSERT INTO __task8_outbox_new(
      rowid,
      effect_id,
      oren_id,
      capability,
      effect_json,
      status,
      lease_owner,
      lease_until,
      attempts,
      receipt_json,
      quarantined
    )
    SELECT
      o.rowid,
      o.effect_id,
      o.oren_id,
      o.capability,
      o.effect_json,
      o.status,
      o.lease_owner,
      o.lease_until,
      o.attempts,
      o.receipt_json,
      CASE WHEN EXISTS (
        SELECT 1
        FROM __task8_invalid_effect_rows AS invalid
        WHERE invalid.source_table = 'outbox'
          AND invalid.source_rowid = o.rowid
      ) THEN 1 ELSE 0 END
    FROM outbox AS o
    ORDER BY o.rowid;

    INSERT INTO __task8_operations_new(
      rowid,
      effect_id,
      oren_id,
      capability,
      status,
      attempts,
      receipt_json,
      quarantined
    )
    SELECT
      p.rowid,
      p.effect_id,
      p.oren_id,
      p.capability,
      p.status,
      p.attempts,
      p.receipt_json,
      CASE WHEN EXISTS (
        SELECT 1
        FROM __task8_invalid_effect_rows AS invalid
        WHERE invalid.source_table = 'operations'
          AND invalid.source_rowid = p.rowid
      ) THEN 1 ELSE 0 END
    FROM operations AS p
    ORDER BY p.rowid;

    DROP TABLE outbox;
    DROP TABLE operations;
    ALTER TABLE __task8_outbox_new RENAME TO outbox;
    ALTER TABLE __task8_operations_new RENAME TO operations;
    DROP TABLE __task8_invalid_effect_rows;
  `);
  recreateSchemaObjects(db, objects);
}

function createEffectTable(db: DatabaseSync, name: string, columns: string): void {
  db.exec(`CREATE TABLE ${name} (${columns})`);
}

function createLegacyOutboxPlaceholder(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE outbox (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    )
  `);
}

function createLegacyOperationsPlaceholder(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE operations (
      effect_id TEXT PRIMARY KEY,
      oren_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT
    )
  `);
}

function classifyAndQuarantineInvalidLegacyRows(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE __task8_invalid_effect_rows (
      source_table TEXT NOT NULL,
      source_rowid INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY(source_table, source_rowid)
    ) WITHOUT ROWID;
  `);
  classifyInvalidUtf8LegacyText(db);
  db.exec(`
    INSERT OR IGNORE INTO __task8_invalid_effect_rows(source_table, source_rowid, reason)
    SELECT
      'operations',
      p.rowid,
      'legacy operation is paired with an outbox row containing invalid UTF-8'
    FROM operations AS p
    JOIN outbox AS o ON o.effect_id = p.effect_id
    JOIN __task8_invalid_effect_rows AS invalid
      ON invalid.source_table = 'outbox'
      AND invalid.source_rowid = o.rowid;

    INSERT OR IGNORE INTO __task8_invalid_effect_rows(source_table, source_rowid, reason)
    SELECT
      'outbox',
      o.rowid,
      'legacy outbox is paired with an operation row containing invalid UTF-8'
    FROM outbox AS o
    JOIN operations AS p ON p.effect_id = o.effect_id
    JOIN __task8_invalid_effect_rows AS invalid
      ON invalid.source_table = 'operations'
      AND invalid.source_rowid = p.rowid;

    INSERT OR IGNORE INTO __task8_invalid_effect_rows(source_table, source_rowid, reason)
    SELECT
      'outbox',
      o.rowid,
      CASE
        WHEN o.effect_id IS NULL OR p.rowid IS NULL
          THEN 'legacy row pair is missing operation row'
        WHEN NOT (${VALID_OUTBOX_STORAGE})
          THEN 'legacy outbox has invalid identity/effect storage classes'
        WHEN NOT (${VALID_OPERATION_STORAGE})
          THEN 'legacy operation has invalid identity storage classes'
        WHEN NOT (${VALID_OUTBOX_STATE})
          THEN 'legacy outbox has an invalid status/attempt state'
        WHEN NOT (${VALID_OPERATION_STATE})
          THEN 'legacy operation has an invalid status/attempt state'
        ELSE 'legacy outbox and operation rows are inconsistent'
      END
    FROM outbox AS o
    LEFT JOIN operations AS p ON p.effect_id = o.effect_id
    WHERE o.effect_id IS NULL
      OR p.rowid IS NULL
      OR NOT (${VALID_OUTBOX_STORAGE})
      OR NOT (${VALID_OPERATION_STORAGE})
      OR NOT (${VALID_OUTBOX_STATE})
      OR NOT (${VALID_OPERATION_STATE})
      OR NOT (${CONSISTENT_PAIR});

    INSERT OR IGNORE INTO __task8_invalid_effect_rows(source_table, source_rowid, reason)
    SELECT
      'operations',
      p.rowid,
      CASE
        WHEN p.effect_id IS NULL OR o.rowid IS NULL
          THEN 'legacy row pair is missing outbox row'
        WHEN NOT (${VALID_OUTBOX_STORAGE})
          THEN 'legacy outbox has invalid identity/effect storage classes'
        WHEN NOT (${VALID_OPERATION_STORAGE})
          THEN 'legacy operation has invalid identity storage classes'
        WHEN NOT (${VALID_OUTBOX_STATE})
          THEN 'legacy outbox has an invalid status/attempt state'
        WHEN NOT (${VALID_OPERATION_STATE})
          THEN 'legacy operation has an invalid status/attempt state'
        ELSE 'legacy outbox and operation rows are inconsistent'
      END
    FROM operations AS p
    LEFT JOIN outbox AS o ON o.effect_id = p.effect_id
    WHERE p.effect_id IS NULL
      OR o.rowid IS NULL
      OR NOT (${VALID_OUTBOX_STORAGE})
      OR NOT (${VALID_OPERATION_STORAGE})
      OR NOT (${VALID_OUTBOX_STATE})
      OR NOT (${VALID_OPERATION_STATE})
      OR NOT (${CONSISTENT_PAIR});

    INSERT OR IGNORE INTO effect_quarantine(
      effect_id,
      reason,
      quarantined_at,
      source_table,
      source_rowid,
      legacy_reason,
      legacy_outbox_json,
      legacy_operation_json
    )
    SELECT
      o.effect_id,
      invalid.reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      invalid.source_table,
      invalid.source_rowid,
      invalid.reason,
      ${legacyRowEvidenceSql("o", [
        "effect_id",
        "oren_id",
        "capability",
        "effect_json",
        "status",
        "lease_owner",
        "lease_until",
        "attempts",
        "receipt_json",
      ])},
      NULL
    FROM __task8_invalid_effect_rows AS invalid
    JOIN outbox AS o ON invalid.source_table = 'outbox'
      AND invalid.source_rowid = o.rowid;

    INSERT OR IGNORE INTO effect_quarantine(
      effect_id,
      reason,
      quarantined_at,
      source_table,
      source_rowid,
      legacy_reason,
      legacy_outbox_json,
      legacy_operation_json
    )
    SELECT
      p.effect_id,
      invalid.reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      invalid.source_table,
      invalid.source_rowid,
      invalid.reason,
      NULL,
      ${legacyRowEvidenceSql("p", [
        "effect_id",
        "oren_id",
        "capability",
        "status",
        "attempts",
        "receipt_json",
      ])}
    FROM __task8_invalid_effect_rows AS invalid
    JOIN operations AS p ON invalid.source_table = 'operations'
      AND invalid.source_rowid = p.rowid;
  `);
}

function classifyInvalidUtf8LegacyText(db: DatabaseSync): void {
  classifyInvalidUtf8TableRows(db, "outbox", LEGACY_OUTBOX_TEXT_COLUMNS);
  classifyInvalidUtf8TableRows(db, "operations", LEGACY_OPERATION_TEXT_COLUMNS);
}

function classifyInvalidUtf8TableRows(
  db: DatabaseSync,
  table: "outbox" | "operations",
  columns: readonly string[],
): void {
  const projections = columns.flatMap((column) => [
    `typeof(${column}) AS ${column}_type`,
    `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) END AS ${column}_bytes`,
  ]);
  const statement = db.prepare(`
    SELECT rowid, ${projections.join(", ")}
    FROM ${table}
    ORDER BY rowid
  `);
  statement.setReadBigInts(true);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO __task8_invalid_effect_rows(source_table, source_rowid, reason)
    VALUES (?, ?, ?)
  `);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const row of statement.iterate()) {
    if (typeof row.rowid !== "bigint") {
      throw new Error(`Could not inspect legacy ${table} rowid`);
    }
    const invalidColumns = columns.filter((column) => {
      if (row[`${column}_type`] !== "text") return false;
      const bytes = row[`${column}_bytes`];
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(`Could not inspect raw legacy ${table}.${column} bytes`);
      }
      try {
        decoder.decode(bytes);
        return false;
      } catch {
        return true;
      }
    });
    if (invalidColumns.length === 0) continue;
    insert.run(
      table,
      row.rowid,
      `legacy ${table} has invalid UTF-8 in ${invalidColumns.join(", ")}`,
    );
  }
}

function legacyRowEvidenceSql(alias: string, columns: readonly string[]): string {
  const entries = columns.flatMap((column) => {
    const value = `${alias}.${column}`;
    const bytes = `CASE
      WHEN ${value} IS NULL THEN NULL
      WHEN typeof(${value}) = 'real'
        THEN CAST(printf('%!.17g', ${value}) AS BLOB)
      ELSE CAST(${value} AS BLOB)
    END`;
    return [
      `'${column}_type', typeof(${value})`,
      `'${column}_hex', CASE WHEN ${value} IS NULL THEN NULL ELSE hex(${bytes}) END`,
      `'${column}_length', length(${bytes})`,
      `'${column}_sql', quote(${value})`,
    ];
  });
  return `json_object(${entries.join(", ")})`;
}

function effectTablesNeedRebuild(db: DatabaseSync): boolean {
  const outboxSql = tableSql(db, "outbox");
  const operationsSql = tableSql(db, "operations");
  if (outboxSql === undefined && operationsSql === undefined) return false;
  return outboxSql === undefined
    || operationsSql === undefined
    || !hasRequiredEffectConstraints(outboxSql)
    || !hasRequiredEffectConstraints(operationsSql);
}

function quarantineNeedsRebuild(db: DatabaseSync): boolean {
  return tableSql(db, "effect_quarantine") !== undefined && !hasRequiredQuarantineSchema(db);
}

function hasRequiredQuarantineSchema(db: DatabaseSync): boolean {
  const columns = db.prepare("PRAGMA table_info(effect_quarantine)").all();
  const byName = new Map(columns.map((row) => [String(row.name), row]));
  const id = byName.get("quarantine_id");
  return id !== undefined
    && String(id.type).toUpperCase() === "INTEGER"
    && Number(id.pk) === 1
    && Number(id.notnull) === 1
    && byName.has("effect_id")
    && byName.has("source_table")
    && byName.has("source_rowid")
    && byName.has("legacy_reason")
    && byName.has("legacy_outbox_json")
    && byName.has("legacy_operation_json");
}

function ownedSchemaObjects(db: DatabaseSync, tables: readonly string[]): SchemaObject[] {
  const placeholders = tables.map(() => "?").join(", ");
  return db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type IN ('index', 'trigger')
      AND tbl_name IN (${placeholders})
      AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
  `).all(...tables).flatMap((row) => typeof row.sql === "string" ? [{ sql: row.sql }] : []);
}

function recreateSchemaObjects(db: DatabaseSync, objects: readonly SchemaObject[]): void {
  for (const object of objects) db.exec(object.sql);
}

function assertForeignKeysValid(db: DatabaseSync): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length === 0) return;
  const summary = violations.map((row) => (
    `${String(row.table)} row ${String(row.rowid)} -> ${String(row.parent)}`
  )).join(", ");
  throw new Error(`Foreign key check failed after effect-table rebuild: ${summary}`);
}

function pragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row ? Object.values(row)[0] : undefined;
  return Number(value);
}

function tableSql(db: DatabaseSync, table: string): string | undefined {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table);
  return row && typeof row.sql === "string" ? row.sql : undefined;
}

function hasRequiredEffectConstraints(sql: string): boolean {
  const normalized = sql.replaceAll(/\s+/g, " ").toLowerCase();
  return normalized.includes(
    "status text not null check( quarantined = 1 or status in ('pending','dispatched','completed','failed','uncertain','cancelled') )",
  )
    && normalized.includes("quarantined integer not null default 0")
    && normalized.includes("quarantined in (0, 1)")
    && normalized.includes("quarantined = 1")
    && normalized.includes("typeof(effect_id) = 'text'")
    && normalized.includes("typeof(oren_id) = 'text'")
    && normalized.includes("typeof(capability) = 'text'")
    && normalized.includes("typeof(attempts) = 'integer'")
    && normalized.includes("attempts between 0 and 9007199254740991")
    && normalized.includes("status <> 'pending' or attempts = 0")
    && normalized.includes("status <> 'dispatched' or attempts >= 1");
}
