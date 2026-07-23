import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
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
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(
        typeof(attempts) = 'integer'
        AND attempts BETWEEN 0 AND 9007199254740991
        AND (status <> 'pending' OR attempts = 0)
        AND (status <> 'dispatched' OR attempts >= 1)
      ),
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS operations (
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
    );

    CREATE TABLE IF NOT EXISTS effect_quarantine (
      effect_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL
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
