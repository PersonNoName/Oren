import type { ReactNode } from "react";
import { BudgetsView } from "@/components/views/BudgetsView";
import { CommitmentsView } from "@/components/views/CommitmentsView";
import { GrantsView } from "@/components/views/GrantsView";
import { InboxView } from "@/components/views/InboxView";
import { LedgerView } from "@/components/views/LedgerView";
import { OverviewView } from "@/components/views/OverviewView";
import { ReachabilityView } from "@/components/views/ReachabilityView";
import type { NavSection } from "@/lib/nav";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  section: NavSection;
  snapshot: PanelSnapshot | null;
  error: string | null;
  children?: ReactNode;
};

function renderView(section: NavSection, snapshot: PanelSnapshot) {
  switch (section) {
    case "overview":
      return <OverviewView snapshot={snapshot} />;
    case "inbox":
      return <InboxView snapshot={snapshot} />;
    case "commitments":
      return <CommitmentsView snapshot={snapshot} />;
    case "grants":
      return <GrantsView snapshot={snapshot} />;
    case "budgets":
      return <BudgetsView snapshot={snapshot} />;
    case "reachability":
      return <ReachabilityView snapshot={snapshot} />;
    case "ledger":
      return <LedgerView snapshot={snapshot} />;
  }
}

export function DetailPane({ section, snapshot, error, children }: Props) {
  return (
    <div className="detail-pane">
      {snapshot ? (
        <>
          {renderView(section, snapshot)}
          {children}
        </>
      ) : error ? null : (
        <div className="detail-view">
          <p className="detail-empty">Loading…</p>
        </div>
      )}
    </div>
  );
}
