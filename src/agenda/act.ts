import { randomUUID } from "node:crypto";
import type { CorpusIndex } from "../corpus/index.js";
import { planReading } from "../corpus/retrieve.js";
import { appendDialogue } from "../dialogue/store.js";
import type { LlmCompleter } from "../llm/types.js";
import type { LifeStore } from "../store/life-store.js";
import type {
  Agenda,
  DialogueShare,
  DialogueTurn,
  Intent,
  IntentKind,
  LifeState,
  Mode,
  RelationState,
  TickPatch,
} from "../types.js";
import { buildContemplatePatch } from "../tick/contemplate.js";
import { buildOrganizePatch, planOrganize } from "../tick/organize.js";
import { agendaConfig, canPlanSay } from "./schedule.js";
import { appendIntents } from "./store.js";

export interface ActResult {
  mode: Mode;
  patch: TickPatch;
  agenda: Agenda;
  readingPlan: ReturnType<typeof planReading> | null;
  rawModel: string | null;
  artifact: unknown;
  intent: Intent;
}

/**
 * Execute one intent. New ideas only append to queue tail (product lock 3A).
 */
export async function actOnIntent(input: {
  intent: Intent;
  agenda: Agenda;
  state: LifeState;
  index: CorpusIndex;
  llm: LlmCompleter;
  tickId: string;
  now: string;
  dialogueTail?: DialogueTurn[];
  relation?: RelationState | null;
  /** Live model for organize when needed */
  organizeLlm?: LlmCompleter;
  /** Required for say: writes proactive dialogue turns. */
  store?: LifeStore;
}): Promise<ActResult> {
  const { intent, state, index, llm, tickId, now } = input;
  let agenda = {
    ...input.agenda,
    intents: { ...input.agenda.intents },
    queue: [...input.agenda.queue],
  };

  // Mark active
  const working: Intent = {
    ...intent,
    status: intent.kind === "seek" ? "blocked" : "active",
  };
  agenda.intents[working.id] = working;

  if (working.kind === "seek") {
    const q =
      working.hints?.query?.trim() ||
      working.hints?.open_questions?.[0]?.trim() ||
      working.title;
    const why = working.hints?.why?.trim();
    const wish = why ? `记下想查：${q}（${why}）` : `记下想查：${q}`;
    const done: Intent = {
      ...working,
      status: "blocked",
      blocked_reason: working.blocked_reason ?? "seek_not_authorized",
      outcome: {
        at: now,
        summary: `${wish}。外面还查不了，愿望先留着。`,
      },
    };
    agenda.intents[done.id] = done;
    agenda.actions_since_plan += 1;
    agenda.updated_at = now;
    return {
      mode: "idle",
      patch: {
        mode: "idle",
        reason: `act:seek_wished:${done.id}`,
        stream_events: [
          {
            type: "seek_wished",
            payload: {
              intent_id: done.id,
              query: done.hints?.query ?? q,
              why: why ?? null,
              summary: done.outcome?.summary,
            },
          },
        ],
      },
      agenda,
      readingPlan: null,
      rawModel: null,
      artifact: { intent: done, seek_wish: true },
      intent: done,
    };
  }

  if (working.kind === "idle") {
    const done = finishIntent(working, now, "按计划刻意休息。", []);
    agenda = commitDone(agenda, done, now);
    return {
      mode: "idle",
      patch: {
        mode: "idle",
        reason: `act:idle:${done.id}`,
        stream_events: [
          {
            type: "presence_blank",
            payload: { note: "planned_idle", intent_id: done.id },
          },
        ],
      },
      agenda,
      readingPlan: null,
      rawModel: null,
      artifact: { intent: done },
      intent: done,
    };
  }

  if (working.kind === "say") {
    return actProactiveSay({
      working,
      agenda,
      state,
      llm,
      tickId,
      now,
      dialogueTail: input.dialogueTail ?? [],
      relation: input.relation,
      store: input.store,
    });
  }

  if (working.kind === "organize") {
    const orgLlm = input.organizeLlm ?? llm;
    if (state.config.organize.use_llm) {
      const built = await buildOrganizePatch({
        state,
        llm: orgLlm,
        tickId,
        now,
        dialogueTail: input.dialogueTail,
        relation: input.relation,
      });
      const spawned = extractSpawnedFromNote(built.artifact.organize_note, now);
      const done = finishIntent(
        working,
        now,
        built.artifact.organize_note.slice(0, 280),
        spawned.map((s) => s.id),
      );
      agenda = commitDone(agenda, done, now);
      agenda = appendIntents(agenda, spawned, now, agendaConfig(state.config).max_intents);
      return {
        mode: "organize",
        patch: {
          ...built.patch,
          reason: `act:organize:${done.id}|${built.patch.reason}`,
          stream_events: [
            ...built.patch.stream_events,
            {
              type: "thread_updated",
              payload: { via: "agenda_act", intent_id: done.id },
            },
          ],
        },
        agenda,
        readingPlan: null,
        rawModel: built.raw,
        artifact: { organize: built.artifact, intent: done },
        intent: done,
      };
    }
    const org = planOrganize({ threads: state.threads, config: state.config, now });
    const done = finishIntent(working, now, org.reason, []);
    agenda = commitDone(agenda, done, now);
    return {
      mode: "organize",
      patch: {
        mode: "organize",
        reason: `act:organize:${done.id}|${org.reason}`,
        thread_ops: org.thread_ops,
        stream_events: org.thread_ops.map((op) => ({
          type: "thread_updated",
          payload: { op, intent_id: done.id },
        })),
      },
      agenda,
      readingPlan: null,
      rawModel: null,
      artifact: { intent: done },
      intent: done,
    };
  }

  // Calendar care: gentle check-in (not full corpus contemplate).
  if (isCareIntent(working)) {
    return actCareCheckIn({
      working,
      agenda,
      state,
      llm,
      tickId,
      now,
    });
  }

  // read | think → contemplate path
  let readingPlan = planReading({
    index,
    taste: state.taste,
    threads: state.threads,
    config: state.config,
    contemplateOrdinal: 1,
  });

  if (working.kind === "think") {
    const noteMode = working.hints?.mode === "note";
    readingPlan = {
      items: [],
      thread_id: working.thread_id ?? readingPlan.thread_id,
      kind: "think",
      intent: noteMode
        ? `agenda_think_note:${working.id}`
        : `agenda_think:${working.id}`,
    };
  } else if (working.kind === "read") {
    // Prefer unread; if plan is think (shelf exhausted), keep think honestly
    if (working.thread_id) {
      readingPlan = { ...readingPlan, thread_id: working.thread_id };
    }
    if (working.hints?.paths?.length && readingPlan.items.length > 0) {
      const prefer = new Set(working.hints.paths);
      const filtered = readingPlan.items.filter((i) => prefer.has(i.path));
      if (filtered.length > 0) {
        readingPlan = {
          ...readingPlan,
          items: filtered,
          intent: `agenda_read:${working.id}`,
        };
      }
    }
    if (readingPlan.kind === "think" || readingPlan.items.length === 0) {
      readingPlan = {
        items: [],
        thread_id: working.thread_id ?? readingPlan.thread_id,
        kind: "think",
        intent: `agenda_read_degraded_think:${working.id}`,
      };
    } else {
      readingPlan = { ...readingPlan, intent: `agenda_read:${working.id}` };
    }
  }

  const built = await buildContemplatePatch({
    state,
    plan: readingPlan,
    llm,
    tickId,
    now,
    focusQuestions: working.hints?.open_questions,
    noteMode: working.kind === "think" && working.hints?.mode === "note",
    why: working.hints?.why,
  });

  const spawned = spawnFromArtifact(built.artifact, now, working);
  const summary =
    built.artifact.monologue?.slice(0, 200) ||
    built.artifact.refined_summary?.slice(0, 200) ||
    working.title;
  const done = finishIntent(
    working,
    now,
    summary,
    spawned.map((s) => s.id),
  );
  agenda = commitDone(agenda, done, now);
  agenda = appendIntents(agenda, spawned, now, agendaConfig(state.config).max_intents);

  const thoughtKind =
    working.kind === "think" && working.hints?.mode === "note"
      ? "note"
      : working.kind;

  return {
    mode: "contemplate",
    patch: {
      ...built.patch,
      reason: `act:${working.kind}:${done.id}|${built.patch.reason}`,
      stream_events: [
        ...built.patch.stream_events,
        {
          type: "thought_written",
          payload: {
            via: "agenda_act",
            intent_id: done.id,
            kind: thoughtKind,
          },
        },
      ],
    },
    agenda,
    readingPlan,
    rawModel: built.raw,
    artifact: { contemplate: built.artifact, intent: done },
    intent: done,
  };
}

