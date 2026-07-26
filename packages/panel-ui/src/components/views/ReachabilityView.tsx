import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
};

export function ReachabilityView({ snapshot }: Props) {
  return (
    <div className="detail-view">
      <pre className="detail-json">{JSON.stringify(snapshot.reachability, null, 2)}</pre>
    </div>
  );
}
