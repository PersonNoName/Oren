import type { EventEnvelope } from "./protocol.js";
import type { LifeState } from "./state.js";

export function reduceLifeState(state: LifeState, event: EventEnvelope): LifeState {
  const nextVersion = state.version + 1;
  const base = { ...state, version: nextVersion, chronicleCursor: state.chronicleCursor + 1 };

  switch (event.payload.type) {
    case "AutonomyConsumed":
      return {
        ...base,
        budgets: {
          ...state.budgets,
          autonomyRemaining: state.budgets.autonomyRemaining - event.payload.amount,
        },
      };
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
    default:
      return base;
  }
}
