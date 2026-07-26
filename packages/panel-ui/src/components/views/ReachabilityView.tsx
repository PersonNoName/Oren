import { ReachabilityForm } from "@/components/forms/ReachabilityForm";
import type { PanelSnapshot } from "@/lib/panel-types";

type Props = {
  snapshot: PanelSnapshot;
  onMutated: () => void | Promise<void>;
};

export function ReachabilityView({ snapshot, onMutated }: Props) {
  return (
    <div className="detail-view">
      <pre className="detail-json">{JSON.stringify(snapshot.reachability, null, 2)}</pre>
      <ReachabilityForm reachability={snapshot.reachability} onSuccess={onMutated} />
    </div>
  );
}
