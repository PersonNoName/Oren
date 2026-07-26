import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function BudgetsView({ snapshot }: Props) {
  return (
    <div className="detail-view">
      <pre className="detail-json">{JSON.stringify(snapshot.budgets, null, 2)}</pre>
    </div>
  );
}
