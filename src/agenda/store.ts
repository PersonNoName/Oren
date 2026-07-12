import fs from "node:fs/promises";
import { atomicWriteJson } from "../store/atomic-write.js";
import type { LifeStore } from "../store/life-store.js";
import { defaultAgenda, type Agenda, type Intent } from "../types.js";

export async function loadAgenda(store: LifeStore, now = new Date().toISOString()): Promise<Agenda> {
  try {
    const raw = await fs.readFile(store.paths.agenda, "utf8");
    const data = JSON.parse(raw) as Agenda;
    if (!data || typeof data !== "object") return defaultAgenda(now);
    return {
      ...defaultAgenda(now),
      ...data,
      queue: Array.isArray(data.queue) ? data.queue : [],
      intents: data.intents && typeof data.intents === "object" ? data.intents : {},
      actions_since_plan:
        typeof data.actions_since_plan === "number" ? data.actions_since_plan : 0,
    };
  } catch {
    return defaultAgenda(now);
  }
}

export async function saveAgenda(store: LifeStore, agenda: Agenda): Promise<void> {
  await atomicWriteJson(store.paths.agenda, agenda);
}

export function pendingIntentIds(agenda: Agenda): string[] {
  return agenda.queue.filter((id) => {
    const it = agenda.intents[id];
    return it && (it.status === "pending" || it.status === "blocked");
  });
}

export function nextActionableIntent(agenda: Agenda): Intent | null {
  for (const id of agenda.queue) {
    const it = agenda.intents[id];
    if (!it) continue;
    if (it.status === "pending") return it;
    // blocked seek stays visible but is skipped for act (handled by scheduler)
  }
  return null;
}

export function appendIntents(
  agenda: Agenda,
  intents: Intent[],
  now: string,
  maxQueue: number,
): Agenda {
  const next: Agenda = {
    ...agenda,
    updated_at: now,
    intents: { ...agenda.intents },
    queue: [...agenda.queue],
  };
  for (const intent of intents) {
    // deferred calendar items live in intents map only until promoted
    if (intent.status === "deferred") {
      next.intents[intent.id] = intent;
      continue;
    }
    if (next.queue.length >= maxQueue) break;
    if (next.intents[intent.id]) continue;
    next.intents[intent.id] = intent;
    next.queue.push(intent.id);
  }
  return next;
}