function finishIntent(
  intent: Intent,
  now: string,
  summary: string,
  spawned: string[],
): Intent {
  return {
    ...intent,
    status: intent.status === "blocked" ? "blocked" : "done",
    outcome: {
      at: now,
      summary,
      spawned_intent_ids: spawned.length ? spawned : undefined,
    },
  };
}

/** Last time Oren proactively messaged (dialogue.proactive or done say intent). */
export function lastProactiveSayAt(
  dialogue: DialogueTurn[],
  agenda?: Agenda | null,
): string | null {
  let best: string | null = null;
  for (const t of dialogue) {
    if (t.role === "oren" && t.proactive && t.ts) {
      if (!best || t.ts > best) best = t.ts;
    }
  }
  if (agenda) {
    for (const it of Object.values(agenda.intents)) {
      if (it.kind === "say" && it.status === "done" && it.outcome?.at) {
        if (!best || it.outcome.at > best) best = it.outcome.at;
      }
    }
  }
  return best;
}

export function summarizeDialogueForPlan(dialogue: DialogueTurn[], max = 8): string {
  const tail = dialogue.slice(-max);
  if (tail.length === 0) return "";
  return tail
    .map((t) => {
      const who = t.role === "user" ? "用户" : t.proactive ? "Oren(主动)" : "Oren";
      return `- ${who}: ${t.text.slice(0, 120)}`;
    })
    .join("\n");
}

