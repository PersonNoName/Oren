type InboxStatus = "delivered" | "deferred" | "failed";

type Props = {
  status: InboxStatus | string;
  at: string;
  text: string;
  reason?: string;
};

function borderColor(status: string): string {
  if (status === "delivered") return "var(--accent)";
  if (status === "deferred" || status === "failed") return "var(--accent-muted)";
  return "var(--ink)";
}

export function StatusRow({ status, at, text, reason }: Props) {
  return (
    <div
      className="list-item status-row"
      style={{ borderLeftColor: borderColor(status) }}
    >
      <div className="status-row-header">
        <span className="status-row-status">{status}</span>
        <time className="status-row-time">{at}</time>
      </div>
      <div className="status-row-text">{text}</div>
      {reason ? <div className="status-row-reason">{reason}</div> : null}
    </div>
  );
}
