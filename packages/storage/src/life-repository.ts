import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  canonicalizeJson,
  reduceLifeState,
  type Effect,
  type EventEnvelope,
  type Grant,
  type JsonObject,
  type JsonValue,
  type LifeState,
  type CoreEvent,
  type InboxCoreEvent,
} from "@oren/kernel";

interface OutboxRow {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: Effect;
  readonly attempts: number;
}

export interface InboxItem {
  readonly inboxId: string;
  readonly orenId: string;
  readonly correlationId: string;
  readonly event: InboxCoreEvent;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

type TerminalEffectEvent =
  | Extract<CoreEvent, { type: "EffectCompleted" }>
  | Extract<CoreEvent, { type: "EffectFailed" }>
  | Extract<CoreEvent, { type: "EffectUncertain" }>;

type NonterminalEffectStatus = "pending" | "dispatched";
type TerminalEffectStatus = "completed" | "failed" | "uncertain" | "cancelled";

const TERMINAL_EFFECT_STATUSES = new Set<string>([
  "completed",
  "failed",
  "uncertain",
  "cancelled",
]);

function parseSafeAttemptCount(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const attempts = Number(value);
  return Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : undefined;
}

function isClaimableEffectState(
  status: string,
  attempts: number,
): status is NonterminalEffectStatus {
  return status === "pending"
    ? attempts === 0
    : status === "dispatched"
      && attempts >= 1
      && attempts < Number.MAX_SAFE_INTEGER;
}

function isValidEffectState(
  status: string,
  attempts: number,
): status is NonterminalEffectStatus | TerminalEffectStatus {
  if (status === "pending") return attempts === 0;
  if (status === "dispatched") return attempts >= 1;
  return TERMINAL_EFFECT_STATUSES.has(status);
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalizeEffect(value: unknown): Effect | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const effect = canonical.value;
  return hasExactKeys(effect, [
      "effectId",
      "orenId",
      "correlationId",
      "capability",
      "arguments",
      "grantIds",
      "stateVersion",
    ])
    && typeof effect.effectId === "string"
    && typeof effect.orenId === "string"
    && typeof effect.correlationId === "string"
    && typeof effect.capability === "string"
    && isRecord(effect.arguments)
    && Array.isArray(effect.grantIds)
    && effect.grantIds.every((grantId) => typeof grantId === "string")
    && Number.isSafeInteger(effect.stateVersion)
    && Number(effect.stateVersion) >= 0
    ? effect as unknown as Effect
    : undefined;
}

function canonicalizeTerminalEffectEvent(value: unknown): TerminalEffectEvent | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const event = canonical.value;
  if (typeof event.effectId !== "string") return undefined;
  if (event.type === "EffectCompleted") {
    return hasExactKeys(event, ["type", "effectId", "receipt"])
      && isRecord(event.receipt)
      ? event as unknown as TerminalEffectEvent
      : undefined;
  }
  if (event.type === "EffectFailed") {
    return hasExactKeys(event, ["type", "effectId", "code", "message"])
      && typeof event.code === "string"
      && typeof event.message === "string"
      ? event as unknown as TerminalEffectEvent
      : undefined;
  }
  if (event.type === "EffectUncertain") {
    return hasExactKeys(event, ["type", "effectId", "message"])
      && typeof event.message === "string"
      ? event as unknown as TerminalEffectEvent
      : undefined;
  }
  return undefined;
}

function canonicalizeInboxEvent(value: unknown): InboxCoreEvent | undefined {
  const terminal = canonicalizeTerminalEffectEvent(value);
  if (terminal) return terminal;
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const event = canonical.value;
  return event.type === "WakeDue"
    && hasExactKeys(event, ["type", "scheduleId", "purpose"])
    && typeof event.scheduleId === "string"
    && typeof event.purpose === "string"
    ? event as unknown as InboxCoreEvent
    : undefined;
}

function canonicalizeInboxPayload(value: unknown): {
  readonly correlationId: string;
  readonly event: InboxCoreEvent;
} | undefined {
  const canonical = canonicalizeJson(value);
  if (
    !canonical.ok
    || !isRecord(canonical.value)
    || !hasExactKeys(canonical.value, ["correlationId", "event"])
    || typeof canonical.value.correlationId !== "string"
  ) {
    return undefined;
  }
  const event = canonicalizeInboxEvent(canonical.value.event);
  return event
    ? { correlationId: canonical.value.correlationId, event }
    : undefined;
}

