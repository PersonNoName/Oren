import type { Config, Taste, Thread } from "../types.js";
import type { CorpusIndex } from "./index.js";

export interface ReadingPlanItem {
  path: string;
  chunk_id: string;
  text: string;
  score: number;
  reason: string;
  /** How many times this chunk appears in reading_log across threads. */
  prior_reads?: number;
}

/**
 * read  — open new (or rarely lightly-read) local material
 * think — no new reading; work from memory / open questions (shelf exhausted)
 * seek  — reserved for future external search / browse rights
 */
export type ReadingPlanKind = "read" | "think" | "seek";

export interface ReadingPlan {
  items: ReadingPlanItem[];
  thread_id?: string;
  kind: ReadingPlanKind;
  /** Machine-readable intent for audit + future seek. */
  intent: string;
  /** Future: natural-language query when kind=seek. */
  seek_query?: string;
}

export function planReading(input: {
  index: CorpusIndex;
  taste: Taste;
  threads: Record<string, Thread>;
  config: Config;
  contemplateOrdinal: number;
}): ReadingPlan {
  const { index, taste, threads, config, contemplateOrdinal } = input;
  const maxChunks = config.contemplate.max_chunks;
  const maxChars = config.contemplate.max_chars;
  const exploreEvery = config.contemplate.explore_every_n;
  const preferUnread = config.contemplate.prefer_unread !== false;
  const allowReread = config.contemplate.allow_reread === true;

  const allChunks = index.docs.flatMap((d) =>
    d.chunks.map((c) => ({
      path: d.path,
      chunk_id: c.chunk_id,
      text: c.text,
      preview: c.preview,
    })),
  );

  const readCounts = collectChunkReadCounts(threads);
  const active = Object.values(threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience);

  const focusThread = pickFocusThread(active);
  const tasteTerms = collectTasteTerms(taste);
  const forceExplore =
    exploreEvery > 0 && contemplateOrdinal > 0 && contemplateOrdinal % exploreEvery === 0;

  // No local corpus at all → pure think if we have memory, else empty (engine may idle).
  if (allChunks.length === 0) {
    if (focusThread) {
      return thinkPlan(focusThread.id, "think_no_corpus");
    }
    return { items: [], kind: "think", intent: "empty_shelf" };
  }

  const withMeta = allChunks.map((c) => {
    const prior = readCounts.get(c.chunk_id) ?? 0;
    const tasteScore = scoreTerms(c.preview + " " + c.text, tasteTerms);
    const threadBoost = focusThread
      ? scoreThreadAffinity(c, focusThread, tasteTerms)
      : 0;
    // Strong penalty for already-read; prefer brand-new material.
    const unreadBoost = preferUnread ? (prior === 0 ? 5 : -3 * prior) : 0;
    const score = tasteScore + threadBoost + unreadBoost + (prior === 0 ? 0.5 : 0);
    return {
      ...c,
      prior_reads: prior,
      score,
      reason:
        prior === 0
          ? threadBoost > 0
            ? `unread-for-thread:${focusThread?.id ?? "?"}`
            : tasteScore > 0
              ? "unread-taste"
              : "unread"
          : `reread:${prior}`,
    };
  });

  const unread = withMeta.filter((c) => c.prior_reads === 0);
  const lightlyRead = withMeta.filter((c) => (c.prior_reads ?? 0) > 0 && (c.prior_reads ?? 0) < 2);

  // 1) Prefer never-read chunks (optionally biased toward active thread affinity).
  if (unread.length > 0) {
    let pool = [...unread].sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path),
    );
    if (forceExplore && pool.length > 1) {
      // Explore = least scored unread, still never re-read a finished shelf item first.
      const explore = pool[pool.length - 1]!;
      return packPlan(
        [{ ...explore, score: 0.1, reason: "explore-unread" }],
        maxChunks,
        maxChars,
        focusThread?.id,
        "read",
        "explore_unread",
      );
    }
    // Soft continue: if focus thread has unread in same path, boost those to front.
    if (focusThread) {
      const sourcePaths = new Set(focusThread.sources.map((s) => s.path));
      const samePathUnread = pool.filter((c) => sourcePaths.has(c.path));
      if (samePathUnread.length > 0) {
        pool = [
          ...samePathUnread.map((c) => ({
            ...c,
            reason: `continue-unread:${focusThread.id}`,
            score: c.score + 2,
          })),
          ...pool.filter((c) => !sourcePaths.has(c.path)),
        ].sort((a, b) => b.score - a.score);
      }
    }
    return packPlan(pool, maxChunks, maxChars, focusThread?.id, "read", "read_unread");
  }

  // 2) Shelf exhausted of unread material → think from memory (default).
  // Optional rare reread only if explicitly allowed.
  if (!allowReread) {
    if (focusThread) {
      return thinkPlan(focusThread.id, "think_shelf_exhausted");
    }
    // No thread yet but everything read once — still think, may open a new thread from monologue.
    return { items: [], kind: "think", intent: "think_shelf_exhausted_no_thread" };
  }

  // allow_reread: only lightly-read, never pile onto heavily reread chunks
  if (lightlyRead.length > 0) {
    const pool = lightlyRead.sort((a, b) => b.score - a.score);
    return packPlan(
      pool.map((c) => ({ ...c, reason: `allowed-reread:${c.prior_reads}` })),
      maxChunks,
      maxChars,
      focusThread?.id,
      "read",
      "reread_light",
    );
  }

  if (focusThread) {
    return thinkPlan(focusThread.id, "think_after_heavy_reread");
  }
  return { items: [], kind: "think", intent: "think_no_fresh_material" };
}

