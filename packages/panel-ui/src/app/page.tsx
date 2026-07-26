"use client";

import { useState } from "react";
import { ChatPane } from "@/components/ChatPane";
import { Composer } from "@/components/Composer";
import { DetailPane } from "@/components/DetailPane";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NavRail } from "@/components/NavRail";
import { PanelShell } from "@/components/PanelShell";
import { usePanelSnapshot } from "@/hooks/usePanelSnapshot";
import { useSpeechStream } from "@/hooks/useSpeechStream";
import type { LocalUserMessage } from "@/lib/chat-messages";
import type { NavSection } from "@/lib/nav";
import { postMessage } from "@/lib/panel-api";

export default function Page() {
  const [active, setActive] = useState<NavSection>("overview");
  const [localUserMessages, setLocalUserMessages] = useState<LocalUserMessage[]>([]);
  const [sendPending, setSendPending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const { snapshot, error, refresh } = usePanelSnapshot(2000);
  const liveUtterances = useSpeechStream();

  async function handleSend(text: string) {
    const optimistic: LocalUserMessage = {
      id: `user-${crypto.randomUUID()}`,
      text,
      at: new Date().toISOString(),
    };

    setLocalUserMessages((prev) => [...prev, optimistic]);
    setSendPending(true);
    setComposerError(null);

    try {
      await postMessage(text);
      await refresh();
    } catch (err) {
      setLocalUserMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setComposerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendPending(false);
    }
  }

  return (
    <PanelShell
      rail={
        <NavRail
          active={active}
          onSelect={setActive}
          inboxCount={snapshot?.inbox.length ?? 0}
        />
      }
      detail={
        <>
          <ErrorBanner error={error} />
          <div key={active} className="fade-in detail-pane-wrap">
            <DetailPane
              section={active}
              snapshot={snapshot}
              error={error}
              onMutated={refresh}
            />
          </div>
        </>
      }
      chat={
        <div className="chat-column">
          <ChatPane
            inbox={snapshot?.inbox}
            localUserMessages={localUserMessages}
            liveUtterances={liveUtterances}
          />
          <Composer onSend={handleSend} pending={sendPending} error={composerError} />
        </div>
      }
    />
  );
}
