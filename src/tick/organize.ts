import type { Config, Thread, ThreadOp } from "../types.js";

export function planOrganize(input: {
  threads: Record<string, Thread>;
  config: Config;
  now: string;
}): { thread_ops: ThreadOp[]; reason: string } {
  const active = Object.values(input.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => a.salience - b.salience);

  const ops: ThreadOp[] = [];
  const max = input.config.limits.max_active_threads;

  if (active.length > max) {
    const excess = active.length - max;
    for (let i = 0; i < excess; i++) {
      const t = active[i]!;
      ops.push({ op: "dormant", id: t.id });
    }
    return { thread_ops: ops, reason: `dormant_excess:${excess}` };
  }

  const staleMs =
    input.config.organize.stale_ms ?? 7 * 24 * 60 * 60 * 1000;
  const salienceBelow = input.config.organize.dormant_salience_below ?? 0.15;
  const nowMs = Date.parse(input.now);
  for (const t of active) {
    const last = Date.parse(t.last_engaged_at);
    if (
      t.salience < salienceBelow &&
      Number.isFinite(last) &&
      nowMs - last > staleMs
    ) {
      ops.push({ op: "dormant", id: t.id });
    }
  }

  if (ops.length === 0) {
    return { thread_ops: [], reason: "nothing_to_organize" };
  }
  return { thread_ops: ops, reason: "soft_dormant_stale" };
}
