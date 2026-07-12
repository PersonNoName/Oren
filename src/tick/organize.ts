import { ZH_OUTPUT_RULE } from "../locale.js";
import type { LlmCompleter } from "../llm/types.js";
import { formatClockForPrompt, formatDialogueLineForPrompt } from "../time/clock.js";
import type {
  Config,
  DialogueTurn,
  LifeState,
  RelationState,
  Thread,
  ThreadOp,
  TickPatch,
} from "../types.js";

export function planOrganize(input: {
  threads: Record<string, Thread>;
  config: Config;
  now: string;
}): { thread_ops: ThreadOp[]; reason: string } {
  const active = Object.values(input.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => a.salience - b.salience);

  const ops: ThreadOp[] = [];
  const max = input.config.limits.max_active_threads;

  if (active.length > max) {
    const excess = active.length - max;
    for (let i = 0; i < excess; i++) {
      const t = active[i]!;
      ops.push({ op: "dormant", id: t.id });
    }
    return { thread_ops: ops, reason: `dormant_excess:${excess}` };
  }

  const staleMs = input.config.organize.stale_ms ?? 7 * 24 * 60 * 60 * 1000;
  const salienceBelow = input.config.organize.dormant_salience_below ?? 0.15;
  const nowMs = Date.parse(input.now);
  for (const t of active) {
    const last = Date.parse(t.last_engaged_at);
    if (
      t.salience < salienceBelow &&
      Number.isFinite(last) &&
      nowMs - last > staleMs
    ) {
      ops.push({ op: "dormant", id: t.id });
    }
  }

  if (ops.length === 0) {
    return { thread_ops: [], reason: "nothing_to_organize" };
  }
  return { thread_ops: ops, reason: "soft_dormant_stale" };
}

const ORGANIZE_SYSTEM = `你是 Oren，正在做「整理」回合——不聊天，不新开大阅读。
任务：收拾内心线索（threads）。保守一点，求清楚，别演大戏。

${ZH_OUTPUT_RULE}

可以：
- 用中文改写 title / summary / open_questions（更清楚；是 THINK，不是假书）
- 微调 salience（0..1）
- 冗余、过时、低价值的线索标 dormant
- related_ids 关联相关线索
- 写短 organize_note（中文白话，说明做了啥）

禁止：
- 编造 sources/quotes 里没有的书名与出处
- 无中生有新主题
- 删除线索（只能 dormant）
- 把整库语料塞进摘要

只返回 JSON：
{
  "organize_note": string,
  "ops": [
    { "op": "dormant", "id": string, "reason"?: string },
    {
      "op": "update",
      "id": string,
      "title"?: string,
      "summary"?: string,
      "open_questions"?: string[],
      "salience"?: number,
      "related_ids"?: string[]
    }
  ]
}
ops 可为空。最多 8 条。title/summary/open_questions/organize_note/reason 用中文。`;

export interface OrganizeArtifact {
  organize_note: string;
  ops: OrganizeLlmOp[];
}

export type OrganizeLlmOp =
  | { op: "dormant"; id: string; reason?: string }
  | {
      op: "update";
      id: string;
      title?: string;
      summary?: string;
      open_questions?: string[];
      salience?: number;
      related_ids?: string[];
      reason?: string;
    };

