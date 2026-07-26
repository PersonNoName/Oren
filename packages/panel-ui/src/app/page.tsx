"use client";

import { useState } from "react";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NavRail } from "@/components/NavRail";
import { PanelShell } from "@/components/PanelShell";
import { usePanelSnapshot } from "@/hooks/usePanelSnapshot";
import type { NavSection } from "@/lib/nav";

export default function Page() {
  const [active, setActive] = useState<NavSection>("overview");
  const { snapshot, error } = usePanelSnapshot(2000);

  const snapshotSnippet = snapshot
    ? JSON.stringify(snapshot, null, 2).slice(0, 800) + (JSON.stringify(snapshot).length > 800 ? "…" : "")
    : "Loading…";

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
          <div className="detail-placeholder">
            <h2>{active}</h2>
            <pre>{snapshotSnippet}</pre>
          </div>
        </>
      }
      chat={<div className="chat-placeholder">Chat placeholder</div>}
    />
  );
}
