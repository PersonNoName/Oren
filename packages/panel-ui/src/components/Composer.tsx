"use client";

import { useState, type KeyboardEvent } from "react";

type Props = {
  onSend: (text: string) => Promise<void>;
  pending: boolean;
  error: string | null;
};

export function Composer({ onSend, pending, error }: Props) {
  const [text, setText] = useState("");

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setText("");
    await onSend(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Oren…"
        rows={2}
        disabled={pending}
      />
      <div className="composer-actions">
        <button type="button" onClick={() => void submit()} disabled={pending || !text.trim()}>
          {pending ? "Sending…" : "Send"}
        </button>
        {error ? <p className="composer-error">{error}</p> : null}
      </div>
    </div>
  );
}