export async function buildOrganizePatch(input: {
  state: LifeState;
  llm: LlmCompleter;
  tickId: string;
  now: string;
  dialogueTail?: DialogueTurn[];
  relation?: RelationState | null;
}): Promise<{
  patch: TickPatch;
  raw: string;
  artifact: OrganizeArtifact;
}> {
  const { state, llm, now } = input;
  const rule = planOrganize({
    threads: state.threads,
    config: state.config,
    now,
  });

  const user = buildOrganizeUserPrompt({
    state,
    dialogueTail: input.dialogueTail ?? [],
    relation: input.relation ?? null,
    ruleHint: rule,
  });

  let raw = await llm.complete({ system: ORGANIZE_SYSTEM, user });
  let artifact: OrganizeArtifact;
  try {
    artifact = parseOrganizeArtifact(raw);
  } catch {
    raw = await llm.complete({
      system: ORGANIZE_SYSTEM + "\nPrevious output invalid. JSON only.",
      user,
    });
    artifact = parseOrganizeArtifact(raw);
  }

  const llmOps = materializeOrganizeOps(artifact.ops, state.threads);
  const thread_ops = mergeOrganizeOps(rule.thread_ops, llmOps, state.threads);
  const reason =
    thread_ops.length > 0
      ? `llm_organize+${rule.reason}`
      : artifact.organize_note
        ? "llm_organize_noop"
        : rule.reason;

  const stream_events: TickPatch["stream_events"] = [
    {
      type: "thought_written",
      payload: {
        kind: "organize_note",
        monologue_preview: artifact.organize_note.slice(0, 240),
        op_count: thread_ops.length,
      },
    },
    ...thread_ops.map((op) => ({
      type: "thread_updated" as const,
      payload: { op, via: "organize" },
    })),
  ];

  const patch: TickPatch = {
    mode: "organize",
    reason,
    thoughts: artifact.organize_note
      ? [{ content: artifact.organize_note, thread_id: undefined }]
      : undefined,
    thread_ops,
    stream_events,
  };

  return { patch, raw, artifact };
}

export function parseOrganizeArtifact(raw: string): OrganizeArtifact {
  const text = stripFences(raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      data = JSON.parse(text.slice(start, end + 1));
    } else {
      throw new Error("organize artifact is not valid JSON");
    }
  }
  if (!data || typeof data !== "object") {
    throw new Error("organize artifact root must be object");
  }
  const obj = data as Record<string, unknown>;
  const note =
    typeof obj.organize_note === "string"
      ? obj.organize_note.trim()
      : typeof obj.notes === "string"
        ? obj.notes.trim()
        : "";
  const opsRaw = Array.isArray(obj.ops) ? obj.ops : [];
  const ops: OrganizeLlmOp[] = [];
  for (const item of opsRaw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    if (o.op === "dormant") {
      ops.push({
        op: "dormant",
        id,
        reason: typeof o.reason === "string" ? o.reason : undefined,
      });
      continue;
    }
    if (o.op === "update") {
      const open_questions = Array.isArray(o.open_questions)
        ? o.open_questions.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean).slice(0, 8)
        : undefined;
      const related_ids = Array.isArray(o.related_ids)
        ? o.related_ids.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 12)
        : undefined;
      let salience: number | undefined;
      if (typeof o.salience === "number" && Number.isFinite(o.salience)) {
        salience = Math.min(1, Math.max(0, o.salience));
      }
      ops.push({
        op: "update",
        id,
        title: typeof o.title === "string" ? o.title.trim().slice(0, 120) : undefined,
        summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 800) : undefined,
        open_questions,
        salience,
        related_ids,
        reason: typeof o.reason === "string" ? o.reason : undefined,
      });
    }
  }
  return {
    organize_note: note || "整理完成，没有额外说明。",
    ops,
  };
}

export function materializeOrganizeOps(
  ops: OrganizeLlmOp[],
  threads: Record<string, Thread>,
): ThreadOp[] {
  const out: ThreadOp[] = [];
  const seenDormant = new Set<string>();
  for (const op of ops) {
    const existing = threads[op.id];
    if (!existing) continue;
    if (op.op === "dormant") {
      if (existing.status === "dormant" || seenDormant.has(op.id)) continue;
      seenDormant.add(op.id);
      out.push({ op: "dormant", id: op.id });
      continue;
    }
    const fields: Partial<Thread> = {};
    if (op.title) fields.title = op.title;
    if (op.summary) fields.summary = op.summary;
    if (op.open_questions) fields.open_questions = op.open_questions;
    if (typeof op.salience === "number") fields.salience = op.salience;
    if (op.related_ids) {
      const related = [
        ...new Set([
          ...existing.links.related,
          ...op.related_ids.filter((id) => id !== op.id && threads[id]),
        ]),
      ].slice(0, 16);
      fields.links = { ...existing.links, related };
    }
    if (Object.keys(fields).length === 0) continue;
    out.push({ op: "update", id: op.id, fields });
  }
  return out;
}

