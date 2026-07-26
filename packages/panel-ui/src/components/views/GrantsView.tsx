import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function GrantsView({ snapshot }: Props) {
  if (snapshot.grants.length === 0) {
    return (
      <div className="detail-view">
        <p className="detail-empty">No grants</p>
      </div>
    );
  }

  return (
    <div className="detail-view">
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
    </div>
  );
}
