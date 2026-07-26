import type { LiveUtterance, PanelSnapshot } from "./panel-types.js";

export type LocalUserMessage = {
  readonly id: string;
  readonly text: string;
  readonly at: string;
};

export type ChatMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly at: string }
  | {
      readonly kind: "oren";
      readonly id: string;
      readonly text: string;
      readonly at: string;
      readonly deliveryId: string;
    }
  | {
      readonly kind: "oren-weak";
      readonly id: string;
      readonly text: string;
      readonly at: string;
      readonly status: "interrupted" | "deferred" | "failed";
      readonly deliveryId: string;
    };

export function buildChatMessages(
  inbox: PanelSnapshot["inbox"],
  localUserMessages: readonly LocalUserMessage[],
  liveUtterances: readonly LiveUtterance[] = [],
): ChatMessage[] {
  const userMessages: ChatMessage[] = localUserMessages.map((msg) => ({
    kind: "user",
    id: msg.id,
    text: msg.text,
    at: msg.at,
  }));

  const inboxMessages: ChatMessage[] = inbox.map((item) => {
    if (item.status === "delivered") {
      return {
        kind: "oren",
        id: item.deliveryId,
        text: item.text,
        at: item.at,
        deliveryId: item.deliveryId,
      };
    }
    return {
      kind: "oren-weak",
      id: item.deliveryId,
      text: item.text,
      at: item.at,
      status: item.status,
      deliveryId: item.deliveryId,
    };
  });

  const historical = [...userMessages, ...inboxMessages]
    .sort((a, b) => a.at.localeCompare(b.at));
  const knownIds = new Set(historical.map(({ id }) => id));
  const live: ChatMessage[] = liveUtterances
    .filter(({ messageId, text }) => !knownIds.has(messageId) && text.length > 0)
    .map((utterance) => ({
      kind: "oren",
      id: utterance.messageId,
      text: utterance.text,
      at: "9999-12-31T23:59:59.999Z",
      deliveryId: utterance.messageId,
    }));
  return [...historical, ...live];
}
