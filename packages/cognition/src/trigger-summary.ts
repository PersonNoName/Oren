import type {
  EventEnvelope,
  JsonObject,
  TriggerKind,
} from "@oren/kernel";

const RECEIPT_SUMMARY_MAX = 240;

export type EffectResultSummaryInput = {
  readonly capability: string;
  readonly effectId: string;
  readonly status: "completed" | "failed" | "uncertain";
  readonly receipt?: JsonObject;
  readonly code?: string;
  readonly message?: string;
};

/** Shared production/eval wording for effect_result trigger summaries. */
export function formatEffectResultSummary(input: EffectResultSummaryInput): string {
  if (input.status === "completed") {
    const receipt = truncateJson(input.receipt ?? {});
    return `${input.capability} 完成（effectId=${input.effectId}，回执=${receipt}）。`;
  }
  if (input.status === "failed") {
    return `${input.capability} 失败（effectId=${input.effectId}，code=${input.code ?? "unknown"}，message=${input.message ?? ""}）。`;
  }
  return `${input.capability} 结果不确定（effectId=${input.effectId}，message=${input.message ?? ""}）。`;
}

/**
 * Build the LifeFrame trigger.summary from durable events for this correlation.
 * Falls back to correlationId when the expected source event is missing.
 */
export function resolveTriggerSummary(input: {
  readonly triggerKind: TriggerKind;
  readonly correlationId: string;
  readonly events: readonly EventEnvelope[];
}): string {
  const related = input.events.filter(
    (event) => event.correlationId === input.correlationId,
  );

  switch (input.triggerKind) {
    case "foreground_user": {
      for (let i = related.length - 1; i >= 0; i -= 1) {
        const payload = related[i]!.payload;
        if (payload.type === "UserMessageReceived") return payload.text;
      }
      return input.correlationId;
    }
    case "effect_result": {
      const effectMeta = findEffectResult(related);
      if (effectMeta === null) return input.correlationId;
      return formatEffectResultSummary(effectMeta);
    }
    case "scheduled_wake": {
      for (let i = related.length - 1; i >= 0; i -= 1) {
        const payload = related[i]!.payload;
        if (payload.type === "WakeDue") return payload.purpose;
      }
      return input.correlationId;
    }
    default:
      return input.correlationId;
  }
}

function findEffectResult(
  related: readonly EventEnvelope[],
): EffectResultSummaryInput | null {
  let requestedCapability: string | undefined;
  let requestedEffectId: string | undefined;
  for (const event of related) {
    if (event.payload.type === "EffectRequested") {
      requestedCapability = event.payload.effect.capability;
      requestedEffectId = event.payload.effect.effectId;
    }
  }

  for (let i = related.length - 1; i >= 0; i -= 1) {
    const payload = related[i]!.payload;
    if (payload.type === "EffectCompleted") {
      return {
        capability: requestedCapability
          ?? findCapabilityForEffect(related, payload.effectId)
          ?? "unknown",
        effectId: payload.effectId,
        status: "completed",
        receipt: payload.receipt,
      };
    }
    if (payload.type === "EffectFailed") {
      return {
        capability: requestedCapability
          ?? findCapabilityForEffect(related, payload.effectId)
          ?? "unknown",
        effectId: payload.effectId,
        status: "failed",
        code: payload.code,
        message: payload.message,
      };
    }
    if (payload.type === "EffectUncertain") {
      return {
        capability: requestedCapability
          ?? findCapabilityForEffect(related, payload.effectId)
          ?? "unknown",
        effectId: payload.effectId,
        status: "uncertain",
        message: payload.message,
      };
    }
  }

  if (requestedCapability !== undefined && requestedEffectId !== undefined) {
    return {
      capability: requestedCapability,
      effectId: requestedEffectId,
      status: "uncertain",
      message: "effect result event missing from history",
    };
  }
  return null;
}

function findCapabilityForEffect(
  related: readonly EventEnvelope[],
  effectId: string,
): string | undefined {
  for (const event of related) {
    if (
      event.payload.type === "EffectRequested"
      && event.payload.effect.effectId === effectId
    ) {
      return event.payload.effect.capability;
    }
  }
  // Also search isn't limited — caller may pass only correlation-filtered events.
  return undefined;
}

function truncateJson(value: JsonObject): string {
  const raw = JSON.stringify(value);
  if (raw.length <= RECEIPT_SUMMARY_MAX) return raw;
  return `${raw.slice(0, RECEIPT_SUMMARY_MAX - 1)}…`;
}
