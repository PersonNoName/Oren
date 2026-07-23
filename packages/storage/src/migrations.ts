import type { DatabaseSync } from "node:sqlite";

const OUTBOX_TABLE = `
  CREATE TABLE outbox (
    effect_id TEXT PRIMARY KEY,
    oren_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    effect_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
    lease_owner TEXT,
    lease_until TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(attempts) = 'integer'
      AND attempts BETWEEN 0 AND 9007199254740991
      AND (status <> 'pending' OR attempts = 0)
      AND (status <> 'dispatched' OR attempts >= 1)
    ),
    receipt_json TEXT
  )
`;

const OPERATIONS_TABLE = `
  CREATE TABLE operations (
    effect_id TEXT PRIMARY KEY,
    oren_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed','uncertain','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(
      typeof(attempts) = 'integer'
      AND attempts BETWEEN 0 AND 9007199254740991
      AND (status <> 'pending' OR attempts = 0)
      AND (status <> 'dispatched' OR attempts >= 1)
    ),
    receipt_json TEXT
  )
`;

const VALID_OUTBOX_STATE = `
  o.status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  AND typeof(o.attempts) = 'integer'
  AND o.attempts BETWEEN 0 AND 9007199254740991
  AND (o.status <> 'pending' OR o.attempts = 0)
  AND (o.status <> 'dispatched' OR o.attempts >= 1)
`;

const VALID_OPERATION_STATE = `
  p.status IN ('pending','dispatched','completed','failed','uncertain','cancelled')
  AND typeof(p.attempts) = 'integer'
  AND p.attempts BETWEEN 0 AND 9007199254740991
  AND (p.status <> 'pending' OR p.attempts = 0)
  AND (p.status <> 'dispatched' OR p.attempts >= 1)
`;

const CONSISTENT_PAIR = `
  p.oren_id = o.oren_id
  AND p.capability = o.capability
  AND p.status = o.status
  AND p.attempts = o.attempts
`;

export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    createNonEffectTables(db);
    createOrEvolveQuarantine(db);
    migrateEffectTables(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
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

function createOrEvolveQuarantine(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS effect_quarantine (
      effect_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      legacy_reason TEXT,
      legacy_outbox_json TEXT,
      legacy_operation_json TEXT
    )
  `);
  const columns = new Set(
    db.prepare("PRAGMA table_info(effect_quarantine)").all().map((row) => String(row.name)),
  );
  for (const column of [
    "legacy_reason",
    "legacy_outbox_json",
    "legacy_operation_json",
  ]) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE effect_quarantine ADD COLUMN ${column} TEXT`);
    }
  }
}

function migrateEffectTables(db: DatabaseSync): void {
  const outboxSql = tableSql(db, "outbox");
  const operationsSql = tableSql(db, "operations");
  if (outboxSql === undefined && operationsSql === undefined) {
    db.exec(`${OUTBOX_TABLE}; ${OPERATIONS_TABLE};`);
    return;
  }
  if (
    outboxSql !== undefined
    && operationsSql !== undefined
    && hasRequiredEffectConstraints(outboxSql)
    && hasRequiredEffectConstraints(operationsSql)
  ) {
    return;
  }

  const indexSql = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name IN ('outbox', 'operations')
      AND sql IS NOT NULL
    ORDER BY name
  `).all().flatMap((row) => typeof row.sql === "string" ? [row.sql] : []);

  if (outboxSql === undefined) {
    db.exec(`
      CREATE TABLE __task8_outbox_legacy (
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
  } else {
    db.exec("ALTER TABLE outbox RENAME TO __task8_outbox_legacy");
  }
  if (operationsSql === undefined) {
    db.exec(`
      CREATE TABLE __task8_operations_legacy (
        effect_id TEXT PRIMARY KEY,
        oren_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        receipt_json TEXT
      )
    `);
  } else {
    db.exec("ALTER TABLE operations RENAME TO __task8_operations_legacy");
  }

  db.exec(`${OUTBOX_TABLE}; ${OPERATIONS_TABLE};`);
  quarantineInvalidLegacyPairs(db);
  db.exec(`
    INSERT INTO outbox(
      effect_id,
      oren_id,
      capability,
      effect_json,
      status,
      lease_owner,
      lease_until,
      attempts,
      receipt_json
    )
    SELECT
      o.effect_id,
      o.oren_id,
      o.capability,
      o.effect_json,
      o.status,
      o.lease_owner,
      o.lease_until,
      o.attempts,
      o.receipt_json
    FROM __task8_outbox_legacy AS o
    INNER JOIN __task8_operations_legacy AS p ON p.effect_id = o.effect_id
    WHERE ${VALID_OUTBOX_STATE}
      AND ${VALID_OPERATION_STATE}
      AND ${CONSISTENT_PAIR};

    INSERT INTO operations(
      effect_id,
      oren_id,
      capability,
      status,
      attempts,
      receipt_json
    )
    SELECT
      p.effect_id,
      p.oren_id,
      p.capability,
      p.status,
      p.attempts,
      p.receipt_json
    FROM __task8_operations_legacy AS p
    INNER JOIN __task8_outbox_legacy AS o ON o.effect_id = p.effect_id
    WHERE ${VALID_OUTBOX_STATE}
      AND ${VALID_OPERATION_STATE}
      AND ${CONSISTENT_PAIR};

    DROP TABLE __task8_outbox_legacy;
    DROP TABLE __task8_operations_legacy;
  `);
  for (const sql of indexSql) db.exec(sql);
}

