import fs from "node:fs/promises";
import { atomicWriteJson } from "../store/atomic-write.js";
import type { LifeStore } from "../store/life-store.js";
import { loadAgenda, saveAgenda } from "../agenda/store.js";
import {
  defaultWill,
  type Agenda,
  type LifeState,
  type Will,
} from "../types.js";

export async function loadWill(store: LifeStore, now: string): Promise<Will> {
  try {
    const raw = await fs.readFile(store.paths.will, "utf8");
    const data = JSON.parse(raw) as Will;
    return normalizeWill(data, now);
  } catch {
    const agenda = await loadAgenda(store, now);
    const state = await store.load().catch(() => null);
    return synthesizeWillFromLife({ agenda, state, now });
  }
}

export async function saveWill(store: LifeStore, will: Will): Promise<void> {
  await atomicWriteJson(store.paths.will, will);
}

/** Dual-write session projection for transition period. */
export async function saveWillAndAgenda(
  store: LifeStore,
  will: Will,
): Promise<void> {
  await saveWill(store, will);
  await saveAgenda(store, will.session);
}

export function synthesizeWillFromLife(input: {
  agenda: Agenda;
  state: LifeState | null;
  now: string;
}): Will {
  const base = defaultWill(input.now);
  const active = input.state
    ? Object.values(input.state.threads)
        .filter((t) => t.status === "active")
        .sort((a, b) => b.salience - a.salience)
    : [];
  const top = active[0];
  return {
    ...base,
    updated_at: input.now,
    focus: top
      ? { thread_id: top.id, summary: top.title || top.summary.slice(0, 80) }
      : base.focus,
    session: input.agenda,
    last_reason: "synthesized_from_agenda",
  };
}

export function normalizeWill(raw: Will, now: string): Will {
  const d = defaultWill(now);
  return {
    updated_at: raw.updated_at ?? now,
    focus: {
      thread_id: raw.focus?.thread_id,
      summary: raw.focus?.summary?.trim() || d.focus.summary,
    },
    solitude: {
      mode_bias: raw.solitude?.mode_bias ?? "mixed",
      note: raw.solitude?.note,
    },
    toward_user: {
      posture: raw.toward_user?.posture ?? "quiet",
      share_drive: raw.toward_user?.share_drive ?? "low",
      ask_drive: raw.toward_user?.ask_drive ?? "low",
    },
    open_moves: Array.isArray(raw.open_moves) ? raw.open_moves : [],
    session: raw.session ?? d.session,
    last_reason: raw.last_reason,
  };
}
