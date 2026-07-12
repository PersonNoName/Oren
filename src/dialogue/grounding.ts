import type { DialogueShare, ShareKind, Thread, ThreadQuote } from "../types.js";
import {
  claimsReading,
  inferShareKind,
  parseShareKind,
} from "./epistemics.js";

export { claimsReading };

const MAX_QUOTES_STORED = 12;
const MAX_QUOTE_CHARS = 280;

/**
 * Keep short, deduped corpus excerpts on a thread.
 * Quotes are the only "I read X" evidence dialogue may use.
 */
export function mergeThreadQuotes(
  existing: ThreadQuote[] | undefined,
  incoming: { text: string; path: string; chunk_id?: string; at: string }[],
): ThreadQuote[] {
  const map = new Map<string, ThreadQuote>();
  for (const q of existing ?? []) {
    const key = `${q.path}::${q.chunk_id ?? ""}::${normalizeQuoteKey(q.text)}`;
    map.set(key, q);
  }
  for (const raw of incoming) {
    const text = clipQuote(raw.text);
    if (!text) continue;
    const key = `${raw.path}::${raw.chunk_id ?? ""}::${normalizeQuoteKey(text)}`;
    map.set(key, {
      text,
      path: raw.path,
      chunk_id: raw.chunk_id,
      at: raw.at,
    });
  }
  return [...map.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_QUOTES_STORED);
}

export function clipQuote(text: string, max = MAX_QUOTE_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function normalizeQuoteKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
}

/** Human-readable ledger for the dialogue prompt (read vs think vs write). */
export function formatGroundedMaterials(threads: Thread[]): string {
  if (threads.length === 0) {
    return [
      "(no active threads)",
      "Elastic mode: you may still chat or say what you are *thinking*.",
      "You must NOT claim to be reading a book or file you do not have.",
      "Thin materials: admit it if the shelf is empty.",
    ].join("\n");
  }
  return threads
    .map((t) => {
      const sources =
        t.sources.length > 0
          ? t.sources
              .map((s) => (s.chunk_id ? `${s.path} (${s.chunk_id})` : s.path))
              .join("; ")
          : "(no corpus sources)";
      const quotes = (t.quotes ?? []).slice(0, 4);
      const thin = quotes.length === 0;
      const quoteBlock =
        quotes.length > 0
          ? quotes
              .map((q, i) => `  Q${i + 1} [${q.path}]: "${q.text}"`)
              .join("\n")
          : "  (no quotes yet — do not invent reading; you may share THINK/WRITE only)";
      return [
        `### thread ${t.id}`,
        `title: ${t.title}`,
        `READ sources: ${sources}`,
        thin ? "shelf: THIN — prefer honesty over inventing volume" : "shelf: has quotes",
        `THINK summary (your interpretation — not a book title): ${t.summary}`,
        `THINK open_questions: ${JSON.stringify(t.open_questions)}`,
        `READ quotes (verbatim corpus — only these may back "I read…"):`,
        quoteBlock,
      ].join("\n");
    })
    .join("\n\n");
}

export function groundedReadShare(thread: Thread): DialogueShare | null {
  const q = (thread.quotes ?? [])[0];
  if (q) {
    return {
      opened: true,
      kind: "read",
      thread_id: thread.id,
      snippet: `From ${q.path}: "${q.text}"`,
      source_path: q.path,
      chunk_id: q.chunk_id,
      reason: "grounded read from stored quote",
    };
  }
  const path = thread.sources[0]?.path;
  if (path) {
    return {
      opened: true,
      kind: "read",
      thread_id: thread.id,
      snippet: `Local notes in ${path} (thin — no long excerpts stored yet). Theme: ${thread.summary.slice(0, 160)}`,
      source_path: path,
      chunk_id: thread.sources[0]?.chunk_id,
      reason: "grounded read path only (thin quotes)",
    };
  }
  return null;
}

export function groundedThinkShare(thread: Thread): DialogueShare {
  const q = thread.open_questions[0];
  const snippet = q
    ? `I've been turning over: ${q}`
    : thread.summary
      ? `I've been thinking: ${thread.summary.slice(0, 200)}`
      : `I've been sitting with "${thread.title}".`;
  return {
    opened: true,
    kind: "think",
    thread_id: thread.id,
    snippet,
    reason: "elastic think share (no ungrounded reading claim)",
  };
}

export function groundedWriteShare(thread: Thread): DialogueShare {
  return {
    opened: true,
    kind: "write",
    thread_id: thread.id,
    snippet: `From my own notes on "${thread.title}": ${thread.summary.slice(0, 200)}`,
    reason: "self-authored note share",
  };
}

/** @deprecated use groundedReadShare / resolveSharePayload */
export function groundedShareSnippet(thread: Thread): {
  snippet: string;
  source_paths: string[];
} {
  const read = groundedReadShare(thread);
  if (read?.snippet) {
    return {
      snippet: read.snippet,
      source_paths: read.source_path ? [read.source_path] : [],
    };
  }
  const think = groundedThinkShare(thread);
  return { snippet: think.snippet ?? thread.title, source_paths: [] };
}

/** Reject model snippets that invent books/titles without corpus backing. */
export function looksUngroundedInvention(text: string, thread: Thread): boolean {
  const t = text.trim();
  if (!t) return true;
  const booky = looksLikeInventedBook(t);
  if (!booky && !claimsReading(t)) return false;

  if (hasReadBacking(t, thread)) return false;
  return true;
}

