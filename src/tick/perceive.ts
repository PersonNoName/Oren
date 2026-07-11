import type { Mode, StreamEvent } from "../types.js";
import type { CorpusIndex } from "../corpus/index.js";
import type { LifeState } from "../types.js";

export interface Perception {
  now: string;
  last_tick_at: string | null;
  gap_ms: number;
  hasReadableCorpus: boolean;
  activeThreadCount: number;
  recentModes: Mode[];
  contemplateOrdinal: number;
  index: CorpusIndex;
}

export function perceive(input: {
  state: LifeState;
  index: CorpusIndex;
  streamTail: StreamEvent[];
  now: Date;
}): Perception {
  const nowIso = input.now.toISOString();
  const last = input.state.meta.last_tick_at;
  const gap_ms = last ? Math.max(0, input.now.getTime() - Date.parse(last)) : 0;

  const recentModes: Mode[] = [];
  for (const ev of input.streamTail) {
    if (ev.type === "mode_chosen" && typeof ev.payload.mode === "string") {
      const m = ev.payload.mode;
      if (m === "idle" || m === "organize" || m === "contemplate") {
        recentModes.push(m);
      }
    }
  }

  let contemplateOrdinal = 0;
  for (const ev of input.streamTail) {
    if (ev.type === "mode_chosen" && ev.payload.mode === "contemplate") {
      contemplateOrdinal++;
    }
  }
  // also count finished contemplations via thought_written for explore cadence
  const thoughtCount = input.streamTail.filter((e) => e.type === "thought_written").length;
  if (thoughtCount > contemplateOrdinal) contemplateOrdinal = thoughtCount;

  const hasReadableCorpus = input.index.docs.some((d) => d.chunks.length > 0);
  const activeThreadCount = Object.values(input.state.threads).filter(
    (t) => t.status === "active",
  ).length;

  return {
    now: nowIso,
    last_tick_at: last,
    gap_ms,
    hasReadableCorpus,
    activeThreadCount,
    recentModes,
    contemplateOrdinal: contemplateOrdinal + 1,
    index: input.index,
  };
}
