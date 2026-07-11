import { randomUUID } from "node:crypto";
import type { LifeState, TasteItem, Thread, TickPatch } from "../types.js";

const IDLE_SALIENCE_DECAY = 0.01;

export interface IntegrateResult {
  state: LifeState;
  threadIdsTouched: string[];
  applied: {
    thread_ops: string[];
    taste_nudges_applied: number;
  };
}

export function integrate(state: LifeState, patch: TickPatch, now: string): IntegrateResult {
  const threads: Record<string, Thread> = {};
  for (const [id, t] of Object.entries(state.threads)) {
    threads[id] = {
      ...t,
      sources: [...t.sources],
      open_questions: [...t.open_questions],
      reading_log: [...t.reading_log],
      contemplation_log: [...t.contemplation_log],
      links: { ...t.links, related: [...t.links.related] },
    };
  }

  const threadIdsTouched = new Set<string>();
  const appliedOps: string[] = [];
  let taste = {
    ...state.taste,
    values: [...state.taste.values],
    aesthetics: [...state.taste.aesthetics],
  };
  let tasteNudges = 0;

  if (patch.mode === "idle") {
    for (const [id, t] of Object.entries(threads)) {
      if (t.status !== "active") continue;
      const next = Math.max(0, Math.round((t.salience - IDLE_SALIENCE_DECAY) * 1000) / 1000);
      if (next !== t.salience) {
        threads[id] = { ...t, salience: next };
        threadIdsTouched.add(id);
      }
    }
  }

  for (const op of patch.thread_ops ?? []) {
    if (op.op === "create") {
      threads[op.thread.id] = op.thread;
      threadIdsTouched.add(op.thread.id);
      appliedOps.push(`create:${op.thread.id}`);
      continue;
    }
    if (op.op === "update") {
      const existing = threads[op.id];
      if (!existing) {
        throw new Error(`unknown thread id for update: ${op.id}`);
      }
      threads[op.id] = { ...existing, ...op.fields, id: existing.id };
      threadIdsTouched.add(op.id);
      appliedOps.push(`update:${op.id}`);
      continue;
    }
    if (op.op === "dormant") {
      const existing = threads[op.id];
      if (!existing) {
        throw new Error(`unknown thread id for dormant: ${op.id}`);
      }
      threads[op.id] = { ...existing, status: "dormant" };
      threadIdsTouched.add(op.id);
      appliedOps.push(`dormant:${op.id}`);
    }
  }

  if (state.config.taste.apply_nudges && patch.taste_ops?.length) {
    const max = state.config.taste.max_nudges_per_tick;
    for (const n of patch.taste_ops.slice(0, max)) {
      const item: TasteItem = {
        id: `n_${randomUUID().slice(0, 8)}`,
        statement: n.statement,
        weight: 0.5,
      };
      if (n.dimension === "aesthetic") {
        taste = { ...taste, aesthetics: [...taste.aesthetics, item], updated_at: now };
      } else {
        taste = { ...taste, values: [...taste.values, item], updated_at: now };
      }
      tasteNudges++;
    }
  }

  return {
    state: {
      ...state,
      taste,
      threads,
    },
    threadIdsTouched: [...threadIdsTouched],
    applied: {
      thread_ops: appliedOps,
      taste_nudges_applied: tasteNudges,
    },
  };
}
