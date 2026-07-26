import { canonicalizeJson, type JsonObject, type JsonValue } from "./json.js";
import type {
  AssistantMessageStatus,
  CommitmentStatus,
  CognitionFinishReason,
  CoreEvent,
  Effect,
  EpisodeInterruptionReason,
  EventEnvelope,
  MemoryKind,
  ObservationKind,
  Proposal,
  TriggerKind,
} from "./protocol.js";
import type { LifeState } from "./state.js";
import type { DeliveryCause, QuietHours, ReachabilityPolicy } from "./reachability.js";

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
const MAX_OBSERVATION_EXCERPT_LENGTH = 8_192;
const MAX_DELIVERY_TEXT_LENGTH = 8_192;
const HH_MM_PATTERN = /^\d{2}:\d{2}$/;
const DELIVERY_CAUSES = new Set<unknown>(["quiet_hours", "frequency_cap"]);
const OBSERVATION_KINDS = new Set<unknown>(["web_search_result", "web_page"]);
const COMMITMENT_STATUSES = new Set<unknown>(["active", "paused", "done"]);
const COGNITION_FINISH_REASONS = new Set<unknown>([
  "stop",
  "max_steps",
  "waiting_for_effect",
]);
const ASSISTANT_MESSAGE_STATUSES = new Set<unknown>(["complete", "interrupted"]);

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

function isObservationExcerpt(value: JsonValue | undefined): value is string {
  return isNonemptyString(value) && value.length <= MAX_OBSERVATION_EXCERPT_LENGTH;
}

function isDeliveryText(value: JsonValue | undefined): value is string {
  return isNonemptyString(value) && value.length <= MAX_DELIVERY_TEXT_LENGTH;
}

function isQuietHours(value: JsonValue | undefined): value is QuietHours {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["start", "end", "timezone"])
    && isString(value.start)
    && HH_MM_PATTERN.test(value.start)
    && isString(value.end)
    && HH_MM_PATTERN.test(value.end)
    && value.timezone === "UTC";
}

function isReachabilityPolicy(value: JsonValue | undefined): value is ReachabilityPolicy {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "quietHours",
      "maxProactivePerDay",
      "deferWhenQuiet",
      "proactiveDayKey",
      "proactiveCountToday",
    ])
    || (value.quietHours !== null && !isQuietHours(value.quietHours))
    || !isNonnegativeSafeInteger(value.maxProactivePerDay)
    || value.deferWhenQuiet !== true
    || (value.proactiveDayKey !== null && typeof value.proactiveDayKey !== "string")
    || !isNonnegativeSafeInteger(value.proactiveCountToday)
  ) {
    return false;
  }
  return true;
}

function isCommitmentStatus(value: JsonValue | undefined): value is CommitmentStatus {
  return COMMITMENT_STATUSES.has(value);
}

