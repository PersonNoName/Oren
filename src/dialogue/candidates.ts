/**
 * Read-only conversation candidates for dialogue (product lock):
 * agenda is NOT executed while chatting — only offered as optional topic fuel.
 */
import type { Agenda, Intent, Thread } from "../types.js";

export interface TalkCandidate {
  source: "thread" | "agenda" | "monologue";
  label: string;
  detail?: string;
  thread_id?: string;
  intent_id?: string;
}

export function collectTalkCandidates(input: {
  threads: Record<string, Thread>;
  agenda?: Agenda | null;
  /** Optional short monologue previews from recent ticks. */
  recentMonologues?: string[];
  max?: number;
}): TalkCandidate[] {
  const max = input.max ?? 8;
  const out: TalkCandidate[] = [];

  const active = Object.values(input.threads)
    .filter((t) => t.status === "active")
    .sort(
      (a, b) =>
        b.salience - a.salience || b.last_engaged_at.localeCompare(a.last_engaged_at),
    );

  for (const t of active.slice(0, 4)) {
    out.push({
      source: "thread",
      label: t.title,
      detail: (t.open_questions[0] ?? t.summary).slice(0, 120),
      thread_id: t.id,
    });
    if (out.length >= max) return out;
  }

  if (input.agenda) {
    for (const id of input.agenda.queue) {
      const it = input.agenda.intents[id];
      if (!it) continue;
      if (it.status !== "pending" && it.status !== "blocked") continue;
      if (!isTalkishIntent(it)) continue;
      out.push({
        source: "agenda",
        label: it.title,
        detail: it.hints?.why ?? it.hints?.open_questions?.[0],
        thread_id: it.thread_id,
        intent_id: it.id,
      });
      if (out.length >= max) return out;
    }
  }

  for (const m of input.recentMonologues ?? []) {
    const t = m.trim();
    if (!t) continue;
    out.push({
      source: "monologue",
      label: "刚独处时想到的",
      detail: t.slice(0, 120),
    });
    if (out.length >= max) break;
  }

  return out;
}

function isTalkishIntent(it: Intent): boolean {
  if (it.kind === "say") return true;
  if (it.kind === "think") return true;
  // care-style dialogue items
  if (it.source === "dialogue" && /^关心：/.test(it.title)) return true;
  return false;
}

export function formatTalkCandidatesForPrompt(candidates: TalkCandidate[]): string {
  if (candidates.length === 0) {
    return "（暂无额外候选；可只顺着用户聊，不必硬抛题）";
  }
  return candidates
    .map((c, i) => {
      const src =
        c.source === "thread" ? "线索" : c.source === "agenda" ? "计划候选" : "独白";
      const id = c.thread_id ? ` id=${c.thread_id}` : c.intent_id ? ` intent=${c.intent_id}` : "";
      const det = c.detail ? ` — ${c.detail}` : "";
      return `${i + 1}. [${src}${id}] ${c.label}${det}`;
    })
    .join("\n");
}
