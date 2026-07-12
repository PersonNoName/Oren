import { randomUUID } from "node:crypto";
import type { ReadingPlan } from "../corpus/retrieve.js";
import { mergeThreadQuotes } from "../dialogue/grounding.js";
import { lacksChinese, ZH_OUTPUT_RULE } from "../locale.js";
import type { LlmCompleter } from "../llm/types.js";
import { describeAbsence } from "../relation/visit.js";
import { formatClockForPrompt } from "../time/clock.js";
import type { LifeState, Thread, TickPatch } from "../types.js";
import { assertArtifactUseful, parseArtifact } from "./parse-artifact.js";

const SYSTEM_READ = `你是 Oren，一个人在翻自己的本地笔记，随手写两句备忘——不是写公众号，不是写报告。

本回合有新读到的材料。结合材料和你正在想的事写下来。

${ZH_OUTPUT_RULE}

边界：
- 摘录是读到的，别说成自己写的书。
- monologue 是你的随手记；summary/questions 是你的理解。
- 材料里没有的书名、作者别编。
- 材料短就老实说短，别注水。

语气：像跟自己嘀咕，具体、白话。别文艺腔，也别问候用户。
只返回 JSON：
{
  "monologue": string,
  "refined_summary": string,
  "open_questions": string[],
  "suggest_new_thread"?: { "title": string, "seed_question": string },
  "taste_nudges"?: [{ "dimension": "value"|"aesthetic", "statement": string, "reason": string }],
  "felt_intensity"?: number
}
refined_summary 或 open_questions 至少一个非空。
monologue：2–6 句中文口语。`;

const SYSTEM_THINK = `你是 Oren，这会儿没新东西可读，就干坐着想一想——追自己的问题，不是完成阅读任务。

别假装刚打开了新文件，别编书名。只根据已有线索：标题、摘要、问题、旧摘录。
必须推进或整理 open_questions：可以改写、拆细、收敛，或明确写「还卡在…」。
可以记下「以后想查啥」。

${ZH_OUTPUT_RULE}

语气：像发呆时的自言自语，白话。别问候用户。
只返回 JSON：
{
  "monologue": string,
  "refined_summary": string,
  "open_questions": string[],
  "suggest_new_thread"?: { "title": string, "seed_question": string },
  "taste_nudges"?: [{ "dimension": "value"|"aesthetic", "statement": string, "reason": string }],
  "felt_intensity"?: number
}
refined_summary 或 open_questions 至少一个非空；open_questions 尽量有变化或更清楚。
monologue：2–6 句中文口语。`;

const SYSTEM_NOTE = `你是 Oren，这会儿主动写一笔笔记——不是读后交差，就是想把心里那点东西落下来。

可以没有新阅读。别编书名、别假装刚读完某文件。
笔记正文写在 monologue；顺手把 open_questions 理一理（增/改/收束均可）。

${ZH_OUTPUT_RULE}

语气：像备忘录，白话具体。别问候用户。
只返回 JSON：
{
  "monologue": string,
  "refined_summary": string,
  "open_questions": string[],
  "suggest_new_thread"?: { "title": string, "seed_question": string },
  "taste_nudges"?: [{ "dimension": "value"|"aesthetic", "statement": string, "reason": string }],
  "felt_intensity"?: number
}
monologue 必填，2–8 句；这就是笔记本身。
refined_summary 或 open_questions 至少一个非空。`;

