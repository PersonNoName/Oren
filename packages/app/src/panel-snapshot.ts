import type { PanelInboxAdapter } from "@oren/channel";
import type { PanelSnapshot } from "@oren/panel";
import {
  reachabilityOf,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import type { SqliteLifeRepository } from "@oren/storage";

const ACTION_LEDGER_LIMIT = 20;

type InboxRow = PanelSnapshot["inbox"][number];
type InboxStatus = InboxRow["status"];

const INBOX_STATUS_RANK: Record<InboxStatus, number> = {
  deferred: 1,
  failed: 2,
  delivered: 3,
};

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

function mergeInboxRow(existing: InboxRow | undefined, incoming: InboxRow): InboxRow {
  if (!existing) return incoming;
  const existingRank = INBOX_STATUS_RANK[existing.status];
  const incomingRank = INBOX_STATUS_RANK[incoming.status];
  if (incomingRank > existingRank) return incoming;
  if (incomingRank < existingRank) return existing;
  return incoming.at >= existing.at ? incoming : existing;
}

function inboxRowFromEvent(event: EventEnvelope): InboxRow | undefined {
  const payload = event.payload;
  if (payload.type === "MessageDelivered") {
    return {
      deliveryId: payload.deliveryId,
      text: payload.text,
      reason: payload.reason,
      status: "delivered",
      proactive: payload.proactive,
      at: event.occurredAt,
    };
  }
  if (payload.type === "MessageDeferred") {
    return {
      deliveryId: payload.deliveryId,
      text: payload.text,
      reason: payload.reason,
      status: "deferred",
      deferUntil: payload.deferUntil,
      at: event.occurredAt,
    };
  }
  if (payload.type === "MessageDeliveryFailed") {
    return {
      deliveryId: payload.deliveryId,
      text: payload.text,
      reason: payload.reason,
      status: "failed",
      at: event.occurredAt,
    };
  }
  return undefined;
}

function buildInboxFromEvents(events: readonly EventEnvelope[]): Map<string, InboxRow> {
  const byDeliveryId = new Map<string, InboxRow>();
  for (const event of events) {
    const row = inboxRowFromEvent(event);
    if (row === undefined) continue;
    byDeliveryId.set(
      row.deliveryId,
      mergeInboxRow(byDeliveryId.get(row.deliveryId), row),
    );
  }
  return byDeliveryId;
}

function overlayAdapterMessages(
  byDeliveryId: Map<string, InboxRow>,
  inboxAdapter?: PanelInboxAdapter,
): void {
  for (const message of inboxAdapter?.messages ?? []) {
    const existing = byDeliveryId.get(message.deliveryId);
    const adapterRow: InboxRow = {
      deliveryId: message.deliveryId,
      text: message.text,
      reason: message.reason,
      status: "delivered",
      proactive: message.proactive,
      at: message.deliveredAt,
    };
    if (existing?.status === "delivered") {
      byDeliveryId.set(message.deliveryId, {
        ...existing,
        text: adapterRow.text,
        reason: adapterRow.reason,
        at: adapterRow.at,
        ...(message.proactive !== undefined ? { proactive: message.proactive } : {}),
      });
    } else if (existing === undefined) {
      byDeliveryId.set(message.deliveryId, adapterRow);
    }
  }
}

export function buildPanelSnapshot(
  repository: SqliteLifeRepository,
  orenId: string,
  state: LifeState,
  inboxAdapter?: PanelInboxAdapter,
): PanelSnapshot {
  const events = repository.loadEvents(orenId);

  const inboxByDeliveryId = buildInboxFromEvents(events);
  overlayAdapterMessages(inboxByDeliveryId, inboxAdapter);

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
    inbox: [...inboxByDeliveryId.values()],
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