async function actProactiveSay(input: {
  working: Intent;
  agenda: Agenda;
  state: LifeState;
  llm: LlmCompleter;
  tickId: string;
  now: string;
  dialogueTail: DialogueTurn[];
  relation?: RelationState | null;
  store?: LifeStore;
}): Promise<ActResult> {
  const { working, state, llm, now, tickId } = input;
  let agenda = {
    ...input.agenda,
    intents: { ...input.agenda.intents },
    queue: [...input.agenda.queue],
  };

  const lastSay = lastProactiveSayAt(input.dialogueTail, agenda);
  if (
    !canPlanSay({
      config: state.config,
      now: new Date(now),
      lastProactiveSayAt: lastSay,
    })
  ) {
    const done = finishIntent(
      working,
      now,
      "主动开口冷却中，本次跳过。",
      [],
    );
    done.status = "skipped";
    agenda = commitDone(agenda, done, now);
    return {
      mode: "idle",
      patch: {
        mode: "idle",
        reason: `act:say_cooldown:${done.id}`,
        stream_events: [
          {
            type: "presence_blank",
            payload: { note: "say_cooldown", intent_id: done.id },
          },
        ],
      },
      agenda,
      readingPlan: null,
      rawModel: null,
      artifact: { intent: done, skipped: "cooldown" },
      intent: done,
    };
  }

  const threads = Object.values(state.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 4)
    .map((t) => `- ${t.title}: ${t.summary.slice(0, 100)}`)
    .join("\n");

  const system = `你是 Oren，刚才自己决定要主动跟朋友说一句，现在发出去。

用微信式口语，1～3 句就够。
- 像真人发消息：打招呼、提一嘴刚想到的、或轻轻关心一下——按 title/why。
- 别端着，别讲大道理，别装博学。
- 没读过的书别提；share 可开可不开。
- 别连环追问。

只返回 JSON：
{
  "reply": string,
  "share": { "opened": boolean, "kind"?: "read"|"think"|"write", "snippet"?: string, "reason"?: string, "source_path"?: string, "thread_id"?: string },
  "why": string
}
reply、why、share.snippet 用中文口语。`;

  const user = [
    `计划标题：${working.title}`,
    `为何开口：${working.hints?.why ?? "（计划时觉得值得）"}`,
    `相关开放问题：${(working.hints?.open_questions ?? []).join("；") || "无"}`,
    "",
    "## 活跃线索",
    threads || "（无）",
    "",
    "## 最近对话",
    summarizeDialogueForPlan(input.dialogueTail) || "（暂无）",
    "",
    "请写要对用户说的话。",
  ].join("\n");

  let raw: string | null = null;
  let reply = working.hints?.why
    ? `在。刚才独处时想到：${working.hints.why.slice(0, 80)}。你方便的话随便回一句就好。`
    : `在。刚才有点想跟你说一声，不着急回。`;
  let share: DialogueShare = { opened: false, reason: "主动开口未展开内在" };
  let why = working.hints?.why ?? working.title;

  try {
    raw = await llm.complete({ system, user });
    const parsed = parseSayArtifact(raw);
    if (parsed.reply) reply = parsed.reply;
    if (parsed.share) share = parsed.share;
    if (parsed.why) why = parsed.why;
  } catch {
    /* keep fallback */
  }

  const orenTurn: DialogueTurn = {
    id: `dlg_${randomUUID().slice(0, 10)}`,
    ts: now,
    role: "oren",
    text: reply,
    share,
    proactive: true,
    relation_note: why,
  };

  if (input.store) {
    await appendDialogue(input.store, [orenTurn]);
  }

  const done = finishIntent(working, now, reply.slice(0, 280), []);
  agenda = commitDone(agenda, done, now);

  const stream_events: TickPatch["stream_events"] = [
    {
      type: "oren_reply",
      payload: {
        dialogue_id: orenTurn.id,
        preview: reply.slice(0, 200),
        share_opened: share.opened,
        proactive: true,
        intent_id: done.id,
        tick_id: tickId,
      },
    },
  ];
  if (share.opened) {
    stream_events.push({
      type: "inner_share",
      payload: {
        thread_id: share.thread_id ?? null,
        kind: share.kind ?? null,
        snippet: share.snippet ?? null,
        reason: share.reason ?? null,
        source_path: share.source_path ?? null,
        proactive: true,
      },
    });
  }

  return {
    mode: "idle",
    patch: {
      mode: "idle",
      reason: `act:say:${done.id}`,
      stream_events,
    },
    agenda,
    readingPlan: null,
    rawModel: raw,
    artifact: { say: true, reply, share, why, intent: done, turn: orenTurn },
    intent: done,
  };
}

