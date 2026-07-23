import type { EventEnvelope, TriggerKind } from "./protocol.js";
import type { LifeState } from "./state.js";

export interface LifeRepositoryPort {
  loadState(orenId: string): LifeState;
  commit(orenId: string, events: readonly EventEnvelope[]): void;
  commitInbox(inboxId: string, orenId: string, events: readonly EventEnvelope[]): void;
}

export interface CognitionJob {
  readonly orenId: string;
  readonly episodeId: string;
  readonly baseStateVersion: number;
  readonly triggerKind: TriggerKind;
  readonly correlationId: string;
}