function semanticJsonEqual(left: JsonValue, right: JsonValue): boolean {
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
    && leftKeys.every((key, index) => {
      const leftValue = left[key];
      const rightValue = right[key];
      return key === rightKeys[index]
        && leftValue !== undefined
        && rightValue !== undefined
        && semanticJsonEqual(leftValue, rightValue);
    });
}

export class SqliteLifeRepository {
  public constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly nextLeaseToken: () => string = randomUUID,
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

  public loadState(orenId: string): LifeState {
    return this.rehydrate(orenId);
  }

  public commit(orenId: string, events: readonly EventEnvelope[]): void {
    const effects = events.flatMap((event) =>
      event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
    this.appendAndEnqueueEffects(orenId, events, effects);
  }

  public commitIfVersion(
    orenId: string,
    expectedVersion: number,
    events: readonly EventEnvelope[],
  ): boolean {
    const effects = events.flatMap((event) =>
      event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
    this.validateOrenIdentities(orenId, events, effects);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.rehydrate(orenId).version !== expectedVersion) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.insertEventsAndSideTables(orenId, events, effects);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public appendAndEnqueueEffects(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    this.validateOrenIdentities(orenId, events, effects);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertEventsAndSideTables(orenId, events, effects);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEventsAndSideTables(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    const insertEvent = this.db.prepare(`
      INSERT INTO events(event_id, oren_id, recorded_at, envelope_json) VALUES (?, ?, ?, ?)
    `);
    for (const event of events) {
      insertEvent.run(event.eventId, orenId, event.recordedAt, JSON.stringify(event));
      if (event.payload.type === "WakeScheduled") {
        const existing = this.db.prepare(`
          SELECT oren_id FROM schedules WHERE schedule_id = ?
        `).get(event.payload.scheduleId);
        if (existing && String(existing.oren_id) !== orenId) {
          throw new Error(
            `Schedule ${event.payload.scheduleId} already belongs to ${String(existing.oren_id)}`,
          );
        }
        const scheduled = this.db.prepare(`
          INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(schedule_id) DO UPDATE SET
            due_at = excluded.due_at,
            purpose = excluded.purpose,
            delivered_at = NULL
          WHERE schedules.oren_id = excluded.oren_id
        `).run(
          event.payload.scheduleId,
          orenId,
          event.payload.at,
          event.payload.purpose,
        );
        if (Number(scheduled.changes) !== 1) {
          throw new Error(`Schedule ${event.payload.scheduleId} did not transition`);
        }
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
  }

  public claimInbox(
    worker: string,
    now = this.now(),
    limit = 32,
  ): InboxItem[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Inbox claim limit must be a nonnegative safe integer");
    }
    if (limit === 0) return [];
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("Inbox claim time must be a valid timestamp");
    const leaseUntil = new Date(nowMs + 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT inbox_id, oren_id, payload_json
        FROM inbox
        WHERE processed_at IS NULL
          AND available_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM inbox_quarantine
            WHERE inbox_quarantine.inbox_id = inbox.inbox_id
          )
        ORDER BY priority DESC, rowid
      `).all(now, now);
      const quarantine = this.db.prepare(`
        INSERT OR IGNORE INTO inbox_quarantine(inbox_id, reason, quarantined_at)
        VALUES (?, ?, ?)
      `);
      const lease = this.db.prepare(`
        UPDATE inbox
        SET lease_owner = ?, lease_token = ?, lease_until = ?
        WHERE inbox_id = ? AND processed_at IS NULL
          AND (lease_until IS NULL OR lease_until <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM inbox_quarantine
            WHERE inbox_quarantine.inbox_id = inbox.inbox_id
          )
      `);
      const claimed: InboxItem[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        const inboxId = String(row.inbox_id);
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(row.payload_json));
        } catch {
          quarantine.run(inboxId, "inbox payload_json is not valid JSON", now);
          continue;
        }
        const payload = canonicalizeInboxPayload(parsed);
        if (!payload) {
          quarantine.run(inboxId, "inbox payload_json is not a supported payload", now);
          continue;
        }
        const leaseToken = this.nextLeaseToken();
        const leased = lease.run(worker, leaseToken, leaseUntil, inboxId, now);
        if (Number(leased.changes) !== 1) continue;
        claimed.push({
          inboxId,
          orenId: String(row.oren_id),
          correlationId: payload.correlationId,
          event: payload.event,
          leaseOwner: worker,
          leaseToken,
        });
      }
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public commitInbox(
    inboxId: string,
    orenId: string,
    leaseOwner: string,
    leaseToken: string,
    events: readonly EventEnvelope[],
    now = this.now(),
  ): boolean {
    this.validateOrenIdentities(orenId, events, []);
    if (events.length === 0) throw new Error("Inbox commit requires at least one event");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT oren_id, payload_json
        FROM inbox WHERE inbox_id = ?
      `).get(inboxId);
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (String(row.oren_id) !== orenId) {
        throw new Error(`Inbox ${inboxId} belongs to another Oren`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.payload_json));
      } catch {
        throw new Error(`Inbox ${inboxId} payload is corrupt`);
      }
      const payload = canonicalizeInboxPayload(parsed);
      const accepted = events[0]!;
      const canonicalAccepted = canonicalizeJson(accepted.payload);
      const canonicalDurableEvent = payload
        ? canonicalizeJson(payload.event)
        : { ok: false as const, reason: "missing payload" };
      if (
        !payload
        || accepted.correlationId !== payload.correlationId
        || !canonicalAccepted.ok
        || !canonicalDurableEvent.ok
        || !semanticJsonEqual(canonicalAccepted.value, canonicalDurableEvent.value)
      ) {
        throw new Error(`Inbox ${inboxId} event identity does not match its durable payload`);
      }
      const requestedIndex = events.findIndex(
        (event) => event.payload.type === "CognitionRequested",
      );
      const requested = requestedIndex >= 0 ? events[requestedIndex] : undefined;
      if (
        requested?.payload.type === "CognitionRequested"
        && requested.payload.baseStateVersion
          !== this.rehydrate(orenId).version + requestedIndex + 1
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const committed = this.db.prepare(`
        UPDATE inbox
        SET processed_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE inbox_id = ? AND oren_id = ? AND processed_at IS NULL
          AND lease_owner = ? AND lease_token = ? AND lease_until > ?
      `).run(now, inboxId, orenId, leaseOwner, leaseToken, now);
      if (Number(committed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const effects = events.flatMap((event) =>
        event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
      this.insertEventsAndSideTables(orenId, events, effects);
      this.db.exec("COMMIT");
      return true;
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
      if (
        typeof event.eventId !== "string"
        || typeof event.orenId !== "string"
        || event.schemaVersion !== 1
        || typeof event.occurredAt !== "string"
        || typeof event.recordedAt !== "string"
        || typeof event.source !== "string"
        || (event.causationId !== null && typeof event.causationId !== "string")
        || typeof event.correlationId !== "string"
        || typeof event.payload !== "object"
        || event.payload === null
        || typeof event.payload.type !== "string"
      ) {
        throw new Error("Invalid event envelope identity");
      }
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

  public claimDue(now: string, limit: number): Array<{
    readonly scheduleId: string;
    readonly orenId: string;
    readonly purpose: string;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Schedule claim limit must be a nonnegative safe integer");
    }
    if (limit === 0) return [];
    return this.db.prepare(`
      SELECT schedule_id, oren_id, purpose
      FROM schedules
      WHERE due_at <= ? AND delivered_at IS NULL
      ORDER BY due_at, schedule_id
      LIMIT ?
    `).all(now, limit).map((row) => ({
      scheduleId: String(row.schedule_id),
      orenId: String(row.oren_id),
      purpose: String(row.purpose),
    }));
  }

  public deliverWake(
    schedule: string | { readonly scheduleId: string },
    now = this.now(),
  ): boolean {
    const scheduleId = typeof schedule === "string" ? schedule : schedule.scheduleId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT oren_id, due_at, purpose, delivered_at
        FROM schedules WHERE schedule_id = ?
      `).get(scheduleId);
      if (
        !row
        || row.delivered_at !== null
        || String(row.due_at) > now
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const orenId = String(row.oren_id);
      const dueAt = String(row.due_at);
      const purpose = String(row.purpose);
      const delivered = this.db.prepare(`
        UPDATE schedules
        SET delivered_at = ?
        WHERE schedule_id = ? AND oren_id = ? AND due_at = ? AND purpose = ?
          AND delivered_at IS NULL AND due_at <= ?
      `).run(now, scheduleId, orenId, dueAt, purpose, now);
      if (Number(delivered.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        INSERT INTO inbox(inbox_id, oren_id, priority, available_at, payload_json)
        VALUES (?, ?, 2, ?, ?)
      `).run(
        `wake:${scheduleId}`,
        orenId,
        now,
        JSON.stringify({
          correlationId: `schedule:${scheduleId}`,
          event: { type: "WakeDue", scheduleId, purpose },
        }),
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
          CAST(outbox.attempts AS TEXT) AS attempts_text,
          operations.effect_id AS operation_effect_id,
          operations.oren_id AS operation_oren_id,
          operations.capability AS operation_capability,
          operations.status AS operation_status,
          CAST(operations.attempts AS TEXT) AS operation_attempts_text,
          operations.quarantined AS operation_quarantined
        FROM outbox
        LEFT JOIN operations ON operations.effect_id = outbox.effect_id
        WHERE outbox.quarantined = 0
          AND outbox.status IN ('pending','dispatched')
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
        WHERE effect_id = ? AND quarantined = 0 AND status = ? AND attempts = ?
      `);
      const updateOperation = this.db.prepare(`
        UPDATE operations
        SET status = 'dispatched', attempts = attempts + 1
        WHERE effect_id = ? AND oren_id = ? AND capability = ?
          AND quarantined = 0 AND status = ? AND attempts = ?
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
        const effect = canonicalizeEffect(parsed);
        if (effect === undefined) {
          quarantine.run(effectId, "outbox effect_json is not a valid Effect", now);
          continue;
        }
        const outboxOrenId = String(row.oren_id);
        const outboxCapability = String(row.capability);
        if (
          effect.effectId !== effectId
          || effect.orenId !== outboxOrenId
          || effect.capability !== outboxCapability
        ) {
          quarantine.run(effectId, "outbox effect identity does not match its columns", now);
          continue;
        }
        const outboxStatus = String(row.status);
        const outboxAttempts = parseSafeAttemptCount(row.attempts_text);
        const operationAttempts = parseSafeAttemptCount(row.operation_attempts_text);
        if (
          outboxAttempts === undefined
          || operationAttempts === undefined
          || !isClaimableEffectState(outboxStatus, outboxAttempts)
          || !isClaimableEffectState(String(row.operation_status), operationAttempts)
        ) {
          quarantine.run(effectId, "outbox or operation has an invalid status/attempt state", now);
          continue;
        }
        if (
          row.operation_effect_id === null
          || String(row.operation_oren_id) !== outboxOrenId
          || String(row.operation_capability) !== outboxCapability
          || String(row.operation_status) !== outboxStatus
          || operationAttempts !== outboxAttempts
          || Number(row.operation_quarantined) !== 0
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
          effect,
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
    const canonicalPayload = canonicalizeTerminalEffectEvent(payload);
    if (canonicalPayload === undefined) {
      throw new Error("Invalid effect terminal payload");
    }
    if (canonicalPayload.effectId !== effectId) {
      throw new Error(`Effect terminal payload identity does not match ${effectId}`);
    }
    const status = canonicalPayload.type === "EffectCompleted"
      ? "completed"
      : canonicalPayload.type === "EffectFailed"
        ? "failed"
        : "uncertain";
    const receipt = JSON.stringify(canonicalPayload);
    const inboxPayload = JSON.stringify({ correlationId, event: canonicalPayload });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const outbox = this.db.prepare(`
        SELECT
          oren_id,
          capability,
          effect_json,
          status,
          CAST(attempts AS TEXT) AS attempts_text,
          receipt_json,
          quarantined
        FROM outbox WHERE effect_id = ?
      `).get(effectId);
      if (!outbox) {
        throw new Error(`Effect ${effectId} not found`);
      }
      const effect = canonicalizeEffect(JSON.parse(String(outbox.effect_json)));
      if (
        effect === undefined
        ||
        String(outbox.oren_id) !== orenId
        || Number(outbox.quarantined) !== 0
        || effect.effectId !== effectId
        || effect.orenId !== orenId
        || effect.correlationId !== correlationId
        || effect.capability !== String(outbox.capability)
      ) {
        throw new Error(`Effect ${effectId} identity does not match persisted outbox row`);
      }

      const operation = this.db.prepare(`
        SELECT
          oren_id,
          capability,
          status,
          CAST(attempts AS TEXT) AS attempts_text,
          receipt_json,
          quarantined
        FROM operations WHERE effect_id = ?
      `).get(effectId);
      if (
        !operation
        || Number(operation.quarantined) !== 0
        || String(operation.oren_id) !== orenId
        || String(operation.capability) !== effect.capability
      ) {
        throw new Error(`Effect ${effectId} operation identity does not match outbox row`);
      }

      const outboxStatus = String(outbox.status);
      const operationStatus = String(operation.status);
      const outboxAttempts = parseSafeAttemptCount(outbox.attempts_text);
      const operationAttempts = parseSafeAttemptCount(operation.attempts_text);
      if (
        outboxAttempts === undefined
        || operationAttempts === undefined
        || outboxStatus !== operationStatus
        || outboxAttempts !== operationAttempts
        || !isValidEffectState(outboxStatus, outboxAttempts)
        || !isValidEffectState(operationStatus, operationAttempts)
      ) {
        throw new Error(`Effect ${effectId} durable status/attempt state is inconsistent`);
      }
      if (TERMINAL_EFFECT_STATUSES.has(outboxStatus)) {
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
        const canonicalOutboxReceipt = canonicalizeTerminalEffectEvent(outboxReceipt);
        const canonicalOperationReceipt = canonicalizeTerminalEffectEvent(operationReceipt);
        if (
          canonicalOutboxReceipt === undefined
          || canonicalOperationReceipt === undefined
          || !semanticJsonEqual(canonicalOutboxReceipt, canonicalOperationReceipt)
        ) {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        if (
          outboxStatus !== status
          || !semanticJsonEqual(canonicalOutboxReceipt, canonicalPayload)
        ) {
          throw new Error(`Effect ${effectId} conflicts with durable terminal result`);
        }
        const inbox = this.db.prepare(`
          SELECT oren_id, payload_json FROM inbox WHERE inbox_id = ?
        `).get(`effect-result:${effectId}`);
        let parsedInboxPayload: unknown;
        try {
          parsedInboxPayload = inbox ? JSON.parse(String(inbox.payload_json)) : null;
        } catch {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        const canonicalInboxPayload = canonicalizeJson(parsedInboxPayload);
        if (
          !inbox
          || String(inbox.oren_id) !== orenId
          || !canonicalInboxPayload.ok
          || !isRecord(canonicalInboxPayload.value)
          || !hasExactKeys(canonicalInboxPayload.value, ["correlationId", "event"])
          || canonicalInboxPayload.value.correlationId !== correlationId
          || canonicalInboxPayload.value.event === undefined
          || !semanticJsonEqual(canonicalInboxPayload.value.event, canonicalPayload)
        ) {
          throw new Error(`Effect ${effectId} terminal state is inconsistent`);
        }
        this.db.exec("COMMIT");
        return;
      }
      const outboxUpdate = this.db.prepare(`
        UPDATE outbox
        SET status = ?, receipt_json = ?, lease_owner = NULL, lease_until = NULL
        WHERE effect_id = ? AND oren_id = ?
          AND quarantined = 0 AND status = ? AND attempts = ?
      `).run(status, receipt, effectId, orenId, outboxStatus, outboxAttempts);
      if (Number(outboxUpdate.changes) !== 1) {
        throw new Error(`Effect ${effectId} outbox did not transition`);
      }
      const operationUpdate = this.db.prepare(`
        UPDATE operations
        SET status = ?, receipt_json = ?
        WHERE effect_id = ? AND oren_id = ?
          AND quarantined = 0 AND status = ? AND attempts = ?
      `).run(status, receipt, effectId, orenId, operationStatus, operationAttempts);
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
        inboxPayload,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