export function looksLikeInventedBook(text: string): boolean {
  return /(一本|那本|这本).{0,12}(书|著作|读物)|(old book|textbook|monograph)|植物学|botany|《[^》]{1,40}》/i.test(
    text,
  );
}

/** Reply is backed by at least one real path or quote fragment from the thread. */
export function hasReadBacking(text: string, thread: Thread): boolean {
  const t = text.toLowerCase();
  const pathHit = thread.sources.some((s) => {
    const base = s.path.toLowerCase().replace(/\.[^.]+$/, "");
    return t.includes(s.path.toLowerCase()) || (base.length >= 3 && t.includes(base));
  });
  if (pathHit) return true;
  return (thread.quotes ?? []).some((q) => {
    const frag = q.text.slice(0, Math.min(24, q.text.length));
    return frag.length >= 8 && text.includes(frag);
  });
}

/**
 * Full-reply guard: any "I read…" / book claim must be backed by seepage materials.
 * Pure think/chat with no reading claim → ok.
 */
export function replyHasUngroundedReading(reply: string, threads: Thread[]): boolean {
  const t = reply.trim();
  if (!t) return false;
  const readingish = claimsReading(t) || looksLikeInventedBook(t);
  if (!readingish) return false;
  if (threads.length === 0) return true;
  // Valid iff at least one seepage thread supplies path/quote backing
  return !threads.some((th) => hasReadBacking(t, th));
}

/** Deterministic safe reply when model keeps inventing reading. */
export function safeGroundedReply(threads: Thread[], preferZh: boolean): string {
  // Product is Chinese-first; preferZh false only for rare all-English companions.
  const th = threads[0];
  if (!th) {
    return preferZh
      ? "最近没在读什么正经材料，就随口想了想。书架其实挺空的。"
      : "Not really reading anything solid — mostly just thinking. Thin shelf right now.";
  }
  const q = (th.quotes ?? [])[0];
  if (q) {
    const clip = q.text.length > 90 ? `${q.text.slice(0, 89)}…` : q.text;
    return preferZh
      ? `在看本地的 ${q.path}，有一句大概是：「${clip}」。就这几段，没别的大部头。`
      : `Looking at local ${q.path} — one line is roughly: "${clip}". That's about the whole shelf.`;
  }
  const path = th.sources[0]?.path;
  if (path) {
    return preferZh
      ? `就翻了翻本地的 ${path}，材料不厚，谈不上在读什么书。`
      : `Just skimming local ${path}. Not much material — not a real book pile.`;
  }
  return preferZh
    ? `最近在想「${th.title}」，还说不上在读什么。`
    : `Mostly thinking about "${th.title}" — not really reading a thing.`;
}

export function prefersChinese(text: string): boolean {
  const zh = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  return zh >= en;
}

/**
 * Final share payload under elastic epistemics:
 * - read requires corpus path/quote; inventions demoted to think or forced to real read
 * - think/write allowed without inventing external books
 */
export function resolveSharePayload(input: {
  thread: Thread;
  opened: boolean;
  kind?: ShareKind | string;
  snippet?: string;
  reason?: string;
}): DialogueShare {
  const { thread } = input;
  if (!input.opened) {
    return { opened: false, reason: input.reason };
  }

  let kind =
    parseShareKind(input.kind) ??
    inferShareKind(input.snippet, input.reason, thread);

  const modelSnippet = input.snippet?.trim() ?? "";
  const inventing = modelSnippet
    ? looksUngroundedInvention(modelSnippet, thread)
    : false;

  // Reading claims without evidence → demote to think (elastic) or real read.
  if (kind === "read" || inventing || claimsReading(modelSnippet)) {
    if (inventing || !modelSnippet || looksUngroundedInvention(modelSnippet, thread)) {
      const read = groundedReadShare(thread);
      if (read) {
        return {
          ...read,
          reason: input.reason ?? read.reason,
        };
      }
      // No corpus → elastic think instead of fake book
      const think = groundedThinkShare(thread);
      return {
        ...think,
        reason:
          input.reason ??
          "demoted ungrounded reading claim → think (elastic, thin shelf)",
      };
    }
    // Model snippet looks ok for reading
    const path =
      thread.sources.find((s) =>
        modelSnippet.toLowerCase().includes(s.path.toLowerCase()),
      )?.path ??
      (thread.quotes ?? [])[0]?.path ??
      thread.sources[0]?.path;
    return {
      opened: true,
      kind: "read",
      thread_id: thread.id,
      snippet: modelSnippet,
      source_path: path,
      chunk_id:
        (thread.quotes ?? []).find((q) => q.path === path)?.chunk_id ??
        thread.sources.find((s) => s.path === path)?.chunk_id,
      reason: input.reason,
    };
  }

  if (kind === "write") {
    if (inventing) {
      return {
        ...groundedWriteShare(thread),
        reason: input.reason ?? "rewrote ungrounded write-share",
      };
    }
    return {
      opened: true,
      kind: "write",
      thread_id: thread.id,
      snippet: modelSnippet || groundedWriteShare(thread).snippet,
      reason: input.reason,
    };
  }

  // think (elastic default)
  if (inventing) {
    return {
      ...groundedThinkShare(thread),
      reason: input.reason ?? "stripped invention from think-share",
    };
  }
  return {
    opened: true,
    kind: "think",
    thread_id: thread.id,
    snippet: modelSnippet || groundedThinkShare(thread).snippet,
    reason: input.reason,
  };
}
