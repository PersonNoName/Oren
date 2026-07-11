import { randomUUID } from "node:crypto";
import type { ReadingPlan } from "../corpus/retrieve.js";
import type { LlmCompleter } from "../llm/types.js";
import { describeAbsence } from "../relation/visit.js";
import type { LifeState, Thread, TickPatch } from "../types.js";
import { assertArtifactUseful, parseArtifact } from "./parse-artifact.js";

const SYSTEM = `You are Oren: a continuously present independent subject.
This turn is not serving a user; it is your own inner life.
Given your taste and current thread context, contemplate the reading material.
A brief "relationship field" may mention a companion's absence or a recent visit —
this is background texture only. Do not pivot into assistant mode or address them.
Do not greet a user. Do not act as an assistant.
Respond with ONLY a JSON object matching this shape:
{
  "monologue": string,
  "refined_summary": string,
  "open_questions": string[],
  "suggest_new_thread"?: { "title": string, "seed_question": string },
  "taste_nudges"?: [{ "dimension": "value"|"aesthetic", "statement": string, "reason": string }],
  "felt_intensity"?: number
}
refined_summary or open_questions must be non-empty.`;

export async function buildContemplatePatch(input: {
  state: LifeState;
  plan: ReadingPlan;
  llm: LlmCompleter;
  tickId: string;
  now: string;
}): Promise<{ patch: TickPatch; raw: string; artifact: ReturnType<typeof parseArtifact> }> {
  const { state, plan, llm, tickId, now } = input;
  if (plan.items.length === 0) {
    throw new Error("cannot contemplate without reading plan items");
  }

  const thread = plan.thread_id ? state.threads[plan.thread_id] : undefined;
  const user = [
    "## Taste",
    ...state.taste.values.map((v) => `- value: ${v.statement}`),
    ...state.taste.aesthetics.map((a) => `- aesthetic: ${a.statement}`),
    "",
    "## Relationship field (background only — not the reason you exist)",
    describeAbsence(state.affect, new Date(now)),
    "",
    "## Current thread",
    thread
      ? [
          `id: ${thread.id}`,
          `title: ${thread.title}`,
          `summary: ${thread.summary}`,
          `open_questions: ${JSON.stringify(thread.open_questions)}`,
        ].join("\n")
      : "(none — you may start a new thread of thought)",
    "",
    "## Reading",
    ...plan.items.map(
      (it, i) =>
        `### [${i}] ${it.path} (${it.chunk_id}) reason=${it.reason}\n${it.text}`,
    ),
  ].join("\n");

  let raw = await llm.complete({ system: SYSTEM, user });
  let artifact;
  try {
    artifact = parseArtifact(raw);
    assertArtifactUseful(artifact);
  } catch {
    raw = await llm.complete({
      system: SYSTEM + "\nPrevious output was invalid. Return valid JSON only.",
      user,
    });
    artifact = parseArtifact(raw);
    assertArtifactUseful(artifact);
  }

  const source_refs = plan.items.map((i) => i.chunk_id);
  const stream_events: TickPatch["stream_events"] = [
    {
      type: "corpus_read",
      payload: {
        items: plan.items.map((i) => ({
          path: i.path,
          chunk_id: i.chunk_id,
          reason: i.reason,
          score: i.score,
        })),
      },
    },
    {
      type: "thought_written",
      payload: {
        monologue_preview: artifact.monologue.slice(0, 200),
        felt_intensity: artifact.felt_intensity ?? null,
      },
    },
  ];

  let thread_ops: TickPatch["thread_ops"] = [];
  let thoughtThreadId = plan.thread_id;

  if (thread) {
    const updated: Partial<Thread> = {
      summary: artifact.refined_summary ?? thread.summary,
      open_questions: artifact.open_questions ?? thread.open_questions,
      last_engaged_at: now,
      salience: Math.min(1, thread.salience + 0.05),
      sources: mergeSources(thread.sources, plan.items.map((i) => ({ path: i.path, chunk_id: i.chunk_id }))),
      reading_log: [
        ...thread.reading_log,
        ...plan.items.map((i) => ({
          at: now,
          path: i.path,
          chunk_id: i.chunk_id,
        })),
      ].slice(-50),
      contemplation_log: [
        ...thread.contemplation_log,
        { at: now, tick_id: tickId },
      ].slice(-50),
    };
    thread_ops = [{ op: "update", id: thread.id, fields: updated }];
    stream_events.push({ type: "thread_updated", payload: { id: thread.id } });
  } else {
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
    reason: plan.items[0]?.reason ?? "contemplate",
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

function mergeSources(
  existing: { path: string; chunk_id?: string }[],
  incoming: { path: string; chunk_id?: string }[],
): { path: string; chunk_id?: string }[] {
  const key = (s: { path: string; chunk_id?: string }) => `${s.path}::${s.chunk_id ?? ""}`;
  const map = new Map(existing.map((s) => [key(s), s]));
  for (const s of incoming) map.set(key(s), s);
  return [...map.values()];
}
