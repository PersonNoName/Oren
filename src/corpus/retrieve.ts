import type { Config, Taste, Thread } from "../types.js";
import type { CorpusIndex } from "./index.js";

export interface ReadingPlanItem {
  path: string;
  chunk_id: string;
  text: string;
  score: number;
  reason: string;
}

export interface ReadingPlan {
  items: ReadingPlanItem[];
  thread_id?: string;
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

  const allChunks = index.docs.flatMap((d) =>
    d.chunks.map((c) => ({
      path: d.path,
      chunk_id: c.chunk_id,
      text: c.text,
      preview: c.preview,
    })),
  );

  if (allChunks.length === 0) {
    return { items: [] };
  }

  const active = Object.values(threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience);

  const tasteTerms = collectTasteTerms(taste);
  const forceExplore =
    exploreEvery > 0 && contemplateOrdinal > 0 && contemplateOrdinal % exploreEvery === 0;

  // Continue high-salience thread
  for (const thread of active) {
    if (thread.salience < 0.3 && thread.open_questions.length === 0) continue;
    const sourcePaths = new Set(thread.sources.map((s) => s.path));
    const candidates = allChunks
      .filter((c) => sourcePaths.has(c.path) || thread.open_questions.length > 0)
      .map((c) => {
        const continueBoost = sourcePaths.has(c.path) ? 2 : 0;
        const tasteScore = scoreTerms(c.preview + " " + c.text, tasteTerms);
        return {
          ...c,
          score: continueBoost + tasteScore + thread.salience,
          reason: `continue-thread:${thread.id}`,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0 && !forceExplore) {
      return packPlan(candidates, maxChunks, maxChars, thread.id);
    }
  }

  // Taste match ranking
  let ranked = allChunks
    .map((c) => {
      const tasteScore = scoreTerms(c.preview + " " + c.text, tasteTerms);
      return {
        ...c,
        score: tasteScore,
        reason: tasteScore > 0 ? "taste-match" : "default",
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  if (forceExplore && ranked.length > 1) {
    const explore = ranked[ranked.length - 1]!;
    return packPlan(
      [{ ...explore, score: 0.1, reason: "explore" }],
      maxChunks,
      maxChars,
      undefined,
    );
  }

  return packPlan(ranked, maxChunks, maxChars, undefined);
}

function packPlan(
  ranked: { path: string; chunk_id: string; text: string; score: number; reason: string }[],
  maxChunks: number,
  maxChars: number,
  threadId?: string,
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
    });
    chars += items[items.length - 1]!.text.length;
  }
  return { items, thread_id: threadId };
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
