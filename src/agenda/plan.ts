import { randomUUID } from "node:crypto";
import type { CorpusIndex } from "../corpus/index.js";
import { lacksChinese, ZH_OUTPUT_RULE } from "../locale.js";
import type { LlmCompleter } from "../llm/types.js";
import { formatClockForPrompt } from "../time/clock.js";
import type {
  Agenda,
  Config,
  Intent,
  IntentKind,
  LifeState,
  RelationState,
} from "../types.js";
import { defaultAgenda } from "../types.js";
import { formatDeferredForPlanPrompt } from "./deferred.js";
import { agendaConfig } from "./schedule.js";

const PLAN_SYSTEM = `你是 Oren，正在做「规划」回合——独处的核心：先决定接下来干什么。
不是现场聊天；但你可以在计划里安排「稍后主动找用户说一句」。

${ZH_OUTPUT_RULE}

意图 kind：
- read：读本地未读/值得打开的语料（path 必须来自书架 path）
- think：纯想某条线索/开放问题（不打开新文件）
- organize：整理记忆与线索
- seek：以后想查询/外读（当前无权限，仍可写入计划但会 blocked）
- say：主动找用户聊一两句（会进入对话记录；由你决定要不要排）
- idle：刻意休息

关于 say（重要）：
- 可选，不是每份计划都必须有；多数时候可以不排
- 只有当你真的想说点什么时才加：例如独处里冒出一个值得分享的念头、想轻轻关心对方、或太久没联系想打个招呼
- 每份计划最多 1 条 say；不要连续塞多条
- 无实质内容、纯为了「显得有存在感」、刚聊过不久 → 不要排 say
- 系统若提示 can_say=false，则禁止安排 say
- say 的 title 用中文说明动机；hints.why 写为何值得开口

规则：
- 3–7 项，有序（第一项先做）
- title、planning_note、hints.why/query/open_questions 一律中文白话
- 禁止编造书架上没有的书名或 path
- read.hints.paths 若填写必须是书架 path 子集
- 不要全是 idle；有材料就安排 read/think/organize
- planning_note：2–4 句中文，说明为何这样排（若含 say，写清为什么要开口）

只返回 JSON：
{
  "planning_note": string,
  "intents": [
    {
      "kind": "read"|"think"|"organize"|"seek"|"say"|"idle",
      "title": string,
      "priority"?: number,
      "thread_id"?: string,
      "hints"?: { "paths"?: string[], "query"?: string, "open_questions"?: string[], "why"?: string }
    }
  ]
}
}`;

export async function buildAgendaPlan(input: {
  state: LifeState;
  index: CorpusIndex;
  llm: LlmCompleter;
  now: string;
  relation?: RelationState | null;
  previous?: Agenda | null;
  unreadPaths: string[];
  canSeek: boolean;
  /** Whether proactive say is allowed this plan (cooldown + config). */
  canSay?: boolean;
  /** Short recent dialogue for deciding whether to reach out. */
  dialogueSummary?: string;
  lastProactiveSayAt?: string | null;
}): Promise<{ agenda: Agenda; raw: string }> {
  const agCfg = agendaConfig(input.state.config);
  const user = buildPlanUserPrompt(input, agCfg);
  let raw = await input.llm.complete({ system: PLAN_SYSTEM, user });
  let parsed: ReturnType<typeof parsePlanArtifact>;
  try {
    parsed = parsePlanArtifact(raw);
  } catch {
    raw = await input.llm.complete({
      system: PLAN_SYSTEM + "\n上次输出无效。只返回 JSON。",
      user,
    });
    parsed = parsePlanArtifact(raw);
  }

  if (planNeedsChineseRepair(parsed)) {
    raw = await input.llm.complete({
      system:
        PLAN_SYSTEM +
        "\n重写模式：上一版标题/说明含过多英文。必须全部改为简体中文短句，path 文件名可保留英文。只返回 JSON。",
      user:
        user +
        "\n\n## 需要改成中文的上一版\n" +
        JSON.stringify(parsed, null, 2),
    });
    try {
      parsed = parsePlanArtifact(raw);
    } catch {
      /* keep previous parsed */
    }
  }

  let agenda = materializeAgenda({
    parsed,
    now: input.now,
    config: input.state.config,
    state: input.state,
    unreadPaths: input.unreadPaths,
    allowSeek: agCfg.allow_seek_in_plan,
    canSeek: input.canSeek,
    canSay: input.canSay !== false,
  });
  // Keep calendar deferred cares across replan (they live outside queue).
  agenda = preserveDeferredIntents(agenda, input.previous ?? null);

  return { agenda, raw };
}

/** Carry deferred (and not-yet-queued) calendar cares into a fresh plan. */
export function preserveDeferredIntents(
  next: Agenda,
  previous: Agenda | null,
): Agenda {
  if (!previous) return next;
  const intents = { ...next.intents };
  for (const [id, it] of Object.entries(previous.intents)) {
    if (it.status !== "deferred") continue;
    if (intents[id]) continue;
    intents[id] = it;
  }
  return { ...next, intents };
}

