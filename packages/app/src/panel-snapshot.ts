import type { PanelInboxAdapter } from "@oren/channel";
import type { PanelSnapshot } from "@oren/panel";
import {
  reachabilityOf,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import type { SqliteLifeRepository } from "@oren/storage";

const ACTION_LEDGER_LIMIT = 20;

function summarizeEvent(event: EventEnvelope): string | undefined {
  const payload = event.payload;
  switch (payload.type) {
    case "EffectRequested":
      return `Effect ${payload.effect.capability}`;
    case "ObservationRecorded":
      return payload.title !== undefined
        ? `Observation ${payload.kind}: ${payload.title}`
        : `Observation ${payload.kind}`;
    default:
      return undefined;
  }
}

export function buildPanelSnapshot(
  repository: SqliteLifeRepository,
  orenId: string,
  state: LifeState,
  inboxAdapter?: PanelInboxAdapter,
): PanelSnapshot {
  const events = repository.loadEvents(orenId);

  const inboxFromAdapter = (inboxAdapter?.messages ?? []).map((message) => ({
    deliveryId: message.deliveryId,
    text: message.text,
    reason: message.reason,
    status: "delivered" as const,
    proactive: message.proactive,
    at: message.deliveredAt,
  }));

  const inboxFromEvents: Array<PanelSnapshot["inbox"][number]> = [];
  for (const event of events) {
    const payload = event.payload;
    if (payload.type === "MessageDeferred") {
      inboxFromEvents.push({
        deliveryId: payload.deliveryId,
        text: payload.text,
        reason: payload.reason,
        status: "deferred",
        deferUntil: payload.deferUntil,
        at: event.occurredAt,
      });
    } else if (payload.type === "MessageDeliveryFailed") {
      inboxFromEvents.push({
        deliveryId: payload.deliveryId,
        text: payload.text,
        reason: payload.reason,
        status: "failed",
        at: event.occurredAt,
      });
    }
  }

  const publicDiary = events.flatMap((event) => {
    const payload = event.payload;
    if (payload.type !== "MessageDelivered") return [];
    return [{ at: event.occurredAt, text: payload.text }];
  });

  const actionLedger: Array<PanelSnapshot["actionLedger"][number]> = [];
  for (
    let index = events.length - 1;
    index >= 0 && actionLedger.length < ACTION_LEDGER_LIMIT;
    index -= 1
  ) {
    const event = events[index]!;
    const summary = summarizeEvent(event);
    if (summary !== undefined) {
      actionLedger.push({ at: event.occurredAt, summary });
    }
  }

  const grants = repository.loadGrants(orenId, { includeRevoked: true }).map((grant) => ({
    grantId: grant.grantId,
    capabilityPattern: grant.capabilityPattern,
    revoked: grant.revoked,
  }));

  return {
    inbox: [...inboxFromAdapter, ...inboxFromEvents],
    attention: state.attention,
    commitments: state.commitments ?? [],
    budgets: state.budgets,
    grants,
    schedules: repository.listSchedulesForOren(orenId),
    actionLedger,
    publicDiary,
    reachability: reachabilityOf(state),
  };
}
