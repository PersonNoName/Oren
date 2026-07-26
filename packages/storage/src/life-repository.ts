import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  canonicalizeCoreEvent,
  canonicalizeEffect as canonicalizeKernelEffect,
  canonicalizeEventEnvelope,
  canonicalizeInstant,
  canonicalizeJson,
  hasValidLifeStateBudgets,
  reduceLifeState,
  type Effect,
  type EventEnvelope,
  type Grant,
  type CognitionJob,
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

function semanticUnknownEqual(left: unknown, right: unknown): boolean {
  const canonicalLeft = canonicalizeJson(left);
  const canonicalRight = canonicalizeJson(right);
  return canonicalLeft.ok
    && canonicalRight.ok
    && semanticJsonEqual(canonicalLeft.value, canonicalRight.value);
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
    if (!hasValidLifeStateBudgets(state)) {
      throw new Error("Initial LifeState contains invalid budgets");
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO snapshots(oren_id, version, cursor, state_json)
      VALUES (?, ?, ?, ?)
    `).run(state.orenId, state.version, state.chronicleCursor, JSON.stringify(state));
  }

  public initializeWithGrant(state: LifeState, grant: Grant): void {
    if (!hasValidLifeStateBudgets(state)) {
      throw new Error("Initial LifeState contains invalid budgets");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = this.db.prepare(`
        SELECT state_json FROM snapshots WHERE oren_id = ?
      `).get(state.orenId);
      if (snapshot) {
        let existingState: LifeState;
        try {
          existingState = JSON.parse(String(snapshot.state_json)) as LifeState;
        } catch {
          throw new Error(`Initial snapshot for ${state.orenId} is corrupt`);
        }
        if (
          !hasValidLifeStateBudgets(existingState)
          || existingState.orenId !== state.orenId
          || existingState.relationship.primaryPersonId
            !== state.relationship.primaryPersonId
        ) {
          throw new Error(`Initial snapshot identity for ${state.orenId} conflicts`);
        }
      }

      const existingGrant = this.db.prepare(`
        SELECT oren_id, grant_json, revoked_at FROM grants WHERE grant_id = ?
      `).get(grant.grantId);
      if (existingGrant) {
        let storedGrant: unknown;
        try {
          storedGrant = JSON.parse(String(existingGrant.grant_json));
        } catch {
          throw new Error(`Grant ${grant.grantId} is corrupt`);
        }
        if (
          String(existingGrant.oren_id) !== state.orenId
          || existingGrant.revoked_at !== null
          || !semanticUnknownEqual(storedGrant, grant)
        ) {
          throw new Error(`Grant ${grant.grantId} conflicts with runtime identity`);
        }
      }

      if (!snapshot) {
        this.db.prepare(`
          INSERT INTO snapshots(oren_id, version, cursor, state_json)
          VALUES (?, ?, ?, ?)
        `).run(
          state.orenId,
          state.version,
          state.chronicleCursor,
          JSON.stringify(state),
        );
      }
      if (!existingGrant) {
        this.db.prepare(`
          INSERT INTO grants(grant_id, oren_id, grant_json, revoked_at)
          VALUES (?, ?, ?, NULL)
        `).run(grant.grantId, state.orenId, JSON.stringify(grant));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public listLifeIdentities(): Array<{
    readonly orenId: string;
    readonly personId: string;
  }> {
    return this.db.prepare(`
      SELECT oren_id, state_json FROM snapshots ORDER BY oren_id
    `).all().map((row) => {
      let state: LifeState;
      try {
        state = JSON.parse(String(row.state_json)) as LifeState;
      } catch {
        throw new Error(`Initial snapshot for ${String(row.oren_id)} is corrupt`);
      }
      if (
        state.orenId !== String(row.oren_id)
        || typeof state.relationship?.primaryPersonId !== "string"
        || !hasValidLifeStateBudgets(state)
      ) {
        throw new Error(`Initial snapshot for ${String(row.oren_id)} is invalid`);
      }
      return {
        orenId: state.orenId,
        personId: state.relationship.primaryPersonId,
      };
    });
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

  public loadGrants(orenId: string, options?: { readonly includeRevoked?: boolean }): Grant[] {
    if (options?.includeRevoked === true) {
      return this.db.prepare(`
        SELECT grant_json, revoked_at FROM grants WHERE oren_id = ?
      `).all(orenId).map((row) => {
        const grant = JSON.parse(String(row.grant_json)) as Grant;
        return { ...grant, revoked: row.revoked_at !== null };
      });
    }
    return this.db.prepare(`
      SELECT grant_json FROM grants WHERE oren_id = ? AND revoked_at IS NULL
    `).all(orenId).map((row) => JSON.parse(String(row.grant_json)) as Grant);
  }

  public listSchedulesForOren(orenId: string): Array<{
    readonly scheduleId: string;
    readonly dueAt: string;
    readonly purpose: string;
  }> {
    return this.db.prepare(`
      SELECT schedule_id, due_at, purpose
      FROM schedules
      WHERE oren_id = ?
        AND delivered_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM schedule_quarantine
          WHERE schedule_quarantine.schedule_id = schedules.schedule_id
        )
      ORDER BY due_at
    `).all(orenId).flatMap((row) => {
      const dueAt = canonicalizeInstant(String(row.due_at));
      if (!dueAt) return [];
      return [{
        scheduleId: String(row.schedule_id),
        dueAt,
        purpose: String(row.purpose),
      }];
    });
  }

  public revokeGrant(orenId: string, grantId: string, revokedAtIso: string): boolean {
    const canonicalRevokedAt = canonicalizeInstant(revokedAtIso);
    if (!canonicalRevokedAt) {
      throw new Error("Grant revocation time must be a valid instant");
    }
    const result = this.db.prepare(`
      UPDATE grants
      SET revoked_at = ?
      WHERE grant_id = ? AND oren_id = ? AND revoked_at IS NULL
    `).run(canonicalRevokedAt, grantId, orenId);
    return Number(result.changes) === 1;
  }

  public loadEvents(orenId: string): EventEnvelope[] {
    return this.loadEventsAfter(orenId, 0);
  }

  public loadEventRecordsAfter(sequence: number): Array<{
    readonly sequence: number;
    readonly envelope: EventEnvelope;
  }> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Event record cursor must be a nonnegative safe integer");
    }
    return this.db.prepare(`
      SELECT sequence, envelope_json FROM events
      WHERE sequence > ?
      ORDER BY sequence
    `).all(sequence).flatMap((row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.envelope_json));
      } catch {
        return [];
      }
      const envelope = canonicalizeEventEnvelope(parsed);
      return envelope ? [{ sequence: Number(row.sequence), envelope }] : [];
    });
  }

  public loadPendingCognitionJobs(): CognitionJob[] {
    const pending = new Map<string, CognitionJob>();
    const rows = this.db.prepare(`
      SELECT envelope_json FROM events ORDER BY sequence
    `).all();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.envelope_json));
      } catch {
        continue;
      }
      const event = canonicalizeEventEnvelope(parsed);
      if (!event) continue;
      if (event.payload.type === "CognitionRequested") {
        const job: CognitionJob = {
          orenId: event.orenId,
          episodeId: event.payload.episodeId,
          baseStateVersion: event.payload.baseStateVersion,
          triggerKind: event.payload.triggerKind,
          correlationId: event.correlationId,
        };
        pending.set(this.cognitionJobKey(job), job);
        continue;
      }
      if (event.payload.type === "CognitionCompleted") {
        pending.delete(this.cognitionJobKey({
          orenId: event.orenId,
          episodeId: event.payload.episodeId,
          baseStateVersion: event.payload.baseStateVersion,
          triggerKind: "foreground_user",
          correlationId: event.correlationId,
        }));
        continue;
      }
      if (
        event.payload.type === "CognitionDenied"
        || event.payload.type === "CognitionWaitingForEffect"
        || event.payload.type === "CognitionFailed"
        || event.payload.type === "EpisodeInterrupted"
      ) {
        for (const [key, job] of pending) {
          if (
            job.orenId === event.orenId
            && job.episodeId === event.payload.episodeId
            && job.correlationId === event.correlationId
          ) {
            pending.delete(key);
          }
        }
      }
    }
    return [...pending.values()];
  }

  public isPendingCognitionJob(job: CognitionJob): boolean {
    const key = this.cognitionJobKey(job);
    return this.loadPendingCognitionJobs().some(
      (pending) => this.cognitionJobKey(pending) === key,
    );
  }

  public hasImmediateWork(now = this.now()): boolean {
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Immediate-work time must be a valid instant");
    if (this.loadPendingCognitionJobs().length > 0) return true;
    const nowMs = Date.parse(canonicalNow);

    const schedules = this.db.prepare(`
      SELECT due_at
      FROM schedules
      WHERE delivered_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM schedule_quarantine
          WHERE schedule_quarantine.schedule_id = schedules.schedule_id
        )
    `).all();
    if (schedules.some((row) => {
      const dueAt = canonicalizeInstant(row.due_at);
      return dueAt === undefined || Date.parse(dueAt) <= nowMs;
    })) {
      return true;
    }

    const effects = this.db.prepare(`
      SELECT 1
      FROM outbox
      WHERE quarantined = 0
        AND status IN ('pending', 'dispatched')
        AND (lease_until IS NULL OR lease_until <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM effect_quarantine
          WHERE effect_quarantine.effect_id = outbox.effect_id
        )
      LIMIT 1
    `).get(canonicalNow);
    if (effects) return true;

    const inbox = this.db.prepare(`
      SELECT available_at, lease_until
      FROM inbox
      WHERE processed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM inbox_quarantine
          WHERE inbox_quarantine.inbox_id = inbox.inbox_id
        )
    `).all();
    return inbox.some((row) => {
      const availableAt = canonicalizeInstant(row.available_at);
      if (availableAt === undefined) return true;
      const leaseUntil = row.lease_until === null
        ? null
        : canonicalizeInstant(row.lease_until);
      if (leaseUntil === undefined) return true;
      return Date.parse(availableAt) <= nowMs
        && (leaseUntil === null || Date.parse(leaseUntil) <= nowMs);
    });
  }

  private cognitionJobKey(job: CognitionJob): string {
    return [
      job.orenId,
      job.episodeId,
      job.correlationId,
      String(job.baseStateVersion),
    ].join("\0");
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
    const canonicalEvents = this.canonicalEvents(orenId, events);
    const effects = canonicalEvents.flatMap((event) =>
      event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
    this.appendCanonicalEventsAndEffects(orenId, canonicalEvents, effects);
  }

  public commitIfVersion(
    orenId: string,
    expectedVersion: number,
    events: readonly EventEnvelope[],
  ): boolean {
    const canonicalEvents = this.canonicalEvents(orenId, events);
    const effects = canonicalEvents.flatMap((event) =>
      event.payload.type === "EffectRequested" ? [event.payload.effect] : []);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.rehydrate(orenId);
      if (current.version !== expectedVersion) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.validateStateTransition(current, canonicalEvents);
      this.insertEventsAndSideTables(orenId, canonicalEvents, effects);
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
    const canonicalEvents = this.canonicalEvents(orenId, events);
    const canonicalEffects = effects.map((effect) => {
      const canonical = canonicalizeKernelEffect(effect);
      if (!canonical) throw new Error("Invalid Effect payload");
      if (canonical.orenId !== orenId) {
        throw new Error(`Effect ${canonical.effectId} orenId does not match ${orenId}`);
      }
      return canonical;
    });
    this.appendCanonicalEventsAndEffects(orenId, canonicalEvents, canonicalEffects);
  }

  private appendCanonicalEventsAndEffects(
    orenId: string,
    events: readonly EventEnvelope[],
    effects: readonly Effect[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (events.length > 0) this.validateStateTransition(this.rehydrate(orenId), events);
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
          SELECT oren_id, due_at, purpose, delivered_at
          FROM schedules WHERE schedule_id = ?
        `).get(event.payload.scheduleId);
        if (existing) {
          const existingDueAt = canonicalizeInstant(String(existing.due_at));
          if (
            String(existing.oren_id) !== orenId
            || existingDueAt !== event.payload.at
            || String(existing.purpose) !== event.payload.purpose
          ) {
            throw new Error(`One-shot schedule ${event.payload.scheduleId} conflicts`);
          }
          if (existing.delivered_at !== null) {
            throw new Error(`One-shot schedule ${event.payload.scheduleId} was already delivered`);
          }
          if (String(existing.due_at) !== event.payload.at) {
            this.db.prepare(`
              UPDATE schedules SET due_at = ? WHERE schedule_id = ?
            `).run(event.payload.at, event.payload.scheduleId);
          }
        } else {
          this.db.prepare(`
            INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
            VALUES (?, ?, ?, ?)
          `).run(
            event.payload.scheduleId,
            orenId,
            event.payload.at,
            event.payload.purpose,
          );
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
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Inbox claim time must be a valid instant");
    if (limit === 0) return [];
    const nowMs = Date.parse(canonicalNow);
    let leaseUntil: string;
    try {
      leaseUntil = new Date(nowMs + 60_000).toISOString();
    } catch {
      throw new Error("Inbox claim time cannot produce a valid lease instant");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT
          inbox_id,
          oren_id,
          available_at,
          payload_json,
          lease_owner,
          lease_token,
          lease_until
        FROM inbox
        WHERE processed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM inbox_quarantine
            WHERE inbox_quarantine.inbox_id = inbox.inbox_id
          )
        ORDER BY priority DESC, rowid
      `).all();
      const quarantine = this.db.prepare(`
        INSERT OR IGNORE INTO inbox_quarantine(inbox_id, reason, quarantined_at)
        VALUES (?, ?, ?)
      `);
      const normalizeTimes = this.db.prepare(`
        UPDATE inbox
        SET available_at = ?, lease_until = ?
        WHERE inbox_id = ? AND processed_at IS NULL
          AND available_at IS ?
          AND lease_owner IS ?
          AND lease_token IS ?
          AND lease_until IS ?
          AND NOT EXISTS (
            SELECT 1 FROM inbox_quarantine
            WHERE inbox_quarantine.inbox_id = inbox.inbox_id
          )
      `);
      const lease = this.db.prepare(`
        UPDATE inbox
        SET available_at = ?, lease_owner = ?, lease_token = ?, lease_until = ?
        WHERE inbox_id = ? AND processed_at IS NULL
          AND available_at IS ?
          AND lease_owner IS ?
          AND lease_token IS ?
          AND lease_until IS ?
          AND NOT EXISTS (
            SELECT 1 FROM inbox_quarantine
            WHERE inbox_quarantine.inbox_id = inbox.inbox_id
          )
      `);
      const claimed: InboxItem[] = [];
      for (const row of rows) {
        if (claimed.length >= limit) break;
        const inboxId = String(row.inbox_id);
        const durableAvailableAt = row.available_at;
        const durableLeaseOwner = row.lease_owner;
        const durableLeaseToken = row.lease_token;
        const durableLeaseValue = row.lease_until;
        if (
          durableAvailableAt === undefined
          || durableLeaseOwner === undefined
          || durableLeaseToken === undefined
          || durableLeaseValue === undefined
        ) {
          throw new Error("Inbox claim query omitted durable lease state");
        }
        const availableAt = canonicalizeInstant(durableAvailableAt);
        if (!availableAt) {
          quarantine.run(inboxId, "inbox available_at is not a valid instant", canonicalNow);
          continue;
        }
        let durableLeaseUntil: string | null;
        if (durableLeaseValue === null) {
          durableLeaseUntil = null;
        } else {
          const canonicalLeaseUntil = canonicalizeInstant(durableLeaseValue);
          if (!canonicalLeaseUntil) {
            quarantine.run(inboxId, "inbox lease_until is not a valid instant", canonicalNow);
            continue;
          }
          durableLeaseUntil = canonicalLeaseUntil;
        }
        const isAvailable = Date.parse(availableAt) <= nowMs;
        const isLeaseExpired = durableLeaseUntil === null
          || Date.parse(durableLeaseUntil) <= nowMs;
        if (!isAvailable || !isLeaseExpired) {
          if (
            availableAt !== durableAvailableAt
            || durableLeaseUntil !== durableLeaseValue
          ) {
            normalizeTimes.run(
              availableAt,
              durableLeaseUntil,
              inboxId,
              durableAvailableAt,
              durableLeaseOwner,
              durableLeaseToken,
              durableLeaseValue,
            );
          }
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(row.payload_json));
        } catch {
          quarantine.run(inboxId, "inbox payload_json is not valid JSON", canonicalNow);
          continue;
        }
        const payload = canonicalizeInboxPayload(parsed);
        if (!payload) {
          quarantine.run(
            inboxId,
            "inbox payload_json is not a supported payload",
            canonicalNow,
          );
          continue;
        }
        const leaseToken = this.nextLeaseToken();
        const leased = lease.run(
          availableAt,
          worker,
          leaseToken,
          leaseUntil,
          inboxId,
          durableAvailableAt,
          durableLeaseOwner,
          durableLeaseToken,
          durableLeaseValue,
        );
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
    const canonicalEvents = this.canonicalEvents(orenId, events);
    if (canonicalEvents.length !== 2) {
      throw new Error("Inbox commit requires exactly a two-event transition");
    }
    const accepted = canonicalEvents[0]!;
    const requested = canonicalEvents[1]!;
    if (requested.payload.type !== "CognitionRequested") {
      throw new Error("Inbox transition must end with CognitionRequested");
    }
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Inbox commit time must be a valid instant");
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
      const durableEvent = payload ? canonicalizeCoreEvent(payload.event) : undefined;
      const expectedTrigger = durableEvent?.type === "WakeDue"
        ? "scheduled_wake"
        : durableEvent?.type === "EffectCompleted"
          || durableEvent?.type === "EffectFailed"
          || durableEvent?.type === "EffectUncertain"
          ? "effect_result"
          : undefined;
      if (
        !payload
        || !durableEvent
        || expectedTrigger === undefined
        || accepted.correlationId !== payload.correlationId
        || requested.correlationId !== payload.correlationId
        || accepted.orenId !== orenId
        || requested.orenId !== orenId
        || requested.payload.triggerKind !== expectedTrigger
        || !semanticUnknownEqual(accepted.payload, durableEvent)
      ) {
        throw new Error(`Inbox ${inboxId} event identity does not match its durable payload`);
      }
      const current = this.rehydrate(orenId);
      if (requested.payload.baseStateVersion !== current.version + 2) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.validateStateTransition(current, canonicalEvents);
      const committed = this.db.prepare(`
        UPDATE inbox
        SET processed_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE inbox_id = ? AND oren_id = ? AND processed_at IS NULL
          AND lease_owner = ? AND lease_token = ? AND lease_until > ?
      `).run(canonicalNow, inboxId, orenId, leaseOwner, leaseToken, canonicalNow);
      if (Number(committed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.insertEventsAndSideTables(orenId, canonicalEvents, []);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public commitDeliverInbox(
    inboxId: string,
    orenId: string,
    leaseOwner: string,
    leaseToken: string,
    events: readonly EventEnvelope[],
    now = this.now(),
  ): boolean {
    const canonicalEvents = this.canonicalEvents(orenId, events);
    if (canonicalEvents.length < 1 || canonicalEvents.length > 2) {
      throw new Error("Deliver inbox commit requires one or two events");
    }
    const accepted = canonicalEvents[0]!;
    if (accepted.payload.type !== "WakeDue") {
      throw new Error("Deliver inbox transition must begin with WakeDue");
    }
    const deliverMatch = /^deliver:(.+)$/.exec(accepted.payload.purpose);
    if (!deliverMatch) {
      throw new Error("Deliver inbox WakeDue must use a deliver: purpose");
    }
    const deliveryId = deliverMatch[1]!;
    const followUp = canonicalEvents[1];
    if (followUp !== undefined) {
      if (
        followUp.payload.type !== "MessageDelivered"
        && followUp.payload.type !== "MessageDeliveryFailed"
      ) {
        throw new Error("Deliver inbox follow-up must be a delivery result event");
      }
      if (followUp.payload.deliveryId !== deliveryId) {
        throw new Error("Deliver inbox deliveryId must match WakeDue purpose");
      }
    }
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Inbox commit time must be a valid instant");
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
      const durableEvent = payload ? canonicalizeCoreEvent(payload.event) : undefined;
      if (
        !payload
        || !durableEvent
        || durableEvent.type !== "WakeDue"
        || accepted.correlationId !== payload.correlationId
        || accepted.orenId !== orenId
        || !semanticUnknownEqual(accepted.payload, durableEvent)
      ) {
        throw new Error(`Inbox ${inboxId} event identity does not match its durable payload`);
      }
      const current = this.rehydrate(orenId);
      this.validateStateTransition(current, canonicalEvents);
      const committed = this.db.prepare(`
        UPDATE inbox
        SET processed_at = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL
        WHERE inbox_id = ? AND oren_id = ? AND processed_at IS NULL
          AND lease_owner = ? AND lease_token = ? AND lease_until > ?
      `).run(canonicalNow, inboxId, orenId, leaseOwner, leaseToken, canonicalNow);
      if (Number(committed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.insertEventsAndSideTables(orenId, canonicalEvents, []);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public quarantineInbox(
    inboxId: string,
    leaseOwner: string,
    leaseToken: string,
    reason: string,
    now = this.now(),
  ): boolean {
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Inbox quarantine time must be a valid instant");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.db.prepare(`
        SELECT 1 FROM inbox
        WHERE inbox_id = ? AND processed_at IS NULL
          AND lease_owner = ? AND lease_token = ?
      `).get(inboxId, leaseOwner, leaseToken);
      if (!claimed) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO inbox_quarantine(inbox_id, reason, quarantined_at)
        VALUES (?, ?, ?)
      `).run(inboxId, reason, canonicalNow);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private canonicalEvents(
    orenId: string,
    events: readonly EventEnvelope[],
  ): EventEnvelope[] {
    const canonicalEvents: EventEnvelope[] = [];
    for (const event of events) {
      if (
        typeof event === "object"
        && event !== null
        && typeof event.payload === "object"
        && event.payload !== null
        && event.payload.type === "WakeScheduled"
        && canonicalizeInstant(event.payload.at) === undefined
      ) {
        throw new Error("WakeScheduled timestamp must be a valid instant");
      }
      if (
        typeof event === "object"
        && event !== null
        && typeof event.payload === "object"
        && event.payload !== null
        && event.payload.type === "EffectRequested"
        && (
          typeof event.payload.effect !== "object"
          || event.payload.effect === null
          || event.payload.effect.orenId !== orenId
        )
      ) {
        throw new Error(`EffectRequested event ${String(event.eventId)} has a mismatched orenId`);
      }
      const canonical = canonicalizeEventEnvelope(event);
      if (!canonical) {
        throw new Error("Invalid event envelope identity or exact payload variant");
      }
      if (canonical.orenId !== orenId) {
        throw new Error(`Event ${canonical.eventId} orenId does not match ${orenId}`);
      }
      if (
        canonical.payload.type === "EffectRequested"
        && canonical.payload.effect.orenId !== orenId
      ) {
        throw new Error(`EffectRequested event ${canonical.eventId} has a mismatched orenId`);
      }
      canonicalEvents.push(canonical);
    }
    return canonicalEvents;
  }

  private validateStateTransition(
    state: LifeState,
    events: readonly EventEnvelope[],
  ): void {
    if (!hasValidLifeStateBudgets(state)) throw new Error("Invalid durable LifeState budgets");
    const next = events.reduce(reduceLifeState, state);
    if (!hasValidLifeStateBudgets(next)) {
      throw new Error("Event transition produced invalid LifeState budgets");
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
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Schedule claim time must be a valid instant");
    const nowMs = Date.parse(canonicalNow);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(`
        SELECT schedule_id, oren_id, due_at, purpose
        FROM schedules
        WHERE delivered_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM schedule_quarantine
            WHERE schedule_quarantine.schedule_id = schedules.schedule_id
          )
        ORDER BY rowid
      `).all();
      const quarantine = this.db.prepare(`
        INSERT OR IGNORE INTO schedule_quarantine(schedule_id, reason, quarantined_at)
        VALUES (?, ?, ?)
      `);
      const due: Array<{
        scheduleId: string;
        orenId: string;
        purpose: string;
        dueMs: number;
      }> = [];
      for (const row of rows) {
        const scheduleId = String(row.schedule_id);
        const dueAt = canonicalizeInstant(String(row.due_at));
        if (!dueAt) {
          quarantine.run(scheduleId, "schedule due_at is not a valid instant", canonicalNow);
          continue;
        }
        const dueMs = Date.parse(dueAt);
        if (dueMs <= nowMs) {
          due.push({
            scheduleId,
            orenId: String(row.oren_id),
            purpose: String(row.purpose),
            dueMs,
          });
        }
      }
      due.sort((left, right) =>
        left.dueMs - right.dueMs || left.scheduleId.localeCompare(right.scheduleId));
      this.db.exec("COMMIT");
      return due.slice(0, limit).map(({ scheduleId, orenId, purpose }) => ({
        scheduleId,
        orenId,
        purpose,
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public deliverWake(
    schedule: string | { readonly scheduleId: string },
    now = this.now(),
  ): boolean {
    const scheduleId = typeof schedule === "string" ? schedule : schedule.scheduleId;
    const canonicalNow = canonicalizeInstant(now);
    if (!canonicalNow) throw new Error("Wake delivery time must be a valid instant");
    const nowMs = Date.parse(canonicalNow);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT oren_id, due_at, purpose, delivered_at
        FROM schedules WHERE schedule_id = ?
      `).get(scheduleId);
      if (!row || row.delivered_at !== null) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const orenId = String(row.oren_id);
      const dueAt = canonicalizeInstant(String(row.due_at));
      const purpose = String(row.purpose);
      if (!dueAt) {
        this.db.prepare(`
          INSERT OR IGNORE INTO schedule_quarantine(schedule_id, reason, quarantined_at)
          VALUES (?, ?, ?)
        `).run(scheduleId, "schedule due_at is not a valid instant", canonicalNow);
        this.db.exec("COMMIT");
        return false;
      }
      if (Date.parse(dueAt) > nowMs) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const inboxId = `wake:${scheduleId}`;
      const expectedPayload = {
        correlationId: `schedule:${scheduleId}`,
        event: { type: "WakeDue", scheduleId, purpose },
      } as const;
      const existingInbox = this.db.prepare(`
        SELECT oren_id, priority, payload_json, processed_at
        FROM inbox WHERE inbox_id = ?
      `).get(inboxId);
      if (existingInbox) {
        let existingPayload: ReturnType<typeof canonicalizeInboxPayload>;
        try {
          existingPayload = canonicalizeInboxPayload(
            JSON.parse(String(existingInbox.payload_json)),
          );
        } catch {
          existingPayload = undefined;
        }
        const canonicalExpected = canonicalizeInboxPayload(expectedPayload);
        const matching = String(existingInbox.oren_id) === orenId
          && Number(existingInbox.priority) === 2
          && existingInbox.processed_at === null
          && existingPayload !== undefined
          && canonicalExpected !== undefined
          && semanticUnknownEqual(existingPayload, canonicalExpected);
        if (!matching) {
          this.db.prepare(`
            INSERT OR IGNORE INTO schedule_quarantine(schedule_id, reason, quarantined_at)
            VALUES (?, ?, ?)
          `).run(scheduleId, "wake inbox conflicts with durable schedule", canonicalNow);
          this.db.exec("COMMIT");
          return false;
        }
      }
      const delivered = this.db.prepare(`
        UPDATE schedules
        SET delivered_at = ?
        WHERE schedule_id = ? AND oren_id = ? AND due_at = ? AND purpose = ?
          AND delivered_at IS NULL
      `).run(canonicalNow, scheduleId, orenId, String(row.due_at), purpose);
      if (Number(delivered.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (!existingInbox) {
        this.db.prepare(`
          INSERT INTO inbox(inbox_id, oren_id, priority, available_at, payload_json)
          VALUES (?, ?, 2, ?, ?)
        `).run(inboxId, orenId, canonicalNow, JSON.stringify(expectedPayload));
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public claimOutbox(worker: string, limit: number, now = this.now()): OutboxRow[] {
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