function planNeedsChineseRepair(parsed: {
  planning_note: string;
  intents: { title: string }[];
}): boolean {
  if (lacksChinese(parsed.planning_note)) return true;
  if (parsed.intents.length === 0) return true;
  const zhTitles = parsed.intents.filter((i) => !lacksChinese(i.title)).length;
  return zhTitles < Math.ceil(parsed.intents.length * 0.6);
}

export function parsePlanArtifact(raw: string): {
  planning_note: string;
  intents: {
    kind: IntentKind;
    title: string;
    priority?: number;
    thread_id?: string;
    hints?: Intent["hints"];
  }[];
} {
  const text = stripFences(raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) data = JSON.parse(text.slice(start, end + 1));
    else throw new Error("plan artifact not JSON");
  }
  if (!data || typeof data !== "object") throw new Error("plan root");
  const obj = data as Record<string, unknown>;
  const note =
    typeof obj.planning_note === "string" ? obj.planning_note.trim() : "本段独处计划。";
  const arr = Array.isArray(obj.intents) ? obj.intents : [];
  const intents = [];
  for (const item of arr.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const kind = normalizeKind(o.kind);
    if (!kind) continue;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 160) : "";
    if (!title) continue;
    const hints =
      o.hints && typeof o.hints === "object"
        ? {
            paths: Array.isArray((o.hints as { paths?: unknown }).paths)
              ? ((o.hints as { paths: unknown[] }).paths.filter(
                  (p) => typeof p === "string",
                ) as string[])
              : undefined,
            query:
              typeof (o.hints as { query?: unknown }).query === "string"
                ? String((o.hints as { query: string }).query).slice(0, 200)
                : undefined,
            open_questions: Array.isArray((o.hints as { open_questions?: unknown }).open_questions)
              ? ((o.hints as { open_questions: unknown[] }).open_questions.filter(
                  (q) => typeof q === "string",
                ) as string[]).slice(0, 5)
              : undefined,
            why:
              typeof (o.hints as { why?: unknown }).why === "string"
                ? String((o.hints as { why: string }).why).slice(0, 240)
                : undefined,
          }
        : undefined;
    intents.push({
      kind,
      title,
      priority: typeof o.priority === "number" ? o.priority : undefined,
      thread_id: typeof o.thread_id === "string" ? o.thread_id : undefined,
      hints,
    });
  }
  if (intents.length === 0) throw new Error("plan has no intents");
  return { planning_note: note, intents };
}

export function materializeAgenda(input: {
  parsed: ReturnType<typeof parsePlanArtifact>;
  now: string;
  config: Config;
  state: LifeState;
  unreadPaths: string[];
  allowSeek: boolean;
  canSeek: boolean;
  /** Drop say intents when false (cooldown / disabled). Default true. */
  canSay?: boolean;
}): Agenda {
  const agCfg = agendaConfig(input.config);
  const shelf = new Set(input.unreadPaths.map((p) => p.replace(/\\/g, "/")));
  // also allow any known corpus path from threads sources
  for (const t of Object.values(input.state.threads)) {
    for (const s of t.sources) shelf.add(s.path);
  }

  const base = defaultAgenda(input.now);
  base.id = `ag_${randomUUID().slice(0, 8)}`;
  base.planning_note = input.parsed.planning_note;
  base.actions_since_plan = 0;

  const intents: Record<string, Intent> = {};
  const queue: string[] = [];
  const max = agCfg.max_intents;
  const min = agCfg.min_intents;
  let sayCount = 0;
  const allowSay = input.canSay !== false && agCfg.allow_say_in_plan !== false;

  for (const raw of input.parsed.intents) {
    if (queue.length >= max) break;
    if (raw.kind === "seek" && !input.allowSeek) continue;
    if (raw.kind === "say") {
      if (!allowSay) continue;
      if (sayCount >= 1) continue; // at most one say per plan
      sayCount += 1;
    }

    const id = `in_${randomUUID().slice(0, 8)}`;
    let status: Intent["status"] = "pending";
    let blocked_reason: string | undefined;
    const hints = { ...raw.hints };

    if (raw.kind === "seek" && !input.canSeek) {
      status = "blocked";
      blocked_reason = "seek_not_authorized";
    }
    if (raw.kind === "read" && hints.paths?.length) {
      hints.paths = hints.paths.filter((p) => shelf.has(p) || [...shelf].some((s) => s.endsWith(p)));
      if (hints.paths.length === 0) delete hints.paths;
    }
    // invalid thread ids dropped
    const thread_id =
      raw.thread_id && input.state.threads[raw.thread_id] ? raw.thread_id : undefined;

    const intent: Intent = {
      id,
      kind: raw.kind,
      title: raw.title,
      status,
      priority: typeof raw.priority === "number" ? raw.priority : 1 - queue.length * 0.05,
      created_at: input.now,
      source: "plan",
      thread_id,
      hints: Object.keys(hints).length ? hints : undefined,
      blocked_reason,
    };
    intents[id] = intent;
    queue.push(id);
  }

  // Ensure minimum via rule fallback
  if (queue.length < min) {
    for (const fb of ruleFallbackIntents(input.state, input.unreadPaths, input.now, min - queue.length)) {
      if (queue.length >= max) break;
      intents[fb.id] = fb;
      queue.push(fb.id);
    }
  }

  base.intents = intents;
  base.queue = queue;
  base.updated_at = input.now;
  return base;
}