/** Collect how often each chunk_id has been read (from all threads' logs). */
export function collectChunkReadCounts(
  threads: Record<string, Thread>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of Object.values(threads)) {
    for (const entry of t.reading_log ?? []) {
      const key = entry.chunk_id || `${entry.path}#`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Also treat stored quotes as "already internalized" for that chunk.
    for (const q of t.quotes ?? []) {
      if (!q.chunk_id) continue;
      if (!counts.has(q.chunk_id)) counts.set(q.chunk_id, 1);
    }
  }
  return counts;
}

function pickFocusThread(active: Thread[]): Thread | undefined {
  for (const thread of active) {
    if (thread.salience >= 0.3 || thread.open_questions.length > 0) return thread;
  }
  return active[0];
}

function scoreThreadAffinity(
  chunk: { path: string; preview: string; text: string },
  thread: Thread,
  tasteTerms: string[],
): number {
  let score = 0;
  if (thread.sources.some((s) => s.path === chunk.path)) score += 1.5;
  const blob = `${chunk.preview} ${chunk.text}`.toLowerCase();
  for (const q of thread.open_questions) {
    for (const w of q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
      if (w.length >= 4 && blob.includes(w)) score += 0.5;
    }
  }
  // tiny taste overlap on top
  score += scoreTerms(blob, tasteTerms) * 0.25;
  return score;
}

function thinkPlan(threadId: string | undefined, intent: string): ReadingPlan {
  return {
    items: [],
    thread_id: threadId,
    kind: "think",
    intent,
  };
}

function packPlan(
  ranked: {
    path: string;
    chunk_id: string;
    text: string;
    score: number;
    reason: string;
    prior_reads?: number;
  }[],
  maxChunks: number,
  maxChars: number,
  threadId: string | undefined,
  kind: ReadingPlanKind,
  intent: string,
): ReadingPlan {
  const items: ReadingPlanItem[] = [];
  let chars = 0;
  for (const c of ranked) {
    if (items.length >= maxChunks) break;
    if (chars + c.text.length > maxChars && items.length > 0) break;
    items.push({
      path: c.path,
      chunk_id: c.chunk_id,
      text: c.text.slice(0, maxChars - chars),
      score: c.score,
      reason: c.reason,
      prior_reads: c.prior_reads,
    });
    chars += items[items.length - 1]!.text.length;
  }
  if (items.length === 0) {
    return thinkPlan(threadId, "think_pack_empty");
  }
  return { items, thread_id: threadId, kind, intent };
}

function collectTasteTerms(taste: Taste): string[] {
  const texts = [...taste.values, ...taste.aesthetics].map((x) => x.statement);
  const terms = new Set<string>();
  for (const t of texts) {
    for (const w of t.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
      if (w.length >= 3) terms.add(w);
    }
  }
  return [...terms];
}

function scoreTerms(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += 1;
  }
  return score;
}
