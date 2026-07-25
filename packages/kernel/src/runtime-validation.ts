import { canonicalizeJson, type JsonObject, type JsonValue } from "./json.js";
import type {
  CoreEvent,
  Effect,
  EpisodeInterruptionReason,
  EventEnvelope,
  MemoryKind,
  Proposal,
  TriggerKind,
} from "./protocol.js";
import type { LifeState } from "./state.js";

const TRIGGERS = new Set<unknown>([
  "foreground_user",
  "effect_result",
  "commitment_due",
  "scheduled_wake",
  "health_check",
]);
const INTERRUPTION_REASONS = new Set<unknown>([
  "foreground_user",
  "shutdown",
  "trigger_priority",
  "cognition_abort",
]);
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const MEMORY_KINDS = new Set<unknown>([
  "user_statement",
  "external_fact",
  "oren_judgment",
  "oren_expression",
]);
const MAX_MEMORY_TEXT_LENGTH = 4_000;

function hasKeysWithin(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isConfidence(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonemptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMemoryText(value: JsonValue | undefined): value is string {
  return isNonemptyString(value) && value.length <= MAX_MEMORY_TEXT_LENGTH;
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

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isNullableString(value: JsonValue | undefined): value is string | null {
  return value === null || typeof value === "string";
}

function isNonnegativeSafeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function canonicalizeInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = INSTANT_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === "Z" ? 0 : Number(match[8]);
  const offsetMinute = match[7] === "Z" ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    daysInMonth === undefined
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

export function hasValidLifeStateBudgets(state: LifeState): boolean {
  const { budgets } = state;
  return Number.isSafeInteger(budgets.autonomyRemaining)
    && budgets.autonomyRemaining >= 0
    && Number.isSafeInteger(budgets.interactionMaxSteps)
    && budgets.interactionMaxSteps >= 0
    && Object.values(budgets.commitmentRemaining).every(
      (remaining) => Number.isSafeInteger(remaining) && remaining >= 0,
    );
}

export function canonicalizeEffect(value: unknown): Effect | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const effect = canonical.value;
  if (
    !hasExactKeys(effect, [
      "effectId",
      "orenId",
      "correlationId",
      "capability",
      "arguments",
      "grantIds",
      "stateVersion",
    ])
    || !isString(effect.effectId)
    || !isString(effect.orenId)
    || !isString(effect.correlationId)
    || !isString(effect.capability)
    || !isRecord(effect.arguments)
    || !Array.isArray(effect.grantIds)
    || !effect.grantIds.every(isString)
    || !isNonnegativeSafeInteger(effect.stateVersion)
  ) {
    return undefined;
  }
  return {
    effectId: effect.effectId,
    orenId: effect.orenId,
    correlationId: effect.correlationId,
    capability: effect.capability,
    arguments: effect.arguments,
    grantIds: effect.grantIds,
    stateVersion: effect.stateVersion,
  };
}

export function canonicalizeProposal(value: unknown): Proposal | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const proposal = canonical.value;
  switch (proposal.type) {
    case "NoAction":
      return hasExactKeys(proposal, ["type", "reason"]) && isString(proposal.reason)
        ? { type: "NoAction", reason: proposal.reason }
        : undefined;
    case "AdvanceThread":
      return hasExactKeys(proposal, ["type", "threadId", "summary"])
        && isString(proposal.threadId)
        && isString(proposal.summary)
        ? { type: "AdvanceThread", threadId: proposal.threadId, summary: proposal.summary }
        : undefined;
    case "UpdateDisposition":
      return hasExactKeys(proposal, ["type", "disposition", "reason"])
        && isString(proposal.disposition)
        && isString(proposal.reason)
        ? {
            type: "UpdateDisposition",
            disposition: proposal.disposition,
            reason: proposal.reason,
          }
        : undefined;
    case "ExpressToUser":
      return hasExactKeys(proposal, ["type", "text", "reason"])
        && isString(proposal.text)
        && isString(proposal.reason)
        ? { type: "ExpressToUser", text: proposal.text, reason: proposal.reason }
        : undefined;
    case "ScheduleWake": {
      const at = canonicalizeInstant(proposal.at);
      return hasExactKeys(proposal, ["type", "scheduleId", "at", "purpose"])
        && isString(proposal.scheduleId)
        && at !== undefined
        && isString(proposal.purpose)
        ? {
            type: "ScheduleWake",
            scheduleId: proposal.scheduleId,
            at,
            purpose: proposal.purpose,
          }
        : undefined;
    }
    case "Remember": {
      if (
        !hasKeysWithin(proposal, ["type", "text", "kind"], ["confidence", "reviewCondition", "threadId"])
        || !isMemoryText(proposal.text)
        || !MEMORY_KINDS.has(proposal.kind)
        || (proposal.confidence !== undefined && !isConfidence(proposal.confidence))
        || (proposal.kind === "oren_judgment" && proposal.confidence === undefined)
        || (proposal.reviewCondition !== undefined && !isNonemptyString(proposal.reviewCondition))
        || (proposal.threadId !== undefined && !isNonemptyString(proposal.threadId))
      ) {
        return undefined;
      }
      return {
        type: "Remember",
        text: proposal.text,
        kind: proposal.kind as MemoryKind,
        ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
        ...(proposal.reviewCondition !== undefined
          ? { reviewCondition: proposal.reviewCondition }
          : {}),
        ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
      };
    }
    case "ReviseBelief": {
      if (
        !hasKeysWithin(proposal, ["type", "memoryId", "confidence", "reason"], ["revisedText"])
        || !isNonemptyString(proposal.memoryId)
        || !isConfidence(proposal.confidence)
        || !isNonemptyString(proposal.reason)
        || (proposal.revisedText !== undefined && !isMemoryText(proposal.revisedText))
      ) {
        return undefined;
      }
      return {
        type: "ReviseBelief",
        memoryId: proposal.memoryId,
        confidence: proposal.confidence,
        reason: proposal.reason,
        ...(proposal.revisedText !== undefined ? { revisedText: proposal.revisedText } : {}),
      };
    }
    case "Forget":
      return hasExactKeys(proposal, ["type", "memoryId", "reason"])
        && isNonemptyString(proposal.memoryId)
        && isNonemptyString(proposal.reason)
        ? { type: "Forget", memoryId: proposal.memoryId, reason: proposal.reason }
        : undefined;
    default:
      return undefined;
  }
}

export function canonicalizeCoreEvent(value: unknown): CoreEvent | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const event = canonical.value;
  switch (event.type) {
    case "OrenInitialized":
      return hasExactKeys(event, ["type", "personId"]) && isString(event.personId)
        ? { type: "OrenInitialized", personId: event.personId }
        : undefined;
    case "UserMessageReceived":
      return hasExactKeys(event, ["type", "personId", "text"])
        && isString(event.personId)
        && isString(event.text)
        ? { type: "UserMessageReceived", personId: event.personId, text: event.text }
        : undefined;
    case "ThreadAdvanced":
      return hasExactKeys(event, ["type", "threadId", "summary"])
        && isString(event.threadId)
        && isString(event.summary)
        ? { type: "ThreadAdvanced", threadId: event.threadId, summary: event.summary }
        : undefined;
    case "DispositionUpdated":
      return hasExactKeys(event, ["type", "disposition", "reason"])
        && isString(event.disposition)
        && isString(event.reason)
        ? {
            type: "DispositionUpdated",
            disposition: event.disposition,
            reason: event.reason,
          }
        : undefined;
    case "CognitionRequested":
      return hasExactKeys(event, ["type", "episodeId", "baseStateVersion", "triggerKind"])
        && isString(event.episodeId)
        && isNonnegativeSafeInteger(event.baseStateVersion)
        && TRIGGERS.has(event.triggerKind)
        ? {
            type: "CognitionRequested",
            episodeId: event.episodeId,
            baseStateVersion: event.baseStateVersion,
            triggerKind: event.triggerKind as TriggerKind,
          }
        : undefined;
    case "AutonomyConsumed":
      return hasExactKeys(event, ["type", "episodeId", "baseStateVersion", "amount"])
        && isString(event.episodeId)
        && isNonnegativeSafeInteger(event.baseStateVersion)
        && isPositiveSafeInteger(event.amount)
        ? {
            type: "AutonomyConsumed",
            episodeId: event.episodeId,
            baseStateVersion: event.baseStateVersion,
            amount: event.amount,
          }
        : undefined;
    case "CognitionCompleted": {
      if (
        !hasExactKeys(event, ["type", "episodeId", "baseStateVersion", "proposals"])
        || !isString(event.episodeId)
        || !isNonnegativeSafeInteger(event.baseStateVersion)
        || !Array.isArray(event.proposals)
      ) {
        return undefined;
      }
      const proposals = event.proposals.map(canonicalizeProposal);
      return proposals.every((proposal) => proposal !== undefined)
        ? {
            type: "CognitionCompleted",
            episodeId: event.episodeId,
            baseStateVersion: event.baseStateVersion,
            proposals: proposals as Proposal[],
          }
        : undefined;
    }
    case "CognitionDenied":
      return hasExactKeys(event, ["type", "episodeId", "reason"])
        && isString(event.episodeId)
        && isString(event.reason)
        ? { type: "CognitionDenied", episodeId: event.episodeId, reason: event.reason }
        : undefined;
    case "CognitionWaitingForEffect":
      return hasExactKeys(event, ["type", "episodeId", "effectId"])
        && isString(event.episodeId)
        && isString(event.effectId)
        ? {
            type: "CognitionWaitingForEffect",
            episodeId: event.episodeId,
            effectId: event.effectId,
          }
        : undefined;
    case "CognitionFailed":
      return hasExactKeys(event, ["type", "episodeId", "message"])
        && isString(event.episodeId)
        && isString(event.message)
        ? { type: "CognitionFailed", episodeId: event.episodeId, message: event.message }
        : undefined;
    case "EpisodeInterrupted":
      return hasExactKeys(event, ["type", "episodeId", "reason"])
        && isString(event.episodeId)
        && INTERRUPTION_REASONS.has(event.reason)
        ? {
            type: "EpisodeInterrupted",
            episodeId: event.episodeId,
            reason: event.reason as EpisodeInterruptionReason,
          }
        : undefined;
    case "EffectRequested": {
      const effect = canonicalizeEffect(event.effect);
      return hasExactKeys(event, ["type", "effect"]) && effect
        ? { type: "EffectRequested", effect }
        : undefined;
    }
    case "EffectCompleted":
      return hasExactKeys(event, ["type", "effectId", "receipt"])
        && isString(event.effectId)
        && isRecord(event.receipt)
        ? { type: "EffectCompleted", effectId: event.effectId, receipt: event.receipt }
        : undefined;
    case "EffectFailed":
      return hasExactKeys(event, ["type", "effectId", "code", "message"])
        && isString(event.effectId)
        && isString(event.code)
        && isString(event.message)
        ? {
            type: "EffectFailed",
            effectId: event.effectId,
            code: event.code,
            message: event.message,
          }
        : undefined;
    case "EffectUncertain":
      return hasExactKeys(event, ["type", "effectId", "message"])
        && isString(event.effectId)
        && isString(event.message)
        ? { type: "EffectUncertain", effectId: event.effectId, message: event.message }
        : undefined;
    case "WakeScheduled": {
      const at = canonicalizeInstant(event.at);
      return hasExactKeys(event, ["type", "scheduleId", "at", "purpose"])
        && isString(event.scheduleId)
        && at !== undefined
        && isString(event.purpose)
        ? { type: "WakeScheduled", scheduleId: event.scheduleId, at, purpose: event.purpose }
        : undefined;
    }
    case "WakeDue":
      return hasExactKeys(event, ["type", "scheduleId", "purpose"])
        && isString(event.scheduleId)
        && isString(event.purpose)
        ? { type: "WakeDue", scheduleId: event.scheduleId, purpose: event.purpose }
        : undefined;
    case "MemoryRemembered": {
      if (
        !hasKeysWithin(
          event,
          ["type", "memoryId", "kind", "text"],
          ["confidence", "reviewCondition", "threadId"],
        )
        || !isNonemptyString(event.memoryId)
        || !MEMORY_KINDS.has(event.kind)
        || !isMemoryText(event.text)
        || (event.confidence !== undefined && !isConfidence(event.confidence))
        || (event.kind === "oren_judgment" && event.confidence === undefined)
        || (event.reviewCondition !== undefined && !isNonemptyString(event.reviewCondition))
        || (event.threadId !== undefined && !isNonemptyString(event.threadId))
      ) {
        return undefined;
      }
      return {
        type: "MemoryRemembered",
        memoryId: event.memoryId,
        kind: event.kind as MemoryKind,
        text: event.text,
        ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
        ...(event.reviewCondition !== undefined
          ? { reviewCondition: event.reviewCondition }
          : {}),
        ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
      };
    }
    case "BeliefRevised": {
      if (
        !hasKeysWithin(event, ["type", "memoryId", "confidence", "reason"], ["revisedText"])
        || !isNonemptyString(event.memoryId)
        || !isConfidence(event.confidence)
        || !isNonemptyString(event.reason)
        || (event.revisedText !== undefined && !isMemoryText(event.revisedText))
      ) {
        return undefined;
      }
      return {
        type: "BeliefRevised",
        memoryId: event.memoryId,
        confidence: event.confidence,
        reason: event.reason,
        ...(event.revisedText !== undefined ? { revisedText: event.revisedText } : {}),
      };
    }
    case "MemoryForgotten":
      return hasExactKeys(event, ["type", "memoryId", "reason"])
        && isNonemptyString(event.memoryId)
        && isNonemptyString(event.reason)
        ? { type: "MemoryForgotten", memoryId: event.memoryId, reason: event.reason }
        : undefined;
    default:
      return undefined;
  }
}

export function canonicalizeEventEnvelope(value: unknown): EventEnvelope | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const envelope = canonical.value;
  const occurredAt = canonicalizeInstant(envelope.occurredAt);
  const recordedAt = canonicalizeInstant(envelope.recordedAt);
  const payload = canonicalizeCoreEvent(envelope.payload);
  if (
    !hasExactKeys(envelope, [
      "eventId",
      "orenId",
      "schemaVersion",
      "occurredAt",
      "recordedAt",
      "source",
      "causationId",
      "correlationId",
      "payload",
    ])
    || !isString(envelope.eventId)
    || !isString(envelope.orenId)
    || envelope.schemaVersion !== 1
    || occurredAt === undefined
    || recordedAt === undefined
    || !isString(envelope.source)
    || !isNullableString(envelope.causationId)
    || !isString(envelope.correlationId)
    || payload === undefined
  ) {
    return undefined;
  }
  return {
    eventId: envelope.eventId,
    orenId: envelope.orenId,
    schemaVersion: 1,
    occurredAt,
    recordedAt,
    source: envelope.source,
    causationId: envelope.causationId,
    correlationId: envelope.correlationId,
    payload,
  };
}
