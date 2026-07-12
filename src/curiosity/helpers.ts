import type { IntentHints, IntentKind, LifeState, Thread } from "../types.js";

/** True if intent shows a chaseable question / why (curiosity anchor). */
export function intentHasQuestionAnchor(it: {
  kind: IntentKind | string;
  title: string;
  hints?: IntentHints;
}): boolean {
  if (it.kind === "idle") return true;
  if (it.kind === "organize") return true;
  if ((it.hints?.open_questions?.length ?? 0) > 0) return true;
  if (it.hints?.query && String(it.hints.query).trim().length > 0) return true;
  if (it.hints?.why && it.hints.why.trim().length >= 4) return true;
  if (it.hints?.mode === "note" && it.title.trim().length >= 2) return true;
  const text = `${it.title} ${(it.hints?.open_questions ?? []).join(" ")}`;
  if (/[？?]/.test(text)) return true;
  if (/什么|为什么|怎么|如何|想搞懂|想弄清|好奇|卡在|弄明白/.test(text)) return true;
  // think with a substantive Chinese title counts as pursuing something
  if (it.kind === "think" && it.title.trim().length >= 4 && !/^读/.test(it.title)) {
    return true;
  }
  return false;
}

/** Plan is all-read (or empty of non-read) with no curiosity anchors → needs repair. */
export function planLacksCuriosity(intents: {
  kind: IntentKind | string;
  title: string;
  hints?: IntentHints;
}[]): boolean {
  const actionable = intents.filter((i) => i.kind !== "idle");
  if (actionable.length === 0) return false;
  const allRead = actionable.every((i) => i.kind === "read");
  if (allRead && actionable.every((i) => !intentHasQuestionAnchor(i))) return true;
  const anchored = actionable.filter((i) => intentHasQuestionAnchor(i)).length;
  return anchored < Math.ceil(actionable.length * 0.4);
}

export function collectTopOpenQuestions(
  state: LifeState,
  max = 6,
): { thread_id: string; title: string; question: string }[] {
  const out: { thread_id: string; title: string; question: string }[] = [];
  const threads = Object.values(state.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience);
  for (const t of threads) {
    for (const q of t.open_questions.slice(0, 3)) {
      const question = q.trim();
      if (!question) continue;
      out.push({ thread_id: t.id, title: t.title, question });
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function focusQuestionSummary(state: LifeState, fallback = "这会儿还没有咬住的问题，可以发呆或随手记一笔。"): string {
  const top = collectTopOpenQuestions(state, 1)[0];
  if (!top) return fallback;
  return `当前最咬人的问题：${top.question}（线索：${top.title}）`;
}

/** Inject think/note intents so plan is question-led. */
export function injectCuriosityIntents<
  T extends {
    kind: IntentKind;
    title: string;
    thread_id?: string;
    hints?: IntentHints;
  },
>(intents: T[], state: LifeState): T[] {
  const qs = collectTopOpenQuestions(state, 3);
  const injected: T[] = [];
  if (qs[0]) {
    injected.push({
      kind: "think",
      title: `想清楚：${qs[0].question.slice(0, 40)}`,
      thread_id: qs[0].thread_id,
      hints: {
        mode: "ruminate",
        open_questions: [qs[0].question],
        why: "被这个问题勾住",
      },
    } as T);
    const noteQ = qs[1] ?? qs[0];
    injected.push({
      kind: "think",
      title: `随手记：${noteQ.question.slice(0, 36)}`,
      thread_id: noteQ.thread_id,
      hints: {
        mode: "note",
        open_questions: [noteQ.question],
        why: "主动记一笔",
      },
    } as T);
  } else {
    injected.push({
      kind: "think",
      title: "坐一会儿，看自己在意什么",
      hints: { mode: "ruminate", why: "无线索问题时先感受空白" },
    } as T);
  }

  const rest = intents.map((it) => {
    if (it.kind !== "read" || intentHasQuestionAnchor(it)) return it;
    const q = qs[0]?.question;
    return {
      ...it,
      hints: {
        ...it.hints,
        why: it.hints?.why ?? (q ? `为推进：${q.slice(0, 80)}` : "带着问题翻书架"),
        open_questions: it.hints?.open_questions ?? (q ? [q] : undefined),
      },
    };
  });

  // Prefer curiosity first; drop trailing idles if overlong later in materialize
  return [...injected, ...rest];
}

export function formatSeepageWithQuestions(threads: Thread[], maxQ = 2): string {
  if (threads.length === 0) return "(none)";
  return threads
    .map((t) => {
      const qs = t.open_questions.slice(0, maxQ);
      const qLine =
        qs.length > 0
          ? `open_questions: ${qs.map((q) => `「${q}」`).join(" ")}`
          : "open_questions: （暂无）";
      return `- id=${t.id} title="${t.title}" sal=${t.salience.toFixed(2)}\n  summary: ${t.summary.slice(0, 120)}\n  ${qLine}`;
    })
    .join("\n");
}

/**
 * If user message looks like answering a seepage open question, fold into summary/questions.
 * Heuristic only — no NLU.
 */
export function absorbUserIntoCuriosity(input: {
  threads: Record<string, Thread>;
  seepage: Thread[];
  userText: string;
  now: string;
}): { threads: Record<string, Thread>; absorbed: boolean } {
  const text = input.userText.trim();
  if (text.length < 8) {
    return { threads: input.threads, absorbed: false };
  }
  // Skip pure curt
  if (
    /^(嗯+|哦+|噢+|好+|行+|随便|无所谓|哈哈+)[\s!！。.~…]*$/i.test(text)
  ) {
    return { threads: input.threads, absorbed: false };
  }

  for (const th of input.seepage) {
    const qs = th.open_questions;
    if (!qs.length) continue;
    // Prefer question that shares a content character with user text
    let hit = qs.find((q) => sharesContentToken(q, text));
    if (!hit && text.length >= 20) hit = qs[0];
    if (!hit) continue;

    const prev = input.threads[th.id] ?? th;
    const note = `用户提到：${text.slice(0, 100)}`;
    const summary =
      prev.summary.length > 0
        ? `${prev.summary.slice(0, 200)}｜${note}`
        : note;
    // Soft: keep question but mark progress in summary; optionally drop exact match
    const open_questions = prev.open_questions.filter((q) => q !== hit);
    if (open_questions.length === prev.open_questions.length) {
      // keep all but ensure summary updated
    }
    // If user gave substantial answer, drop the hit question
    const nextQs =
      text.length >= 16
        ? prev.open_questions.filter((q) => q !== hit)
        : prev.open_questions;

    return {
      threads: {
        ...input.threads,
        [th.id]: {
          ...prev,
          summary: summary.slice(0, 400),
          open_questions: nextQs.length ? nextQs : prev.open_questions,
          last_engaged_at: input.now,
        },
      },
      absorbed: true,
    };
  }
  return { threads: input.threads, absorbed: false };
}

function sharesContentToken(a: string, b: string): boolean {
  const tokens = a
    .replace(/[？?，。、！!：:；;（）()\s]/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return tokens.some((t) => b.includes(t));
}
