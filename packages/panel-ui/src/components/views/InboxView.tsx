import { StatusRow } from "@/components/StatusRow";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function InboxView({ snapshot }: Props) {
  if (snapshot.inbox.length === 0) {
    return (
      <div className="detail-view">
        <p className="detail-empty">No inbox items</p>
      </div>
    );
  }

  return (
    <div className="detail-view">
      <div className="detail-list">
        {snapshot.inbox.map((item) => (
          <StatusRow
            key={item.deliveryId}
            status={item.status}
            at={item.at}
            text={item.text}
            reason={item.reason}
          />
        ))}
      </div>
    </div>
  );
}
