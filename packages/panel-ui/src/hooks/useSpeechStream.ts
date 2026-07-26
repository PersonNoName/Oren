"use client";

import { useEffect, useState } from "react";
import { reduceSpeechEvent } from "@/lib/speech-stream";
import type { LiveUtterance, SpeechEvent } from "@/lib/panel-types";

export function useSpeechStream(): readonly LiveUtterance[] {
  const [utterances, setUtterances] = useState<readonly LiveUtterance[]>([]);

  useEffect(() => {
    const source = new EventSource("/api/speech-events");
    const receive = (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as SpeechEvent;
        setUtterances((current) => reduceSpeechEvent(current, event));
      } catch {
        // Ignore malformed or unknown SSE payloads.
      }
    };
    source.addEventListener("speech.started", receive as EventListener);
    source.addEventListener("speech.delta", receive as EventListener);
    source.addEventListener("speech.completed", receive as EventListener);
    return () => source.close();
  }, []);

  return utterances;
}