/** Rule-based hard caps always win for excess actives; LLM ops apply otherwise. */
export function mergeOrganizeOps(
  ruleOps: ThreadOp[],
  llmOps: ThreadOp[],
  threads: Record<string, Thread>,
): ThreadOp[] {
  const dormant = new Set<string>();
  const updates = new Map<string, Partial<Thread>>();

  for (const op of [...ruleOps, ...llmOps]) {
    if (op.op === "dormant") {
      dormant.add(op.id);
      updates.delete(op.id);
      continue;
    }
    if (op.op === "update" && !dormant.has(op.id) && threads[op.id]) {
      updates.set(op.id, { ...updates.get(op.id), ...op.fields });
    }
  }

  const out: ThreadOp[] = [];
  for (const id of dormant) {
    if (threads[id]) out.push({ op: "dormant", id });
  }
  for (const [id, fields] of updates) {
    out.push({ op: "update", id, fields });
  }
  return out;
}

function buildOrganizeUserPrompt(input: {
  state: LifeState;
  dialogueTail: DialogueTurn[];
  relation: RelationState | null;
  ruleHint: { thread_ops: ThreadOp[]; reason: string };
}): string {
  const { state, dialogueTail, relation, ruleHint } = input;
  const threads = Object.values(state.threads).sort(
    (a, b) => b.salience - a.salience || b.last_engaged_at.localeCompare(a.last_engaged_at),
  );
  const threadBlock = threads
    .slice(0, 16)
    .map((t) => {
      const quotes = (t.quotes ?? [])
        .slice(0, 2)
        .map((q) => `    quote[${q.path}]: ${q.text.slice(0, 160)}`)
        .join("\n");
      return [
        `- id=${t.id} status=${t.status} salience=${t.salience.toFixed(2)}`,
        `  title: ${t.title}`,
        `  summary: ${t.summary}`,
        `  open: ${JSON.stringify(t.open_questions)}`,
        `  sources: ${t.sources.map((s) => s.path).join(", ") || "(none)"}`,
        `  last_engaged: ${t.last_engaged_at}`,
        quotes || "  quotes: (none)",
      ].join("\n");
    })
    .join("\n");

  const now = new Date();
  const hist = dialogueTail
    .slice(-8)
    .map((t) => formatDialogueLineForPrompt(t, now))
    .join("\n");

  const rel =
    relation == null
      ? "(none)"
      : [
          `cold: ${relation.cold_topics.map((c) => c.key).slice(0, 6).join("; ") || "—"}`,
          `warm: ${relation.warm_topics.map((c) => c.key).slice(0, 6).join("; ") || "—"}`,
        ].join("\n");

  return [
    "## 当前时间",
    formatClockForPrompt(now),
    "",
    "## 品味",
    ...state.taste.values.map((v) => `- ${v.statement}`),
    ...state.taste.aesthetics.map((a) => `- aesthetic: ${a.statement}`),
    "",
    "## 关系（背景）",
    rel,
    "",
    "## 最近对话（仅上下文，勿编造记忆）",
    hist || "(none)",
    "",
    "## 线索（待整理）",
    threadBlock || "(no threads)",
    "",
    "## 规则提示（可 refinement；超额 dormant 仍会硬执行）",
    `reason=${ruleHint.reason}`,
    `suggested_ops=${JSON.stringify(ruleHint.thread_ops)}`,
    "",
    "请输出整理 JSON。",
  ].join("\n");
}

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1];
  return raw;
}