function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
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
    )
    && (
      budgets.webQuotaRemaining === undefined
      || (Number.isSafeInteger(budgets.webQuotaRemaining) && budgets.webQuotaRemaining >= 0)
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
    case "InitiateContact":
      return hasExactKeys(
        proposal,
        ["type", "text", "reason", "urgency", "channel"],
      )
        && isDeliveryText(proposal.text)
        && isNonemptyString(proposal.reason)
        && ["low", "normal", "high"].includes(proposal.urgency as string)
        && proposal.channel === "panel"
        ? {
            type: "InitiateContact",
            text: proposal.text,
            reason: proposal.reason,
            urgency: proposal.urgency as "low" | "normal" | "high",
            channel: "panel",
          }
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
    case "UpsertCommitment": {
      if (
        !hasKeysWithin(
          proposal,
          ["type", "goal", "status", "nextStep", "mayAdvanceAutonomously"],
          ["commitmentId"],
        )
        || !isNonemptyString(proposal.goal)
        || !isCommitmentStatus(proposal.status)
        || !isNonemptyString(proposal.nextStep)
        || !isBoolean(proposal.mayAdvanceAutonomously)
        || (proposal.commitmentId !== undefined && !isNonemptyString(proposal.commitmentId))
      ) {
        return undefined;
      }
      return {
        type: "UpsertCommitment",
        goal: proposal.goal,
        status: proposal.status,
        nextStep: proposal.nextStep,
        mayAdvanceAutonomously: proposal.mayAdvanceAutonomously,
        ...(proposal.commitmentId !== undefined ? { commitmentId: proposal.commitmentId } : {}),
      };
    }
    case "UpdateCommitmentStatus": {
      if (
        !hasKeysWithin(proposal, ["type", "commitmentId", "status", "reason"], ["nextStep"])
        || !isNonemptyString(proposal.commitmentId)
        || !isCommitmentStatus(proposal.status)
        || !isNonemptyString(proposal.reason)
        || (proposal.nextStep !== undefined && !isNonemptyString(proposal.nextStep))
      ) {
        return undefined;
      }
      return {
        type: "UpdateCommitmentStatus",
        commitmentId: proposal.commitmentId,
        status: proposal.status,
        reason: proposal.reason,
        ...(proposal.nextStep !== undefined ? { nextStep: proposal.nextStep } : {}),
      };
    }
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
      if (!isString(event.episodeId) || !isNonnegativeSafeInteger(event.baseStateVersion)) {
        return undefined;
      }
      if (hasExactKeys(event, ["type", "episodeId", "baseStateVersion", "proposals"])) {
        if (!Array.isArray(event.proposals)) return undefined;
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
      if (
        !hasExactKeys(event, ["type", "episodeId", "baseStateVersion", "reason", "usage"])
        || !COGNITION_FINISH_REASONS.has(event.reason)
        || !isRecord(event.usage)
        || !hasExactKeys(event.usage, ["totalTokens"])
        || !isNonnegativeSafeInteger(event.usage.totalTokens)
      ) {
        return undefined;
      }
      return {
        type: "CognitionCompleted",
        episodeId: event.episodeId,
        baseStateVersion: event.baseStateVersion,
        reason: event.reason as CognitionFinishReason,
        usage: { totalTokens: event.usage.totalTokens },
      };
    }
    case "CognitionCommitAccepted": {
      if (
        !hasExactKeys(
          event,
          ["type", "episodeId", "commitId", "baseStateVersion", "proposals"],
        )
        || !isNonemptyString(event.episodeId)
        || !isNonemptyString(event.commitId)
        || !isNonnegativeSafeInteger(event.baseStateVersion)
        || !Array.isArray(event.proposals)
      ) {
        return undefined;
      }
      const proposals = event.proposals.map(canonicalizeProposal);
      return proposals.every((proposal) => proposal !== undefined)
        ? {
            type: "CognitionCommitAccepted",
            episodeId: event.episodeId,
            commitId: event.commitId,
            baseStateVersion: event.baseStateVersion,
            proposals: proposals as Proposal[],
          }
        : undefined;
    }
    case "CognitionCommitRejected":
      return hasExactKeys(event, ["type", "episodeId", "commitId", "reason"])
        && isNonemptyString(event.episodeId)
        && isNonemptyString(event.commitId)
        && isNonemptyString(event.reason)
        ? {
            type: "CognitionCommitRejected",
            episodeId: event.episodeId,
            commitId: event.commitId,
            reason: event.reason,
          }
        : undefined;
    case "AssistantMessageDelivered":
      return hasExactKeys(
        event,
        ["type", "episodeId", "messageId", "text", "channel", "status"],
      )
        && isNonemptyString(event.episodeId)
        && isNonemptyString(event.messageId)
        && isDeliveryText(event.text)
        && event.channel === "panel"
        && ASSISTANT_MESSAGE_STATUSES.has(event.status)
        ? {
            type: "AssistantMessageDelivered",
            episodeId: event.episodeId,
            messageId: event.messageId,
            text: event.text,
            channel: "panel",
            status: event.status as AssistantMessageStatus,
          }
        : undefined;
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
    case "ObservationRecorded": {
      const retrievedAt = canonicalizeInstant(event.retrievedAt);
      if (
        !hasKeysWithin(
          event,
          ["type", "observationId", "kind", "sourceUrl", "excerpt", "retrievedAt", "confidence"],
          ["title", "query"],
        )
        || !isNonemptyString(event.observationId)
        || !OBSERVATION_KINDS.has(event.kind)
        || !isNonemptyString(event.sourceUrl)
        || !isObservationExcerpt(event.excerpt)
        || retrievedAt === undefined
        || !isConfidence(event.confidence)
        || (event.title !== undefined && !isNonemptyString(event.title))
        || (event.kind === "web_search_result" && !isNonemptyString(event.query))
      ) {
        return undefined;
      }
      return {
        type: "ObservationRecorded",
        observationId: event.observationId,
        kind: event.kind as ObservationKind,
        sourceUrl: event.sourceUrl,
        excerpt: event.excerpt,
        retrievedAt,
        confidence: event.confidence,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.query !== undefined ? { query: event.query as string } : {}),
      };
    }
    case "ReachabilityPolicyUpdated":
      return hasExactKeys(event, ["type", "policy", "reason"])
        && isReachabilityPolicy(event.policy)
        && isNonemptyString(event.reason)
        ? {
            type: "ReachabilityPolicyUpdated",
            policy: event.policy,
            reason: event.reason,
          }
        : undefined;
    case "MessageDelivered":
      return hasExactKeys(event, ["type", "deliveryId", "text", "reason", "channel", "proactive"])
        && isNonemptyString(event.deliveryId)
        && isDeliveryText(event.text)
        && isNonemptyString(event.reason)
        && event.channel === "panel"
        && typeof event.proactive === "boolean"
        ? {
            type: "MessageDelivered",
            deliveryId: event.deliveryId,
            text: event.text,
            reason: event.reason,
            channel: "panel",
            proactive: event.proactive,
          }
        : undefined;
    case "MessageDeferred": {
      const deferUntil = canonicalizeInstant(event.deferUntil);
      return hasExactKeys(event, ["type", "deliveryId", "text", "reason", "deferUntil", "cause"])
        && isNonemptyString(event.deliveryId)
        && isDeliveryText(event.text)
        && isNonemptyString(event.reason)
        && deferUntil !== undefined
        && DELIVERY_CAUSES.has(event.cause)
        ? {
            type: "MessageDeferred",
            deliveryId: event.deliveryId,
            text: event.text,
            reason: event.reason,
            deferUntil,
            cause: event.cause as DeliveryCause,
          }
        : undefined;
    }
    case "MessageDeliveryFailed":
      return hasExactKeys(event, ["type", "deliveryId", "text", "reason", "code"])
        && isNonemptyString(event.deliveryId)
        && isDeliveryText(event.text)
        && isNonemptyString(event.reason)
        && isNonemptyString(event.code)
        ? {
            type: "MessageDeliveryFailed",
            deliveryId: event.deliveryId,
            text: event.text,
            reason: event.reason,
            code: event.code,
          }
        : undefined;
    case "GrantRevoked":
      return hasExactKeys(event, ["type", "grantId", "reason"])
        && isNonemptyString(event.grantId)
        && isNonemptyString(event.reason)
        ? { type: "GrantRevoked", grantId: event.grantId, reason: event.reason }
        : undefined;
    case "CommitmentUpserted":
      return hasExactKeys(event, [
        "type",
        "commitmentId",
        "goal",
        "status",
        "nextStep",
        "mayAdvanceAutonomously",
      ])
        && isNonemptyString(event.commitmentId)
        && isNonemptyString(event.goal)
        && isCommitmentStatus(event.status)
        && isNonemptyString(event.nextStep)
        && isBoolean(event.mayAdvanceAutonomously)
        ? {
            type: "CommitmentUpserted",
            commitmentId: event.commitmentId,
            goal: event.goal,
            status: event.status,
            nextStep: event.nextStep,
            mayAdvanceAutonomously: event.mayAdvanceAutonomously,
          }
        : undefined;
    case "CommitmentStatusChanged": {
      if (
        !hasKeysWithin(event, ["type", "commitmentId", "status", "reason"], ["nextStep"])
        || !isNonemptyString(event.commitmentId)
        || !isCommitmentStatus(event.status)
        || !isNonemptyString(event.reason)
        || (event.nextStep !== undefined && !isNonemptyString(event.nextStep))
      ) {
        return undefined;
      }
      return {
        type: "CommitmentStatusChanged",
        commitmentId: event.commitmentId,
        status: event.status,
        reason: event.reason,
        ...(event.nextStep !== undefined ? { nextStep: event.nextStep } : {}),
      };
    }
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
