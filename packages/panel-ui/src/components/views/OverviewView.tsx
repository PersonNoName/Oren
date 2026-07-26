import { StatusRow } from "@/components/StatusRow";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function OverviewView({ snapshot }: Props) {
  const recentInbox = snapshot.inbox.slice(-3);
  const activeCommitments = snapshot.commitments
    .filter((c) => c.status === "active")
    .slice(0, 5);
  const recentLedger = snapshot.actionLedger.slice(-5);
  const recentDiary = snapshot.publicDiary.slice(-3);

  return (
    <div className="detail-view">
      <section className="detail-section">
        <h3 className="detail-section-title">
          Inbox <span className="detail-count">({snapshot.inbox.length})</span>
        </h3>
        {recentInbox.length === 0 ? (
          <p className="detail-empty">No inbox items</p>
        ) : (
          <div className="detail-list">
            {recentInbox.map((item) => (
              <StatusRow
                key={item.deliveryId}
                status={item.status}
                at={item.at}
                text={item.text}
                reason={item.reason}
              />
            ))}
          </div>
        )}
      </section>

      <section className="detail-section">
        <h3 className="detail-section-title">Active commitments</h3>
        {activeCommitments.length === 0 ? (
          <p className="detail-empty">No active commitments</p>
        ) : (
          <div className="detail-list">
            {activeCommitments.map((c) => (
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
      </section>

      <section className="detail-section">
        <h3 className="detail-section-title">Ledger</h3>
        {recentLedger.length === 0 ? (
          <p className="detail-empty">No ledger entries</p>
        ) : (
          <div className="detail-list">
            {recentLedger.map((entry, i) => (
              <div key={`${entry.at}-${i}`} className="list-item">
                <time className="list-item-time">{entry.at}</time>
                <div className="list-item-primary">{entry.summary}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="detail-section">
        <h3 className="detail-section-title">Diary</h3>
        {recentDiary.length === 0 ? (
          <p className="detail-empty">No diary entries</p>
        ) : (
          <div className="detail-list">
            {recentDiary.map((entry, i) => (
              <div key={`${entry.at}-${i}`} className="list-item">
                <time className="list-item-time">{entry.at}</time>
                <div className="list-item-primary">{entry.text}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
