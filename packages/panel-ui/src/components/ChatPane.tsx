"use client";

import { useEffect, useRef } from "react";
import { buildChatMessages, type LocalUserMessage } from "@/lib/chat-messages";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  inbox: PanelSnapshot["inbox"] | undefined;
  localUserMessages: readonly LocalUserMessage[];
};

export function ChatPane({ inbox, localUserMessages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = buildChatMessages(inbox ?? [], localUserMessages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="chat-pane">
      {messages.length === 0 ? (
        <p className="chat-empty">Send a message to start the conversation.</p>
      ) : (
        messages.map((msg) => {
          if (msg.kind === "user") {
            return (
              <div key={msg.id} className="chat-bubble chat-bubble-user">
                {msg.text}
              </div>
            );
          }
          if (msg.kind === "oren") {
            return (
              <div key={msg.id} className="chat-bubble chat-bubble-oren">
                {msg.text}
              </div>
            );
          }
          return (
            <div key={msg.id} className="chat-bubble chat-bubble-oren chat-bubble-oren-weak">
              <span className="chat-status-chip">{msg.status}</span>
              {msg.text}
            </div>
          );
        })
      )}
      <div ref={bottomRef} />
    </div>
  );
}
