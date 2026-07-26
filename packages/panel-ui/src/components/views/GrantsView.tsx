import { RevokeGrantForm } from "@/components/forms/RevokeGrantForm";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
  onMutated: () => void | Promise<void>;
};

export function GrantsView({ snapshot, onMutated }: Props) {
  return (
    <div className="detail-view">
      {snapshot.grants.length === 0 ? (
        <p className="detail-empty">No grants</p>
      ) : (
        <div className="detail-list">
          {snapshot.grants.map((g) => (
            <div key={g.grantId} className="list-item">
              <div className="list-item-meta">
                <span className="list-item-id">{g.grantId}</span>
                {g.revoked ? (
                  <span className="list-item-flag list-item-flag-revoked">revoked</span>
                ) : (
                  <span className="list-item-flag">active</span>
                )}
              </div>
              <div className="list-item-primary">{g.capabilityPattern}</div>
            </div>
          ))}
        </div>
      )}
      <RevokeGrantForm onSuccess={onMutated} />
    </div>
  );
}
