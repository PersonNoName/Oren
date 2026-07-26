import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function LedgerView({ snapshot }: Props) {
  if (snapshot.actionLedger.length === 0) {
    return (
      <div className="detail-view">
        <p className="detail-empty">No ledger entries</p>
      </div>
    );
  }

  return (
    <div className="detail-view">
      <div className="detail-list">
        {snapshot.actionLedger.map((entry, i) => (
          <div key={`${entry.at}-${i}`} className="list-item">
            <time className="list-item-time">{entry.at}</time>
            <div className="list-item-primary">{entry.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
