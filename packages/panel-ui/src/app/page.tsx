"use client";

import { useState } from "react";
import { DetailPane } from "@/components/DetailPane";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NavRail } from "@/components/NavRail";
import { PanelShell } from "@/components/PanelShell";
import { usePanelSnapshot } from "@/hooks/usePanelSnapshot";
import type { NavSection } from "@/lib/nav";

export default function Page() {
  const [active, setActive] = useState<NavSection>("overview");
  const { snapshot, error, refresh } = usePanelSnapshot(2000);

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
          <DetailPane
            section={active}
            snapshot={snapshot}
            error={error}
            onMutated={refresh}
          />
        </>
      }
      chat={<div className="chat-placeholder">Chat placeholder</div>}
    />
  );
}