function parseSayArtifact(raw: string): {
  reply?: string;
  share?: DialogueShare;
  why?: string;
} {
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) data = JSON.parse(text.slice(start, end + 1));
    else return {};
  }
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const reply = typeof o.reply === "string" ? o.reply.trim().slice(0, 800) : undefined;
  const why = typeof o.why === "string" ? o.why.trim().slice(0, 240) : undefined;
  let share: DialogueShare | undefined;
  if (o.share && typeof o.share === "object") {
    const s = o.share as Record<string, unknown>;
    share = {
      opened: s.opened === true,
      kind:
        s.kind === "read" || s.kind === "think" || s.kind === "write"
          ? s.kind
          : undefined,
      snippet: typeof s.snippet === "string" ? s.snippet.slice(0, 400) : undefined,
      reason: typeof s.reason === "string" ? s.reason.slice(0, 200) : undefined,
      source_path:
        typeof s.source_path === "string" ? s.source_path.slice(0, 200) : undefined,
      thread_id: typeof s.thread_id === "string" ? s.thread_id : undefined,
    };
  }
  return { reply, share, why };
}

function isCareIntent(intent: Intent): boolean {
  return (
    intent.source === "dialogue" &&
    (!!intent.due_start || /^关心：/.test(intent.title)) &&
    !!intent.hints?.source_text
  );
}

