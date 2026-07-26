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
import type { DeliveryCause, ReachabilityPolicy } from "./reachability.js";

export type TriggerKind =
  | "foreground_user"
  | "effect_result"
  | "commitment_due"
  | "scheduled_wake"
  | "health_check";

export type MemoryKind =
  | "user_statement"
  | "external_fact"
  | "oren_judgment"
  | "oren_expression";

export type ObservationKind = "web_search_result" | "web_page";

export type CommitmentStatus = "active" | "paused" | "done";

export type Commitment = {
  readonly commitmentId: string;
  readonly goal: string;
  readonly status: CommitmentStatus;
  readonly nextStep: string;
  readonly mayAdvanceAutonomously: boolean;
};

export type EpisodeInterruptionReason =
  | "foreground_user"
  | "shutdown"
  | "trigger_priority"
  | "cognition_abort";

export type Proposal =
  | { readonly type: "NoAction"; readonly reason: string }
  | { readonly type: "AdvanceThread"; readonly threadId: ThreadId; readonly summary: string }
  | { readonly type: "UpdateDisposition"; readonly disposition: string; readonly reason: string }
  | { readonly type: "ExpressToUser"; readonly text: string; readonly reason: string }
  | { readonly type: "ScheduleWake"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string }
  | {
      readonly type: "Remember";
      readonly text: string;
      readonly kind: MemoryKind;
      readonly confidence?: number;
      readonly reviewCondition?: string;
      readonly threadId?: ThreadId;
    }
  | {
      readonly type: "ReviseBelief";
      readonly memoryId: string;
      readonly revisedText?: string;
      readonly confidence: number;
      readonly reason: string;
    }
  | { readonly type: "Forget"; readonly memoryId: string; readonly reason: string }
  | {
      readonly type: "UpsertCommitment";
      readonly commitmentId?: string;
      readonly goal: string;
      readonly status: CommitmentStatus;
      readonly nextStep: string;
      readonly mayAdvanceAutonomously: boolean;
    }
  | {
      readonly type: "UpdateCommitmentStatus";
      readonly commitmentId: string;
      readonly status: CommitmentStatus;
      readonly nextStep?: string;
      readonly reason: string;
    };

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
  | { readonly type: "AutonomyConsumed"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly amount: number }
  | { readonly type: "CognitionCompleted"; readonly episodeId: EpisodeId; readonly baseStateVersion: number; readonly proposals: readonly Proposal[] }
  | { readonly type: "CognitionDenied"; readonly episodeId: EpisodeId; readonly reason: string }
  | { readonly type: "CognitionWaitingForEffect"; readonly episodeId: EpisodeId; readonly effectId: EffectId }
  | { readonly type: "CognitionFailed"; readonly episodeId: EpisodeId; readonly message: string }
  | { readonly type: "EpisodeInterrupted"; readonly episodeId: EpisodeId; readonly reason: EpisodeInterruptionReason }
  | { readonly type: "EffectRequested"; readonly effect: Effect }
  | { readonly type: "EffectCompleted"; readonly effectId: EffectId; readonly receipt: JsonObject }
  | { readonly type: "EffectFailed"; readonly effectId: EffectId; readonly code: string; readonly message: string }
  | { readonly type: "EffectUncertain"; readonly effectId: EffectId; readonly message: string }
  | { readonly type: "WakeScheduled"; readonly scheduleId: ScheduleId; readonly at: string; readonly purpose: string }
  | { readonly type: "WakeDue"; readonly scheduleId: ScheduleId; readonly purpose: string }
  | {
      readonly type: "MemoryRemembered";
      readonly memoryId: string;
      readonly kind: MemoryKind;
      readonly text: string;
      readonly confidence?: number;
      readonly reviewCondition?: string;
      readonly threadId?: ThreadId;
    }
  | {
      readonly type: "BeliefRevised";
      readonly memoryId: string;
      readonly revisedText?: string;
      readonly confidence: number;
      readonly reason: string;
    }
  | { readonly type: "MemoryForgotten"; readonly memoryId: string; readonly reason: string }
  | {
      readonly type: "ObservationRecorded";
      readonly observationId: string;
      readonly kind: ObservationKind;
      readonly sourceUrl: string;
      readonly title?: string;
      readonly excerpt: string;
      readonly retrievedAt: string;
      readonly query?: string;
      readonly confidence: number;
    }
  | {
      readonly type: "ReachabilityPolicyUpdated";
      readonly policy: ReachabilityPolicy;
      readonly reason: string;
    }
  | {
      readonly type: "MessageDelivered";
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly channel: "panel";
      readonly proactive: boolean;
    }
  | {
      readonly type: "MessageDeferred";
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly deferUntil: string;
      readonly cause: DeliveryCause;
    }
  | {
      readonly type: "MessageDeliveryFailed";
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly code: string;
    }
  | { readonly type: "GrantRevoked"; readonly grantId: GrantId; readonly reason: string }
  | {
      readonly type: "CommitmentUpserted";
      readonly commitmentId: string;
      readonly goal: string;
      readonly status: CommitmentStatus;
      readonly nextStep: string;
      readonly mayAdvanceAutonomously: boolean;
    }
  | {
      readonly type: "CommitmentStatusChanged";
      readonly commitmentId: string;
      readonly status: CommitmentStatus;
      readonly nextStep?: string;
      readonly reason: string;
    };

export type InboxCoreEvent =
  | Extract<CoreEvent, { type: "WakeDue" }>
  | Extract<CoreEvent, { type: "EffectCompleted" }>
  | Extract<CoreEvent, { type: "EffectFailed" }>
  | Extract<CoreEvent, { type: "EffectUncertain" }>;

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
