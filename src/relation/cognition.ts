import fs from "node:fs/promises";
import { atomicWriteJson } from "../store/atomic-write.js";
import type { LifeStore } from "../store/life-store.js";
import {
  defaultRelation,
  type DialogueReplyArtifact,
  type DialogueTurn,
  type RelationState,
  type Thread,
} from "../types.js";

export async function loadRelation(store: LifeStore): Promise<RelationState> {
  try {
    const text = await fs.readFile(store.paths.relation, "utf8");
    const raw = JSON.parse(text) as RelationState;
    return {
      updated_at: raw.updated_at ?? new Date().toISOString(),
      cold_topics: raw.cold_topics ?? [],
      warm_topics: raw.warm_topics ?? [],
      notes: raw.notes ?? [],
    };
  } catch {
    return defaultRelation(new Date().toISOString());
  }
}

export async function saveRelation(
  store: LifeStore,
  relation: RelationState,
): Promise<void> {
  await atomicWriteJson(store.paths.relation, relation);
}

/**
 * After a dialogue turn, absorb relation_note + reception into durable cognition.
 * Content sovereignty: never deletes Oren's threads; only calibrates future share.
 */
export async function absorbDialogueCognition(input: {
  store: LifeStore;
  userText: string;
  artifact: DialogueReplyArtifact;
  share?: DialogueTurn["share"];
  seepage: Thread[];
  now?: Date;
}): Promise<RelationState> {
  const now = (input.now ?? new Date()).toISOString();
  const rel = await loadRelation(input.store);
  const topicKeys = topicKeysFromShare(input.share, input.seepage, input.artifact);

  const reception = inferReception(input.userText, input.artifact.reception);

  if (reception === "cold") {
    for (const key of topicKeys) {
      bumpTopic(rel.cold_topics, key, now, input.artifact.relation_note);
      // optional: decay warm if same key
      rel.warm_topics = rel.warm_topics.filter((t) => t.key !== key);
    }
  } else if (reception === "warm") {
    for (const key of topicKeys) {
      bumpTopic(rel.warm_topics, key, now, input.artifact.relation_note);
    }
  }

  if (input.artifact.relation_note?.trim()) {
    rel.notes = [...rel.notes, `${now}: ${input.artifact.relation_note.trim()}`].slice(
      -40,
    );
  }

  rel.updated_at = now;
  // keep lists bounded
  rel.cold_topics = rel.cold_topics
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 30);
  rel.warm_topics = rel.warm_topics
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 30);

  await saveRelation(input.store, rel);
  return rel;
}

/** Heuristic if model omitted reception. */
export function inferReception(
  userText: string,
  model?: DialogueReplyArtifact["reception"],
): NonNullable<DialogueReplyArtifact["reception"]> {
  if (model && model !== "unknown") return model;
  const t = userText.toLowerCase();
  if (
    /\b(boring|whatever|idc|don't care|dont care|not interested|stop|enough|无聊|没兴趣|随便|别说了)\b/i.test(
      t,
    )
  ) {
    return "cold";
  }
  if (
    /\b(love|fascinating|tell me more|interesting|curious|more|继续|有意思|想听|真好)\b/i.test(
      t,
    )
  ) {
    return "warm";
  }
  return "neutral";
}

export function formatRelationForPrompt(rel: RelationState): string {
  const cold =
    rel.cold_topics.length === 0
      ? "(none noted)"
      : rel.cold_topics
          .slice(0, 8)
          .map((t) => `- ${t.key} (hits=${t.hits})`)
          .join("\n");
  const warm =
    rel.warm_topics.length === 0
      ? "(none noted)"
      : rel.warm_topics
          .slice(0, 8)
          .map((t) => `- ${t.key} (hits=${t.hits})`)
          .join("\n");
  const notes = rel.notes.slice(-5).join("\n") || "(none)";
  return [
    "Companion seems cold toward:",
    cold,
    "Companion seems warm toward:",
    warm,
    "Recent relation notes:",
    notes,
    "Rule: do not drop your own excitement about cold topics; just share them less often / more carefully.",
  ].join("\n");
}

/** Soft bias: if thread title/summary matches cold topics, discourage share.opened. */
export function shareBiasForThread(
  rel: RelationState,
  thread: Thread | undefined,
): "prefer_closed" | "prefer_open" | "neutral" {
  if (!thread) return "neutral";
  const blob = `${thread.title} ${thread.summary}`.toLowerCase();
  for (const c of rel.cold_topics) {
    if (c.hits >= 1 && blobIncludesKey(blob, c.key)) return "prefer_closed";
  }
  for (const w of rel.warm_topics) {
    if (w.hits >= 2 && blobIncludesKey(blob, w.key)) return "prefer_open";
  }
  return "neutral";
}

function topicKeysFromShare(
  share: DialogueTurn["share"] | undefined,
  seepage: Thread[],
  artifact: DialogueReplyArtifact,
): string[] {
  const keys = new Set<string>();
  const tid = share?.thread_id ?? artifact.share.thread_id;
  if (tid) {
    const th = seepage.find((t) => t.id === tid);
    if (th) {
      keys.add(normalizeKey(th.title));
      for (const w of th.title.split(/\s+/).filter((x) => x.length > 4).slice(0, 3)) {
        keys.add(normalizeKey(w));
      }
    }
  }
  if (share?.snippet) keys.add(normalizeKey(share.snippet.slice(0, 48)));
  if (keys.size === 0 && seepage[0]) keys.add(normalizeKey(seepage[0].title));
  return [...keys].filter(Boolean).slice(0, 4);
}

function bumpTopic(
  list: RelationState["cold_topics"],
  key: string,
  now: string,
  note?: string,
): void {
  const k = normalizeKey(key);
  if (!k) return;
  const existing = list.find((t) => t.key === k);
  if (existing) {
    existing.hits += 1;
    existing.last_at = now;
    if (note) existing.note = note;
  } else {
    list.push({ key: k, hits: 1, last_at: now, note });
  }
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 64);
}

function blobIncludesKey(blob: string, key: string): boolean {
  const k = key.toLowerCase();
  if (k.length < 3) return false;
  return blob.includes(k) || k.split(" ").some((w) => w.length > 4 && blob.includes(w));
}
