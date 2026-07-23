import type { DatabaseSync } from "node:sqlite";
import {
  reduceLifeState,
  type Effect,
  type EventEnvelope,
  type Grant,
  type JsonObject,
  type LifeState,
  type CoreEvent,
} from "@oren/kernel";

interface OutboxRow {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: Effect;
  readonly attempts: number;
}

export class SqliteLifeRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public close(): void {
    this.db.close();
  }

  public initialize(state: LifeState): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO snapshots(oren_id, version, cursor, state_json)
      VALUES (?, ?, ?, ?)
    `).run(state.orenId, state.version, state.chronicleCursor, JSON.stringify(state));
  }

  public putGrant(orenId: string, grant: Grant): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`
        SELECT oren_id FROM grants WHERE grant_id = ?
      `).get(grant.grantId);
      if (existing && String(existing.oren_id) !== orenId) {
        throw new Error(`Grant ${grant.grantId} already belongs to ${String(existing.oren_id)}`);
      }
      this.db.prepare(`
        INSERT INTO grants(grant_id, oren_id, grant_json, revoked_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(grant_id) DO UPDATE SET grant_json = excluded.grant_json
        WHERE grants.oren_id = excluded.oren_id
      `).run(grant.grantId, orenId, JSON.stringify(grant));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public loadGrants(orenId: string): Grant[] {
    return this.db.prepare(`
      SELECT grant_json FROM grants WHERE oren_id = ? AND revoked_at IS NULL
    `).all(orenId).map((row) => JSON.parse(String(row.grant_json)) as Grant);
  }

  public loadEvents(orenId: string): EventEnvelope[] {
    return this.loadEventsAfter(orenId, 0);
  }

  private loadEventsAfter(orenId: string, cursor: number): EventEnvelope[] {
    return this.db.prepare(`
      SELECT envelope_json FROM events
      WHERE oren_id = ?
      ORDER BY sequence
      LIMIT -1 OFFSET ?
    `).all(orenId, cursor).map((row) => JSON.parse(String(row.envelope_json)) as EventEnvelope);
  }

  public rehydrate(orenId: string): LifeState {
    const row = this.db.prepare(`
      SELECT cursor, state_json FROM snapshots WHERE oren_id = ?
    `).get(orenId);
    if (!row) throw new Error(`Missing initial snapshot for ${orenId}`);
    return this.loadEventsAfter(orenId, Number(row.cursor)).reduce(
      reduceLifeState,
      JSON.parse(String(row.state_json)) as LifeState,
    );
  }

  public appendAndEnqueueEffects(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    this.validateOrenIdentities(orenId, events, effects);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertEvent = this.db.prepare(`
        INSERT INTO events(event_id, oren_id, recorded_at, envelope_json) VALUES (?, ?, ?, ?)
      `);
      for (const event of events) {
        insertEvent.run(event.eventId, orenId, event.recordedAt, JSON.stringify(event));
        if (event.payload.type === "WakeScheduled") {
          this.db.prepare(`
            INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(schedule_id) DO UPDATE SET
              due_at = excluded.due_at,
              purpose = excluded.purpose,
              delivered_at = NULL
          `).run(
            event.payload.scheduleId,
            orenId,
            event.payload.at,
            event.payload.purpose,
          );
        }
      }
      const insertEffect = this.db.prepare(`
        INSERT INTO outbox(effect_id, oren_id, capability, effect_json, status)
        VALUES (?, ?, ?, ?, 'pending')
      `);
      const insertOperation = this.db.prepare(`
        INSERT INTO operations(effect_id, oren_id, capability, status)
        VALUES (?, ?, ?, 'pending')
      `);
      for (const effect of effects) {
        insertEffect.run(effect.effectId, orenId, effect.capability, JSON.stringify(effect));
        insertOperation.run(effect.effectId, orenId, effect.capability);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private validateOrenIdentities(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    for (const event of events) {
      if (event.orenId !== orenId) {
        throw new Error(`Event ${event.eventId} orenId does not match ${orenId}`);
      }
      if (event.payload.type === "EffectRequested" && event.payload.effect?.orenId !== orenId) {
        throw new Error(`EffectRequested event ${event.eventId} has a mismatched orenId`);
      }
    }
    for (const effect of effects) {
      if (effect.orenId !== orenId) {
        throw new Error(`Effect ${effect.effectId} orenId does not match ${orenId}`);
      }
    }
  }

  public enqueueRawEffect(
    orenId: string,
    effectId: string,
    capability: string,
    arguments_: JsonObject,
  ): void {
    const effect: Effect = {
      effectId,
      orenId,
      correlationId: effectId,
      capability,
      arguments: arguments_,
      grantIds: [],
      stateVersion: 0,
    };
    this.appendAndEnqueueEffects(orenId, [], [effect]);
  }

  public claimOutbox(worker: string, limit: number, now = new Date().toISOString()): OutboxRow[] {
    const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT effect_id, oren_id, capability, effect_json, attempts
        FROM outbox
        WHERE status IN ('pending','dispatched')
          AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY rowid
        LIMIT ?
      `).all(now, limit);
      const lease = this.db.prepare(`
        UPDATE outbox
        SET status = 'dispatched', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE effect_id = ?
      `);
      const updateOperation = this.db.prepare(`
        UPDATE operations
        SET status = 'dispatched', attempts = attempts + 1
        WHERE effect_id = ?
      `);
      for (const row of rows) {
        lease.run(worker, leaseUntil, String(row.effect_id));
        updateOperation.run(String(row.effect_id));
      }
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        effectId: String(row.effect_id),
        orenId: String(row.oren_id),
        capability: String(row.capability),
        effect: JSON.parse(String(row.effect_json)) as Effect,
        attempts: Number(row.attempts) + 1,
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public finishEffect(
    effectId: string,
    orenId: string,
    correlationId: string,
    payload:
      | Extract<CoreEvent, { type: "EffectCompleted" }>
      | Extract<CoreEvent, { type: "EffectFailed" }>
      | Extract<CoreEvent, { type: "EffectUncertain" }>,
  ): void {
    if (payload.effectId !== effectId) {
      throw new Error(`Effect terminal payload identity does not match ${effectId}`);
    }
    const status = payload.type === "EffectCompleted"
      ? "completed"
      : payload.type === "EffectFailed"
        ? "failed"
        : "uncertain";
    const receipt = JSON.stringify(payload);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const outbox = this.db.prepare(`
        SELECT oren_id, capability, effect_json, status, receipt_json
        FROM outbox WHERE effect_id = ?
      `).get(effectId);
      if (!outbox) {
        throw new Error(`Effect ${effectId} not found`);
      }
      const effect = JSON.parse(String(outbox.effect_json)) as Effect;
      if (
        String(outbox.oren_id) !== orenId
        || effect.effectId !== effectId
        || effect.orenId !== orenId
        || effect.correlationId !== correlationId
        || effect.capability !== String(outbox.capability)
      ) {
        throw new Error(`Effect ${effectId} identity does not match persisted outbox row`);
      }

      const operation = this.db.prepare(`
        SELECT oren_id, capability, status, receipt_json
        FROM operations WHERE effect_id = ?
      `).get(effectId);
      if (
        !operation
        || String(operation.oren_id) !== orenId
        || String(operation.capability) !== effect.capability
      ) {
        throw new Error(`Effect ${effectId} operation identity does not match outbox row`);
      }

      const terminalStatuses = new Set(["completed", "failed", "uncertain", "cancelled"]);
      const outboxStatus = String(outbox.status);
      const operationStatus = String(operation.status);
      if (terminalStatuses.has(outboxStatus)) {
        if (
          operationStatus !== outboxStatus
          || operation.receipt_json !== outbox.receipt_json
        ) {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        this.db.exec("COMMIT");
        return;
      }
      if (terminalStatuses.has(operationStatus)) {
        throw new Error(`Effect ${effectId} operation state is inconsistent`);
      }

      const outboxUpdate = this.db.prepare(`
        UPDATE outbox
        SET status = ?, receipt_json = ?, lease_owner = NULL, lease_until = NULL
        WHERE effect_id = ? AND oren_id = ?
          AND status NOT IN ('completed','failed','uncertain','cancelled')
      `).run(status, receipt, effectId, orenId);
      if (Number(outboxUpdate.changes) !== 1) {
        throw new Error(`Effect ${effectId} outbox did not transition`);
      }
      const operationUpdate = this.db.prepare(`
        UPDATE operations
        SET status = ?, receipt_json = ?
        WHERE effect_id = ? AND oren_id = ?
          AND status NOT IN ('completed','failed','uncertain','cancelled')
      `).run(status, receipt, effectId, orenId);
      if (Number(operationUpdate.changes) !== 1) {
        throw new Error(`Effect ${effectId} operation did not transition`);
      }
      this.db.prepare(`
        INSERT INTO inbox(inbox_id, oren_id, priority, available_at, payload_json)
        VALUES (?, ?, 4, ?, ?)
      `).run(
        `effect-result:${effectId}`,
        orenId,
        this.now(),
        JSON.stringify({ correlationId, event: payload }),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