/** Rule fallback when LLM plan is thin. */
export function ruleFallbackIntents(
  state: LifeState,
  unreadPaths: string[],
  now: string,
  n: number,
): Intent[] {
  const out: Intent[] = [];
  const active = Object.values(state.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience);
  const top = active[0];
  if (top && out.length < n) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "think",
      title: `接着想：${top.title}`,
      status: "pending",
      priority: 0.9,
      created_at: now,
      source: "system",
      thread_id: top.id,
      hints: { open_questions: top.open_questions.slice(0, 3), why: "规则兜底" },
    });
  }
  if (unreadPaths[0] && out.length < n) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "read",
      title: `读未读材料：${unreadPaths[0]}`,
      status: "pending",
      priority: 0.8,
      created_at: now,
      source: "system",
      hints: { paths: [unreadPaths[0]], why: "有未读语料" },
    });
  }
  if (active.length > 3 && out.length < n) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "organize",
      title: "整理当前活跃线索",
      status: "pending",
      priority: 0.6,
      created_at: now,
      source: "system",
    });
  }
  while (out.length < n) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "idle",
      title: "刻意休息，不强行做事",
      status: "pending",
      priority: 0.2,
      created_at: now,
      source: "system",
    });
  }
  return out;
}

function buildPlanUserPrompt(
  input: {
    state: LifeState;
    index: CorpusIndex;
    unreadPaths: string[];
    relation?: RelationState | null;
    previous?: Agenda | null;
    canSeek: boolean;
    canSay?: boolean;
    dialogueSummary?: string;
    lastProactiveSayAt?: string | null;
  },
  agCfg: ReturnType<typeof agendaConfig>,
): string {
  const threads = Object.values(input.state.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 8)
    .map(
      (t) =>
        `- id=${t.id} sal=${t.salience.toFixed(2)} title="${t.title}" open=${JSON.stringify(t.open_questions).slice(0, 120)}`,
    )
    .join("\n");

  const shelf = input.index.docs.map((d) => d.path).join(", ") || "(empty)";
  const unread = input.unreadPaths.slice(0, 20).join(", ") || "(none unread)";
  const prev =
    input.previous && input.previous.queue.length
      ? input.previous.queue
          .map((id) => input.previous!.intents[id])
          .filter(Boolean)
          .map((i) => `${i!.status}:${i!.kind}:${i!.title}`)
          .join("\n")
      : "(none)";

  const lastContact = input.state.affect.absence.last_user_contact_at;
  const canSay = input.canSay !== false && agCfg.allow_say_in_plan !== false;
  const sayGate = canSay
    ? "can_say=true（若你真有话想说，可排最多 1 条 say；不想说就不要排）"
    : "can_say=false（冷却中或已关闭；禁止安排 say）";

  return [
    `## 约束: min=${agCfg.min_intents} max=${agCfg.max_intents} 本段独处`,
    `can_seek_execute=${input.canSeek}（false 时 seek 会 blocked）`,
    sayGate,
    "",
    "## 当前时间",
    formatClockForPrompt(new Date()),
    "",
    "## 与用户的联系",
    `上次用户联系：${lastContact ?? "（尚无记录）"}`,
    `上次主动找用户说：${input.lastProactiveSayAt ?? "（尚无）"}`,
    `访问次数：${input.state.affect.absence.visit_count ?? 0}`,
    "",
    "## 最近对话摘要（决定是否 say 时参考）",
    input.dialogueSummary?.trim() || "（暂无对话）",
    "",
    "## 品味",
    ...input.state.taste.values.map((v) => `- ${v.statement}`),
    "",
    "## 活跃线索",
    threads || "(none)",
    "",
    "## 本地书架路径",
    shelf,
    "## 未读路径（read 优先）",
    unread,
    "",
    "## 上一份计划残留",
    prev,
    "",
    "## 日历关心项（未到期不要强行执行；已到会由系统自动进待办）",
    formatDeferredForPlanPrompt(input.previous ?? defaultAgenda(new Date().toISOString()), new Date()),
    "",
    "请输出 JSON 计划表。不要编造用户没说过的日程。say 完全可选。",
  ].join("\n");
}

function normalizeKind(raw: unknown): IntentKind | null {
  if (typeof raw !== "string") return null;
  const k = raw.toLowerCase().trim();
  if (
    k === "read" ||
    k === "think" ||
    k === "organize" ||
    k === "seek" ||
    k === "idle" ||
    k === "say" ||
    k === "chat" ||
    k === "talk" ||
    k === "reach"
  ) {
    if (k === "chat" || k === "talk" || k === "reach") return "say";
    return k as IntentKind;
  }
  return null;
}

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1];
  return raw;
}