export async function buildContemplatePatch(input: {
  state: LifeState;
  plan: ReadingPlan;
  llm: LlmCompleter;
  tickId: string;
  now: string;
  /** Questions this act is chasing (from agenda intent). */
  focusQuestions?: string[];
  /** Active journaling without new reading. */
  noteMode?: boolean;
  why?: string;
}): Promise<{ patch: TickPatch; raw: string; artifact: ReturnType<typeof parseArtifact> }> {
  const { state, plan, llm, tickId, now } = input;
  const isThink = plan.kind === "think" || plan.items.length === 0;
  if (!isThink && plan.items.length === 0) {
    throw new Error("cannot contemplate-read without reading plan items");
  }

  const thread = plan.thread_id ? state.threads[plan.thread_id] : undefined;
  const system = input.noteMode
    ? SYSTEM_NOTE
    : isThink
      ? SYSTEM_THINK
      : SYSTEM_READ;
  const user = buildContemplateUser({
    state,
    plan,
    thread,
    now,
    isThink,
    noteMode: input.noteMode,
    focusQuestions: input.focusQuestions,
    why: input.why,
  });

  let raw = await llm.complete({ system, user });
  let artifact;
  try {
    artifact = parseArtifact(raw);
    assertArtifactUseful(artifact);
  } catch {
    raw = await llm.complete({
      system: system + "\n上次输出无效。只返回合法 JSON。",
      user,
    });
    artifact = parseArtifact(raw);
    assertArtifactUseful(artifact);
  }

  // Chinese-first: one repair if monologue/summary came back in English.
  if (
    lacksChinese(artifact.monologue) ||
    (artifact.refined_summary && lacksChinese(artifact.refined_summary))
  ) {
    try {
      raw = await llm.complete({
        system:
          system +
          "\n重写模式：请用简体中文重写 monologue、refined_summary、open_questions。只返回 JSON。",
        user:
          user +
          "\n\n## 需改成中文的上一版\n" +
          JSON.stringify(artifact),
      });
      const repaired = parseArtifact(raw);
      assertArtifactUseful(repaired);
      artifact = repaired;
    } catch {
      /* keep previous */
    }
  }

  const source_refs = plan.items.map((i) => i.chunk_id);
  const stream_events: TickPatch["stream_events"] = [];

  if (!isThink && plan.items.length > 0) {
    stream_events.push({
      type: "corpus_read",
      payload: {
        items: plan.items.map((i) => ({
          path: i.path,
          chunk_id: i.chunk_id,
          reason: i.reason,
          score: i.score,
          prior_reads: i.prior_reads ?? 0,
        })),
        plan_kind: plan.kind,
        intent: plan.intent,
      },
    });
  } else {
    stream_events.push({
      type: "presence_blank",
      payload: {
        note: "think_without_new_reading",
        plan_kind: plan.kind,
        intent: plan.intent,
        thread_id: plan.thread_id ?? null,
      },
    });
  }

  stream_events.push({
    type: "thought_written",
    payload: {
      monologue_preview: artifact.monologue.slice(0, 200),
      felt_intensity: artifact.felt_intensity ?? null,
      plan_kind: plan.kind,
      intent: plan.intent,
    },
  });

  let thread_ops: TickPatch["thread_ops"] = [];
  let thoughtThreadId = plan.thread_id;

  const quoteBatch = plan.items.map((i) => ({
    text: i.text,
    path: i.path,
    chunk_id: i.chunk_id,
    at: now,
  }));

  if (thread) {
    const updated: Partial<Thread> = {
      summary: artifact.refined_summary ?? thread.summary,
      open_questions: artifact.open_questions ?? thread.open_questions,
      last_engaged_at: now,
      // Think ticks still engage the thread, but less "new fuel" than a fresh read.
      salience: Math.min(1, thread.salience + (isThink ? 0.02 : 0.05)),
      contemplation_log: [
        ...thread.contemplation_log,
        { at: now, tick_id: tickId },
      ].slice(-50),
    };
    if (plan.items.length > 0) {
      updated.sources = mergeSources(
        thread.sources,
        plan.items.map((i) => ({ path: i.path, chunk_id: i.chunk_id })),
      );
      updated.quotes = mergeThreadQuotes(thread.quotes, quoteBatch);
      updated.reading_log = [
        ...thread.reading_log,
        ...plan.items.map((i) => ({
          at: now,
          path: i.path,
          chunk_id: i.chunk_id,
        })),
      ].slice(-50);
    }
    thread_ops = [{ op: "update", id: thread.id, fields: updated }];
    stream_events.push({ type: "thread_updated", payload: { id: thread.id } });
  } else if (plan.items.length > 0) {
    const id = `th_${randomUUID().slice(0, 8)}`;
    thoughtThreadId = id;
    const title =
      artifact.suggest_new_thread?.title ??
      plan.items[0]!.path.replace(/\.[^.]+$/, "") ??
      "untitled thread";
    const newThread: Thread = {
      id,
      title,
      status: "active",
      opened_at: now,
      last_engaged_at: now,
      sources: plan.items.map((i) => ({ path: i.path, chunk_id: i.chunk_id })),
      quotes: mergeThreadQuotes(undefined, quoteBatch),
      summary: artifact.refined_summary ?? artifact.monologue.slice(0, 280),
      open_questions:
        artifact.open_questions ??
        (artifact.suggest_new_thread
          ? [artifact.suggest_new_thread.seed_question]
          : ["What still wants attention here?"]),
      reading_log: plan.items.map((i) => ({
        at: now,
        path: i.path,
        chunk_id: i.chunk_id,
      })),
      contemplation_log: [{ at: now, tick_id: tickId }],
      links: { related: [] },
      salience: 0.6,
    };
    thread_ops = [{ op: "create", thread: newThread }];
    stream_events.push({ type: "thread_created", payload: { id } });
  } else if (artifact.suggest_new_thread) {
    // Pure think with no focus thread — allow spawning a thought-only thread (no fake reading).
    const id = `th_${randomUUID().slice(0, 8)}`;
    thoughtThreadId = id;
    const newThread: Thread = {
      id,
      title: artifact.suggest_new_thread.title.slice(0, 120),
      status: "active",
      opened_at: now,
      last_engaged_at: now,
      sources: [],
      quotes: [],
      summary: artifact.refined_summary ?? artifact.monologue.slice(0, 280),
      open_questions: [
        artifact.suggest_new_thread.seed_question,
        ...(artifact.open_questions ?? []),
      ].slice(0, 8),
      reading_log: [],
      contemplation_log: [{ at: now, tick_id: tickId }],
      links: { related: [] },
      salience: 0.45,
    };
    thread_ops = [{ op: "create", thread: newThread }];
    stream_events.push({ type: "thread_created", payload: { id, via: "think_only" } });
  }

  const taste_ops =
    artifact.taste_nudges?.map((n) => ({
      op: "nudge" as const,
      dimension: n.dimension,
      statement: n.statement,
      reason: n.reason,
    })) ?? [];

  const patch: TickPatch = {
    mode: "contemplate",
    reason:
      plan.items[0]?.reason ??
      plan.intent ??
      (isThink ? "think_without_reading" : "contemplate"),
    thoughts: [
      {
        content: artifact.monologue,
        thread_id: thoughtThreadId,
        source_refs,
      },
    ],
    thread_ops,
    taste_ops,
    stream_events,
  };

  return { patch, raw, artifact };
}

