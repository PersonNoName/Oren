import type { ChannelPort } from "@oren/channel";
import {
  evaluateReachability,
  reachabilityOf,
  type EventEnvelope,
  type LifeActor,
  type LifeState,
  type Proposal,
  type TriggerKind,
} from "@oren/kernel";

export function findDeferredMessage(
  events: readonly EventEnvelope[],
  deliveryId: string,
): { readonly text: string; readonly reason: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]!.payload;
    if (payload.type === "MessageDeferred" && payload.deliveryId === deliveryId) {
      return { text: payload.text, reason: payload.reason };
    }
  }
  return undefined;
}

export async function deliverExpressProposals(input: {
  readonly orenId: string;
  readonly correlationId: string;
  readonly triggerKind: TriggerKind;
  readonly proposals: readonly Proposal[];
  readonly state: LifeState;
  readonly now: string;
  readonly channel: ChannelPort;
  readonly actor: LifeActor;
  readonly nextId: () => string;
  readonly reloadState?: () => LifeState;
}): Promise<void> {
  const reloadState = input.reloadState ?? (() => input.state);
  for (const proposal of input.proposals) {
    if (proposal.type !== "ExpressToUser") continue;
    const state = reloadState();
    const proactive = input.triggerKind !== "foreground_user";
    const decision = evaluateReachability(reachabilityOf(state), input.now, proactive);
    const deliveryId = input.nextId();
    if (decision.action === "defer") {
      input.actor.recordMessageDeferred(input.orenId, input.correlationId, {
        deliveryId,
        text: proposal.text,
        reason: proposal.reason,
        deferUntil: decision.deferUntil,
        cause: decision.cause,
      });
      continue;
    }
    const result = await input.channel.deliver({
      deliveryId,
      text: proposal.text,
      reason: proposal.reason,
      proactive,
    });
    if (result.ok) {
      input.actor.recordMessageDelivered(input.orenId, input.correlationId, {
        deliveryId,
        text: proposal.text,
        reason: proposal.reason,
        channel: "panel",
        proactive,
      });
    } else {
      input.actor.recordMessageDeliveryFailed(input.orenId, input.correlationId, {
        deliveryId,
        text: proposal.text,
        reason: proposal.reason,
        code: result.code,
      });
    }
  }
}
