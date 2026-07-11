import type { Affect, StreamEvent } from "../types.js";
import type { LifeStore } from "../store/life-store.js";

export interface VisitResult {
  affect: Affect;
  streamEvent: StreamEvent;
}

/**
 * Record a user "visit" — relationship contact, not a chat turn.
 * Updates absence clock; optional short note (seepage material only).
 */
export async function recordVisit(
  store: LifeStore,
  opts: { note?: string; now?: Date } = {},
): Promise<VisitResult> {
  const state = await store.load();
  const now = (opts.now ?? new Date()).toISOString();
  const note = opts.note?.trim() || null;
  const prev = state.affect.absence.last_user_contact_at;

  const affect: Affect = {
    ...state.affect,
    absence: {
      last_user_contact_at: now,
      last_note: note,
      visit_count: (state.affect.absence.visit_count ?? 0) + 1,
    },
    updated_at: now,
  };

  await store.saveAffect(affect);

  const streamEvent: StreamEvent = {
    ts: now,
    tick_id: `visit_${Date.now().toString(36)}`,
    type: "user_visit",
    payload: {
      note,
      previous_contact_at: prev,
      visit_count: affect.absence.visit_count,
    },
  };
  await store.appendStream([streamEvent]);

  return { affect, streamEvent };
}

/** Human-readable absence line for prompts / doctor. */
export function describeAbsence(affect: Affect, now = new Date()): string {
  const last = affect.absence.last_user_contact_at;
  if (!last) {
    return "No recorded visits yet; the companion relationship has not been marked present.";
  }
  const ms = now.getTime() - Date.parse(last);
  const hours = Math.max(0, Math.round(ms / 3600000));
  const days = Math.floor(hours / 24);
  const ago =
    days > 1 ? `${days} days` : hours >= 1 ? `${hours} hours` : "moments";
  const note = affect.absence.last_note
    ? ` Last note: "${affect.absence.last_note}".`
    : "";
  return `Last visit was about ${ago} ago (count=${affect.absence.visit_count}).${note}`;
}