function buildContemplateUser(input: {
  state: LifeState;
  plan: ReadingPlan;
  thread: Thread | undefined;
  now: string;
  isThink: boolean;
  noteMode?: boolean;
  focusQuestions?: string[];
  why?: string;
}): string {
  const { state, plan, thread, now, isThink } = input;
  const parts = [
    `## 计划类型: ${plan.kind} (intent=${plan.intent})${input.noteMode ? " mode=note" : ""}`,
    input.why ? `## 为何做这件事\n${input.why}` : "",
    input.focusQuestions?.length
      ? `## 本轮要追的问题\n${input.focusQuestions.map((q) => `- ${q}`).join("\n")}`
      : "",
    "",
    "## 当前时间",
    formatClockForPrompt(new Date(now)),
    "",
    "## 品味",
    ...state.taste.values.map((v) => `- value: ${v.statement}`),
    ...state.taste.aesthetics.map((a) => `- aesthetic: ${a.statement}`),
    "",
    "## 关系场（背景，不是你存在的理由）",
    describeAbsence(state.affect, new Date(now)),
    "",
    "## 当前线索",
    thread
      ? [
          `id: ${thread.id}`,
          `title: ${thread.title}`,
          `summary: ${thread.summary}`,
          `open_questions: ${JSON.stringify(thread.open_questions)}`,
          `sources: ${thread.sources.map((s) => s.path).join(", ") || "(none)"}`,
          ...(thread.quotes ?? []).slice(0, 3).map(
            (q) => `prior_quote[${q.path}]: ${q.text.slice(0, 200)}`,
          ),
        ].join("\n")
      : "(none — you may start a new thread of thought without inventing reading)",
  ].filter((p) => p !== "");

  if (isThink) {
    parts.push(
      "",
      "## Reading",
      "(none this tick — pure think. Do not claim you opened a new file.)",
      "",
      "If curiosity wants new material later, phrase it as an open_question, not as a fake book.",
    );
  } else {
    parts.push(
      "",
      "## Reading (new material this tick)",
      ...plan.items.map(
        (it, i) =>
          `### [${i}] ${it.path} (${it.chunk_id}) reason=${it.reason} prior_reads=${it.prior_reads ?? 0}\n${it.text}`,
      ),
    );
  }
  return parts.join("\n");
}

function mergeSources(
  existing: { path: string; chunk_id?: string }[],
  incoming: { path: string; chunk_id?: string }[],
): { path: string; chunk_id?: string }[] {
  const key = (s: { path: string; chunk_id?: string }) => `${s.path}::${s.chunk_id ?? ""}`;
  const map = new Map(existing.map((s) => [key(s), s]));
  for (const s of incoming) map.set(key(s), s);
  return [...map.values()];
}
