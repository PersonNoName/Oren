import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function CommitmentsView({ snapshot }: Props) {
  if (snapshot.commitments.length === 0) {
    return (
      <div className="detail-view">
        <p className="detail-empty">No commitments</p>
      </div>
    );
  }

  return (
    <div className="detail-view">
      <div className="detail-list">
        {snapshot.commitments.map((c) => (
          <div key={c.commitmentId} className="list-item">
            <div className="list-item-meta">
              <span className="list-item-id">{c.commitmentId}</span>
              <span className="list-item-status">{c.status}</span>
            </div>
            <div className="list-item-primary">{c.goal}</div>
            <div className="list-item-secondary">{c.nextStep}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
