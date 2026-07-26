import type { EventEnvelope } from "./protocol.js";
import type { LifeState } from "./state.js";
import { reachabilityOf, utcDayKey } from "./reachability.js";
import {
  canonicalizeEventEnvelope,
  hasValidLifeStateBudgets,
} from "./runtime-validation.js";

export function reduceLifeState(state: LifeState, event: EventEnvelope): LifeState {
  if (!hasValidLifeStateBudgets(state)) {
    throw new Error("LifeState contains invalid budgets");
  }
  const canonicalEvent = canonicalizeEventEnvelope(event);
  if (!canonicalEvent) {
    const label = (
      typeof event === "object"
      && event !== null
      && typeof event.payload === "object"
      && event.payload !== null
      && event.payload.type === "AutonomyConsumed"
    ) ? "autonomy event" : "event";
    throw new Error(`Invalid ${label} envelope or payload`);
  }
  event = canonicalEvent;
  const nextVersion = state.version + 1;
  const base = { ...state, version: nextVersion, chronicleCursor: state.chronicleCursor + 1 };

  switch (event.payload.type) {
    case "AutonomyConsumed": {
      const reservations = state.autonomyReservations ?? {};
      if (event.payload.baseStateVersion !== state.version) {
        throw new Error("AutonomyConsumed base version does not match state");
      }
      if (reservations[event.payload.episodeId] !== undefined) {
        throw new Error(`Episode ${event.payload.episodeId} autonomy is already reserved`);
      }
      if (
        !Number.isSafeInteger(event.payload.amount)
        || event.payload.amount <= 0
        || event.payload.amount > state.budgets.autonomyRemaining
      ) {
        throw new Error("Invalid autonomy consumption amount");
      }
      return {
        ...base,
        budgets: {
          ...state.budgets,
          autonomyRemaining: state.budgets.autonomyRemaining - event.payload.amount,
        },
        autonomyReservations: {
          ...reservations,
          [event.payload.episodeId]: {
            amount: event.payload.amount,
            baseStateVersion: event.payload.baseStateVersion,
            correlationId: event.correlationId,
          },
        },
      };
    }
    case "ThreadAdvanced": {
      const activeThreadIds = state.attention.activeThreadIds.includes(event.payload.threadId)
        ? state.attention.activeThreadIds
        : [...state.attention.activeThreadIds, event.payload.threadId].slice(-16);
      return {
        ...base,
        attention: {
          ...state.attention,
          activeThreadIds,
          currentFocus: event.payload.summary,
        },
      };
    }
    case "DispositionUpdated":
      return {
        ...base,
        identity: { ...state.identity, currentDisposition: event.payload.disposition },
      };
    case "EffectRequested":
      return {
        ...base,
        pendingEffectIds: [...state.pendingEffectIds, event.payload.effect.effectId],
      };
    case "EffectCompleted":
    case "EffectFailed":
    case "EffectUncertain": {
      const { effectId } = event.payload;
      return {
        ...base,
        pendingEffectIds: state.pendingEffectIds.filter((id) => id !== effectId),
      };
    }
    case "WakeScheduled":
      return {
        ...base,
        schedules: state.schedules.includes(event.payload.scheduleId)
          ? state.schedules
          : [...state.schedules, event.payload.scheduleId],
      };
    case "ObservationRecorded": {
      const remaining = state.budgets.webQuotaRemaining ?? 0;
      if (remaining < 1) {
        throw new Error("ObservationRecorded rejected: web quota exhausted");
      }
      return {
        ...base,
        budgets: {
          ...state.budgets,
          webQuotaRemaining: remaining - 1,
        },
      };
    }
    case "ReachabilityPolicyUpdated":
      return {
        ...base,
        reachability: event.payload.policy,
      };
    case "MessageDelivered": {
      if (!event.payload.proactive) {
        return base;
      }
      const reachability = reachabilityOf(state);
      const dayKey = utcDayKey(event.occurredAt);
      const proactiveCountToday = reachability.proactiveDayKey === dayKey
        ? reachability.proactiveCountToday + 1
        : 1;
      return {
        ...base,
        reachability: {
          ...reachability,
          proactiveDayKey: dayKey,
          proactiveCountToday,
        },
      };
    }
    case "MessageDeferred":
    case "MessageDeliveryFailed":
      return base;
    case "GrantRevoked":
      return {
        ...base,
        grantIds: state.grantIds.filter((id) => id !== event.payload.grantId),
      };
    default:
      return base;
  }
}