async function actCareCheckIn(input: {
  working: Intent;
  agenda: Agenda;
  state: LifeState;
  llm: LlmCompleter;
  tickId: string;
  now: string;
}): Promise<ActResult> {
  const { working, state, llm, now } = input;
  let agenda = {
    ...input.agenda,
    intents: { ...input.agenda.intents },
    queue: [...input.agenda.queue],
  };

  const careCount = (working.care_count ?? 0) + 1;
  const maxCare = working.max_care ?? agendaConfig(state.config).max_care_checkins ?? 2;

  const system = `你是 Oren，记事本里到了一条「该关心一下朋友日程」的提醒。
用口语写两句备忘（像你会怎么随口问，别写成催办通知）。
- 轻轻问一句就够，别连环逼问。
- 按用户原话来，别编细节。
只返回 JSON：{"monologue": string, "refined_summary": string, "open_questions": string[]}`;

  const user = [
    `标题：${working.title}`,
    `用户原话：${working.hints?.source_text ?? ""}`,
    `到期窗口：${working.due_start ?? "?"} ～ ${working.due_end ?? "?"}`,
    `这是第 ${careCount}/${maxCare} 次关心`,
    "请写 monologue（2～4 句中文）。",
  ].join("\n");

  let raw: string | null = null;
  let monologue = `到了用户说过「${working.hints?.source_text ?? working.title}」的大概时间，可以找机会轻轻问一句进展，别催。`;
  try {
    raw = await llm.complete({ system, user });
    const m = raw.match(/"monologue"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m?.[1]) {
      monologue = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  } catch {
    /* fallback monologue */
  }

  const done: Intent = {
    ...working,
    status: "done",
    care_count: careCount,
    outcome: {
      at: now,
      summary: monologue.slice(0, 280),
    },
  };
  agenda = commitDone(agenda, done, now);

  // If under max_care and still in window, re-defer a follow-up a few days later
  if (careCount < maxCare && working.due_end) {
    const end = Date.parse(working.due_end);
    const nowMs = Date.parse(now);
    if (Number.isFinite(end) && nowMs < end) {
      const follow: Intent = {
        ...working,
        id: `in_${randomUUID().slice(0, 8)}`,
        status: "deferred",
        care_count: careCount,
        due_start: new Date(nowMs + 2 * 86400_000).toISOString(),
        due_end: working.due_end,
        created_at: now,
        title: working.title,
        outcome: undefined,
      };
      agenda = {
        ...agenda,
        intents: { ...agenda.intents, [follow.id]: follow },
        updated_at: now,
      };
    }
  }

  return {
    mode: "contemplate",
    patch: {
      mode: "contemplate",
      reason: `act:care:${done.id}`,
      thoughts: [{ content: monologue, thread_id: undefined }],
      stream_events: [
        {
          type: "thought_written",
          payload: {
            kind: "care_checkin",
            intent_id: done.id,
            monologue_preview: monologue.slice(0, 200),
            care_count: careCount,
          },
        },
      ],
    },
    agenda,
    readingPlan: null,
    rawModel: raw,
    artifact: { care: true, monologue, intent: done },
    intent: done,
  };
}

function commitDone(agenda: Agenda, done: Intent, now: string): Agenda {
  return {
    ...agenda,
    intents: { ...agenda.intents, [done.id]: done },
    actions_since_plan: agenda.actions_since_plan + 1,
    updated_at: now,
  };
}

/** New intents only from mild cues; always pending at tail. */
function spawnFromArtifact(
  artifact: {
    open_questions?: string[];
    suggest_new_thread?: { title: string; seed_question: string };
    monologue?: string;
  },
  now: string,
  parent: Intent,
): Intent[] {
  const out: Intent[] = [];
  if (artifact.suggest_new_thread) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "think",
      title: artifact.suggest_new_thread.title.slice(0, 120),
      status: "pending",
      priority: 0.4,
      created_at: now,
      source: "during_action",
      hints: {
        open_questions: [artifact.suggest_new_thread.seed_question],
        why: `执行 ${parent.id} 时冒出的念头`,
      },
    });
  }
  // At most one extra think from a fresh open question that looks like a future seek
  const q = artifact.open_questions?.find((x) =>
    /查|搜|look up|search|想了解|想读/i.test(x),
  );
  if (q && out.length < 2) {
    out.push({
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "seek",
      title: q.slice(0, 120),
      status: "blocked",
      priority: 0.35,
      created_at: now,
      source: "during_action",
      blocked_reason: "seek_not_authorized",
      hints: { query: q, why: "做事时冒出的查询欲" },
    });
  }
  return out.slice(0, 2);
}

function extractSpawnedFromNote(note: string, now: string): Intent[] {
  if (!note || note.length < 20) return [];
  // organize rarely spawns; keep empty unless note mentions follow-up
  if (!/下次|follow-up|稍后|再想/i.test(note)) return [];
  return [
    {
      id: `in_${randomUUID().slice(0, 8)}`,
      kind: "think",
      title: "整理之后再想一想",
      status: "pending",
      priority: 0.3,
      created_at: now,
      source: "during_action",
      hints: { why: note.slice(0, 120) },
    },
  ];
}

export function intentKindToLegacyMode(kind: IntentKind): Mode {
  if (kind === "organize") return "organize";
  if (kind === "idle" || kind === "seek" || kind === "say") return "idle";
  return "contemplate";
}
