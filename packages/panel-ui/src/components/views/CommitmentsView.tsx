import { CommitmentForm } from "@/components/forms/CommitmentForm";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
  onMutated: () => void | Promise<void>;
};

export function CommitmentsView({ snapshot, onMutated }: Props) {
  return (
    <div className="detail-view">
      {snapshot.commitments.length === 0 ? (
        <p className="detail-empty">No commitments</p>
      ) : (
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
      )}
      <CommitmentForm onSuccess={onMutated} />
    </div>
  );
}
