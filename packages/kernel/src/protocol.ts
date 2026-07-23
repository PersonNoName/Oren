import type {
  CorrelationId,
  EffectId,
  EpisodeId,
  EventId,
  GrantId,
  OrenId,
  ScheduleId,
  ThreadId,
} from "./ids.js";
import type { JsonObject } from "./json.js";

export type TriggerKind =
  | "foreground_user"
  | "effect_result"
  | "commitment_due"
  | "scheduled_wake"
  | "health_check";

export type Proposal =
  | { readonly type: "NoAction"; readonly reason: string }
  | { readonly type: "AdvanceThread"; readonly threadId: ThreadId; readonly summary: string }
  | { readonly type: "UpdateDisposition"; readonly disposition: string; readonly reason: string }
  | { readonly type: "ExpressToUser"; readonly text: string; readonly reason: string }
  | { readonly type: "ScheduleWake"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string };

export interface Effect {
  readonly effectId: EffectId;
  readonly orenId: OrenId;
  readonly correlationId: CorrelationId;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly GrantId[];
  readonly stateVersion: number;
}

export type CoreEvent =
  | { readonly type: "OrenInitialized"; readonly personId: string }
  | { readonly type: "UserMessageReceived"; readonly personId: string; readonly text: string }
  | { readonly type: "ThreadAdvanced"; readonly threadId: ThreadId; readonly summary: string }
  | { readonly type: "DispositionUpdated"; readonly disposition: string; readonly reason: string }
  | { readonly type: "CognitionRequested"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly triggerKind: TriggerKind }
  | { readonly type: "CognitionCompleted"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly proposals: readonly Proposal[] }
  | { readonly type: "CognitionFailed"; readonly episodeId: EpisodeId; readonly message: string }
  | { readonly type: "EpisodeInterrupted"; readonly episodeId: EpisodeId; readonly reason: "foreground_user" | "shutdown" }
  | { readonly type: "EffectRequested"; readonly effect: Effect }
  | { readonly type: "EffectCompleted"; readonly effectId: EffectId; readonly receipt: JsonObject }
  | { readonly type: "EffectFailed"; readonly effectId: EffectId; readonly code: string; readonly message: string }
  | { readonly type: "EffectUncertain"; readonly effectId: EffectId; readonly message: string }
  | { readonly type: "WakeScheduled"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string }
  | { readonly type: "WakeDue"; readonly scheduleId: ScheduleId; readonly purpose: string };

export interface EventEnvelope {
  readonly eventId: EventId;
  readonly orenId: OrenId;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly source: string;
  readonly causationId: string | null;
  readonly correlationId: CorrelationId;
  readonly payload: CoreEvent;
}
