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

type TerminalEffectEvent =
  | Extract<CoreEvent, { type: "EffectCompleted" }>
  | Extract<CoreEvent, { type: "EffectFailed" }>
  | Extract<CoreEvent, { type: "EffectUncertain" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isEffect(value: unknown): value is Effect {
  return isRecord(value)
    && hasExactKeys(value, [
      "effectId",
      "orenId",
      "correlationId",
      "capability",
      "arguments",
      "grantIds",
      "stateVersion",
    ])
    && typeof value.effectId === "string"
    && typeof value.orenId === "string"
    && typeof value.correlationId === "string"
    && typeof value.capability === "string"
    && isRecord(value.arguments)
    && isJsonValue(value.arguments)
    && Array.isArray(value.grantIds)
    && value.grantIds.every((grantId) => typeof grantId === "string")
    && Number.isSafeInteger(value.stateVersion)
    && Number(value.stateVersion) >= 0;
}

function isTerminalEffectEvent(value: unknown): value is TerminalEffectEvent {
  if (!isRecord(value) || typeof value.effectId !== "string") return false;
  if (value.type === "EffectCompleted") {
    return hasExactKeys(value, ["type", "effectId", "receipt"])
      && isRecord(value.receipt)
      && isJsonValue(value.receipt);
  }
  if (value.type === "EffectFailed") {
    return hasExactKeys(value, ["type", "effectId", "code", "message"])
      && typeof value.code === "string"
      && typeof value.message === "string";
  }
  if (value.type === "EffectUncertain") {
    return hasExactKeys(value, ["type", "effectId", "message"])
      && typeof value.message === "string";
  }
  return false;
}

function semanticJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => semanticJsonEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && semanticJsonEqual(left[key], right[key]));
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
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Outbox claim limit must be a nonnegative safe integer");
    }
    if (limit === 0) return [];
    const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT
          outbox.effect_id,
          outbox.oren_id,
          outbox.capability,
          outbox.effect_json,
          outbox.status,
          outbox.attempts,
          operations.effect_id AS operation_effect_id,
          operations.oren_id AS operation_oren_id,
          operations.capability AS operation_capability,
          operations.status AS operation_status,
          operations.attempts AS operation_attempts
        FROM outbox
        LEFT JOIN operations ON operations.effect_id = outbox.effect_id
        WHERE outbox.status IN ('pending','dispatched')
          AND (outbox.lease_until IS NULL OR outbox.lease_until <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM effect_quarantine
            WHERE effect_quarantine.effect_id = outbox.effect_id
          )
        ORDER BY outbox.rowid
      `).all(now);
      const lease = this.db.prepare(`
        UPDATE outbox
        SET status = 'dispatched', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE effect_id = ? AND status = ? AND attempts = ?
      `);
      const updateOperation = this.db.prepare(`
        UPDATE operations
        SET status = 'dispatched', attempts = attempts + 1
        WHERE effect_id = ? AND oren_id = ? AND capability = ?
          AND status = ? AND attempts = ?
      `);
      const quarantine = this.db.prepare(`
        INSERT OR IGNORE INTO effect_quarantine(effect_id, reason, quarantined_at)
        VALUES (?, ?, ?)
      `);
      const claimed: OutboxRow[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        const effectId = String(row.effect_id);
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(row.effect_json));
        } catch {
          quarantine.run(effectId, "outbox effect_json is not valid JSON", now);
          continue;
        }
        if (!isEffect(parsed)) {
          quarantine.run(effectId, "outbox effect_json is not a valid Effect", now);
          continue;
        }
        const outboxOrenId = String(row.oren_id);
        const outboxCapability = String(row.capability);
        if (
          parsed.effectId !== effectId
          || parsed.orenId !== outboxOrenId
          || parsed.capability !== outboxCapability
        ) {
          quarantine.run(effectId, "outbox effect identity does not match its columns", now);
          continue;
        }
        const outboxStatus = String(row.status);
        const outboxAttempts = Number(row.attempts);
        if (
          row.operation_effect_id === null
          || String(row.operation_oren_id) !== outboxOrenId
          || String(row.operation_capability) !== outboxCapability
          || String(row.operation_status) !== outboxStatus
          || Number(row.operation_attempts) !== outboxAttempts
        ) {
          quarantine.run(effectId, "operation row is missing or inconsistent with outbox", now);
          continue;
        }
        const leased = lease.run(worker, leaseUntil, effectId, outboxStatus, outboxAttempts);
        const operation = updateOperation.run(
          effectId,
          outboxOrenId,
          outboxCapability,
          outboxStatus,
          outboxAttempts,
        );
        if (Number(leased.changes) !== 1 || Number(operation.changes) !== 1) {
          throw new Error(`Effect ${effectId} claim did not transition both durable rows`);
        }
        claimed.push({
          effectId,
          orenId: outboxOrenId,
          capability: outboxCapability,
          effect: parsed,
          attempts: outboxAttempts + 1,
        });
      }
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public finishEffect(
    effectId: string,
    orenId: string,
    correlationId: string,
    payload: TerminalEffectEvent,
  ): void {
    if (!isTerminalEffectEvent(payload)) {
      throw new Error("Invalid effect terminal payload");
    }
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
      const effect: unknown = JSON.parse(String(outbox.effect_json));
      if (
        !isEffect(effect)
        ||
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
          || outbox.receipt_json === null
          || operation.receipt_json === null
        ) {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        let outboxReceipt: unknown;
        let operationReceipt: unknown;
        try {
          outboxReceipt = JSON.parse(String(outbox.receipt_json));
          operationReceipt = JSON.parse(String(operation.receipt_json));
        } catch {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        if (
          !isTerminalEffectEvent(outboxReceipt)
          || !isTerminalEffectEvent(operationReceipt)
          || !semanticJsonEqual(outboxReceipt, operationReceipt)
        ) {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        if (outboxStatus !== status || !semanticJsonEqual(outboxReceipt, payload)) {
          throw new Error(`Effect ${effectId} conflicts with durable terminal result`);
        }
        const inbox = this.db.prepare(`
          SELECT oren_id, payload_json FROM inbox WHERE inbox_id = ?
        `).get(`effect-result:${effectId}`);
        let inboxPayload: unknown;
        try {
          inboxPayload = inbox ? JSON.parse(String(inbox.payload_json)) : null;
        } catch {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        if (
          !inbox
          || String(inbox.oren_id) !== orenId
          || !isRecord(inboxPayload)
          || !hasExactKeys(inboxPayload, ["correlationId", "event"])
          || inboxPayload.correlationId !== correlationId
          || !semanticJsonEqual(inboxPayload.event, payload)
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