function quarantineInvalidLegacyPairs(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE __task8_invalid_effects (
      effect_id PRIMARY KEY,
      reason TEXT NOT NULL
    );

    INSERT INTO __task8_invalid_effects(effect_id, reason)
    SELECT
      o.effect_id,
      CASE
        WHEN p.effect_id IS NULL THEN 'legacy row pair is missing operation row'
        WHEN NOT (${VALID_OUTBOX_STATE}) THEN 'legacy outbox has an invalid status/attempt state'
        WHEN NOT (${VALID_OPERATION_STATE}) THEN 'legacy operation has an invalid status/attempt state'
        ELSE 'legacy outbox and operation rows are inconsistent'
      END
    FROM __task8_outbox_legacy AS o
    LEFT JOIN __task8_operations_legacy AS p ON p.effect_id = o.effect_id
    WHERE p.effect_id IS NULL
      OR NOT (${VALID_OUTBOX_STATE})
      OR NOT (${VALID_OPERATION_STATE})
      OR NOT (${CONSISTENT_PAIR});

    INSERT OR IGNORE INTO __task8_invalid_effects(effect_id, reason)
    SELECT p.effect_id, 'legacy row pair is missing outbox row'
    FROM __task8_operations_legacy AS p
    LEFT JOIN __task8_outbox_legacy AS o ON o.effect_id = p.effect_id
    WHERE o.effect_id IS NULL;

    INSERT INTO effect_quarantine(
      effect_id,
      reason,
      quarantined_at,
      legacy_reason,
      legacy_outbox_json,
      legacy_operation_json
    )
    SELECT
      invalid.effect_id,
      invalid.reason,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      invalid.reason,
      (
        SELECT json_object(
          'effect_id_type', typeof(o.effect_id),
          'effect_id_sql', quote(o.effect_id),
          'oren_id_type', typeof(o.oren_id),
          'oren_id_sql', quote(o.oren_id),
          'capability_type', typeof(o.capability),
          'capability_sql', quote(o.capability),
          'effect_json_type', typeof(o.effect_json),
          'effect_json_sql', quote(o.effect_json),
          'status_type', typeof(o.status),
          'status_sql', quote(o.status),
          'lease_owner_type', typeof(o.lease_owner),
          'lease_owner_sql', quote(o.lease_owner),
          'lease_until_type', typeof(o.lease_until),
          'lease_until_sql', quote(o.lease_until),
          'attempts_type', typeof(o.attempts),
          'attempts_sql', quote(o.attempts),
          'receipt_json_type', typeof(o.receipt_json),
          'receipt_json_sql', quote(o.receipt_json)
        )
        FROM __task8_outbox_legacy AS o
        WHERE o.effect_id = invalid.effect_id
      ),
      (
        SELECT json_object(
          'effect_id_type', typeof(p.effect_id),
          'effect_id_sql', quote(p.effect_id),
          'oren_id_type', typeof(p.oren_id),
          'oren_id_sql', quote(p.oren_id),
          'capability_type', typeof(p.capability),
          'capability_sql', quote(p.capability),
          'status_type', typeof(p.status),
          'status_sql', quote(p.status),
          'attempts_type', typeof(p.attempts),
          'attempts_sql', quote(p.attempts),
          'receipt_json_type', typeof(p.receipt_json),
          'receipt_json_sql', quote(p.receipt_json)
        )
        FROM __task8_operations_legacy AS p
        WHERE p.effect_id = invalid.effect_id
      )
    FROM __task8_invalid_effects AS invalid
    WHERE 1
    ON CONFLICT(effect_id) DO UPDATE SET
      legacy_reason = COALESCE(effect_quarantine.legacy_reason, excluded.legacy_reason),
      legacy_outbox_json = COALESCE(
        effect_quarantine.legacy_outbox_json,
        excluded.legacy_outbox_json
      ),
      legacy_operation_json = COALESCE(
        effect_quarantine.legacy_operation_json,
        excluded.legacy_operation_json
      );

    DROP TABLE __task8_invalid_effects;
  `);
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
    "status text not null check(status in ('pending','dispatched','completed','failed','uncertain','cancelled'))",
  )
    && normalized.includes("typeof(attempts) = 'integer'")
    && normalized.includes("attempts between 0 and 9007199254740991")
    && normalized.includes("status <> 'pending' or attempts = 0")
    && normalized.includes("status <> 'dispatched' or attempts >= 1");
}
