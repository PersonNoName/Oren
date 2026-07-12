import { randomUUID } from "node:crypto";
import type { ReadingPlan } from "../corpus/retrieve.js";
import { mergeThreadQuotes } from "../dialogue/grounding.js";
import { lacksChinese, ZH_OUTPUT_RULE } from "../locale.js";
import type { LlmCompleter } from "../llm/types.js";
import { describeAbsence } from "../relation/visit.js";
import { formatClockForPrompt } from "../time/clock.js";
import type { LifeState, Thread, TickPatch } from "../types.js";
import { assertArtifactUseful, parseArtifact } from "./parse-artifact.js";

const SYSTEM_READ = `你是 Oren，在写给自己的私人笔记（不是公开演讲，不是客服）。
本回合有新的本地阅读材料。结合材料与当前线索书写。

${ZH_OUTPUT_RULE}

认识边界：
- 阅读摘录是 READ（读到的），不要说成你写的书。
- monologue 是 WRITE：你自己的笔记本。
- refined_summary / open_questions 是 THINK：你的理解，不是书名。
- 不要编造材料里没有的书名、作者、出处。
- 材料少就如实写，不要注水。

语气：好奇、具体、口语一点，不要神神叨叨。
关系字段只是背景，不要问候用户，不要当助手。
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
monologue：2–6 句中文，像自己写的笔记。`;

const SYSTEM_THINK = `你是 Oren，在做「纯想」回合：没有新的阅读材料。
本地未读已空（或没有语料）。不要假装刚打开了新文件，不要编造书名。
只根据已有线索：标题、摘要、开放问题、旧摘录。
可以：深化问题、换个角度、记下「以后想查什么」（写成 open_question）。
禁止：假装刚读了新文档；编造不在 quotes/sources 里的出处。

${ZH_OUTPUT_RULE}

语气：好奇、具体、口语。不要问候用户。
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
monologue：2–6 句中文，纯思考/回忆。`;

export async function buildContemplatePatch(input: {
  state: LifeState;
  plan: ReadingPlan;
  llm: LlmCompleter;
  tickId: string;
  now: string;
}): Promise<{ patch: TickPatch; raw: string; artifact: ReturnType<typeof parseArtifact> }> {
  const { state, plan, llm, tickId, now } = input;
  const isThink = plan.kind === "think" || plan.items.length === 0;
  if (!isThink && plan.items.length === 0) {
    throw new Error("cannot contemplate-read without reading plan items");
  }

  const thread = plan.thread_id ? state.threads[plan.thread_id] : undefined;
  const system = isThink ? SYSTEM_THINK : SYSTEM_READ;
  const user = buildContemplateUser({ state, plan, thread, now, isThink });

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
}): string {
  const { state, plan, thread, now, isThink } = input;
  const parts = [
    `## 计划类型: ${plan.kind} (intent=${plan.intent})`,
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
  ];

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
