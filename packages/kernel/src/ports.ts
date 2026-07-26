import type { EventEnvelope, InboxCoreEvent, TriggerKind } from "./protocol.js";
import type { LifeState } from "./state.js";

export type DeliverWakeOutcome =
  | { readonly kind: "missing_deferred" }
  | {
      readonly kind: "delivered";
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly deliveredAt: string;
    }
  | {
      readonly kind: "failed";
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly code: string;
      readonly message: string;
    };

export interface LifeRepositoryPort {
  loadState(orenId: string): LifeState;
  loadEvents(orenId: string): readonly EventEnvelope[];
  commit(orenId: string, events: readonly EventEnvelope[]): void;
  commitIfVersion(
    orenId: string,
    expectedVersion: number,
    events: readonly EventEnvelope[],
  ): boolean;
  commitInbox(
    inboxId: string,
    orenId: string,
    leaseOwner: string,
    leaseToken: string,
    events: readonly EventEnvelope[],
  ): boolean;
  commitDeliverInbox(
    inboxId: string,
    orenId: string,
    leaseOwner: string,
    leaseToken: string,
    events: readonly EventEnvelope[],
  ): boolean;
}

export interface CognitionJob {
  readonly orenId: string;
  readonly episodeId: string;
  readonly baseStateVersion: number;
  readonly triggerKind: TriggerKind;
  readonly correlationId: string;
}

export interface ClaimedInboxItem {
  readonly inboxId: string;
  readonly orenId: string;
  readonly correlationId: string;
  readonly event: InboxCoreEvent;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}
