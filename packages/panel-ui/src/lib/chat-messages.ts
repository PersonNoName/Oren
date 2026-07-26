import type { PanelSnapshot } from "./panel-types.js";

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
      readonly status: "deferred" | "failed";
      readonly deliveryId: string;
    };

export function buildChatMessages(
  inbox: PanelSnapshot["inbox"],
  localUserMessages: readonly LocalUserMessage[],
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

  return [...userMessages, ...inboxMessages].sort((a, b) => a.at.localeCompare(b.at));
}
