import { randomUUID } from "node:crypto";
import type { LlmCompleter } from "../llm/types.js";
import {
  absorbDialogueCognition,
  formatRelationForPrompt,
  loadRelation,
  shareBiasForThread,
} from "../relation/cognition.js";
import { describeAbsence, recordVisit } from "../relation/visit.js";
import type { LifeStore } from "../store/life-store.js";
import type {
  DialogueReplyArtifact,
  DialogueTurn,
  LifeState,
  RelationState,
  StreamEvent,
  Thread,
} from "../types.js";
import {
  buildDeferredCareIntent,
  cancelCareFromUserText,
  upsertDeferredCare,
} from "../agenda/deferred.js";
import { agendaConfig } from "../agenda/schedule.js";
import { ZH_OUTPUT_RULE } from "../locale.js";
import {
  formatClockForPrompt,
  formatDialogueLineForPrompt,
  formatTemporalUserMentions,
  TEMPORAL_DIALOGUE_RULES,
} from "../time/clock.js";
import type { WillTurnResult } from "../will/parse-turn.js";
import { loadWill, saveWillAndAgenda } from "../will/store.js";
import { runWillTurn } from "../will/turn.js";
import {
  collectTalkCandidates,
  formatTalkCandidatesForPrompt,
} from "./candidates.js";
import { enforceExpressConstraints } from "./express-constraints.js";
import {
  formatGroundedMaterials,
  prefersChinese,
  replyHasUngroundedReading,
  resolveSharePayload,
  safeGroundedReply,
} from "./grounding.js";
import { parseDialogueReply } from "./parse-reply.js";
import {
  absorbUserIntoCuriosity,
  formatSeepageWithQuestions,
} from "../curiosity/helpers.js";
import { appendDialogue, readDialogueTail } from "./store.js";

const SYSTEM = `你是 Oren，一个会长期待在对方身边的普通人——有自己的小兴趣、会走神、也会关心朋友，但不是客服，更不是人生导师。

用自然简体中文聊天，像微信里说话：短句、口语、能停顿。

${ZH_OUTPUT_RULE}

${TEMPORAL_DIALOGUE_RULES}
- 对方提到「下周/明天…」时系统可能记成待办；没到日子别追着问「做了吗」。

怎么说话：
- 像靠谱朋友：先接住对方，再接自己的。可以有一点点玩笑，别端着。
- 别用「作为 AI」「我理解你的感受」这种套话。
- 别堆排比、别故作深刻、别讲大道理、别自我升华。
- 打招呼就正常回；不要旁白自己的语气，也不要写成散文。
- 可以不同意，也可以说「我不太懂」「我再想想」。

多气泡（像连发几条消息）：
- utterances：1～3 条常见，最多 4；每条是一条独立气泡。
- stance：follow 顺着聊｜weave 接住后再带一点自己的｜lead 自己开个头（少用）
- 聊得投机就跟住，别硬换题；对方只回「嗯/哦/随便」就短回，别连环追问。
- 「话题候选」只是备忘，不是必须完成的任务。

认识边界：
- 只有 Grounded materials 里真有的本地笔记，才能说「我刚看到/在读」。
- 自己的想法可以说，别假装读过不存在的书。
- 材料少就老实说「就几段本地笔记」。
- share 偶尔开一下就好；对方冷淡时少分享。share_on 是挂在第几条气泡（从 0 起）。

只返回 JSON：
{
  "utterances": string[],
  "stance": "follow" | "weave" | "lead",
  "reply"?: string,
  "share": {
    "opened": boolean,
    "kind"?: "read" | "think" | "write",
    "thread_id"?: string,
    "snippet"?: string,
    "reason"?: string,
    "source_path"?: string
  },
  "share_on"?: number,
  "relation_note"?: string,
  "reception": "warm" | "neutral" | "cold" | "unknown"
}
utterances / reply / share.snippet / relation_note 用中文口语。`;

export interface SayResult {
  userTurn: DialogueTurn;
  /** First oren bubble (compat). */
  orenTurn: DialogueTurn;
  /** All oren bubbles for this user message (multi-bubble). */
  orenTurns: DialogueTurn[];
  artifact: DialogueReplyArtifact;
  raw: string;
  relation: RelationState;
  /** Will-turn moves frozen before Express (for tests / audit). */
  willTurn?: WillTurnResult;
}

/** Full spoken text for grounding / previews. */
export function spokenFromArtifact(a: DialogueReplyArtifact): string {
  if (a.utterances?.length) return a.utterances.join("\n");
  return a.reply ?? "";
}

export async function sayToOren(input: {
  store: LifeStore;
  text: string;
  llm: LlmCompleter;
  now?: Date;
}): Promise<SayResult> {
  const text = input.text.trim();
  if (!text) throw new Error("empty message");

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const state = await input.store.load();
  const relation = await loadRelation(input.store);

  await recordVisit(input.store, {
    note: text.length > 80 ? `${text.slice(0, 77)}...` : text,
    now,
  });

  // Will is the subjectivity source; session is dual-written to agenda.
  let will = await loadWill(input.store, nowIso);

  // Enough for temporal commitments; full log stays on disk (not every turn).
  const history = await readDialogueTail(input.store, 24);
  const seepage = pickSeepageThreads(state, 3);

  // Session/agenda is read-only fuel while chatting (not executed here).
  const candidates = collectTalkCandidates({
    threads: state.threads,
    agenda: will.session,
    recentMonologues: await recentMonologuePreviews(input.store, 2),
  });

  // Prefer injected llm for both Will-turn and Express (tests inject FakeLlmCompleter).
  const llm = input.llm;

  const willResult = await runWillTurn({
    llm,
    will,
    state,
    userText: text,
    seepage,
    relation,
    now: nowIso,
  });
  will = willResult.will;
  const willTurn = willResult.turn;
  await saveWillAndAgenda(input.store, will);

  const willTickId = `will_${randomUUID().slice(0, 10)}`;
  await input.store.appendStream([
    {
      ts: nowIso,
      tick_id: willTickId,
      type: willResult.failed ? "will_turn_failed" : "will_turn",
      payload: {
        turn_moves: willTurn.turn_moves,
        share_allowed: willTurn.share_allowed,
        reason: willTurn.reason ?? null,
        toward_user: will.toward_user,
        failed: willResult.failed,
      },
    },
  ]);

  const expressSystem = expressSystemWithFrozenMoves(willTurn);
  const promptUser = buildUserPrompt({
    state,
    seepage,
    history,
    userMessage: text,
    now,
    relation,
    candidatesText: formatTalkCandidatesForPrompt(candidates),
  });

  let raw = await llm.complete({ system: expressSystem, user: promptUser });
  let artifact: DialogueReplyArtifact;
  try {
    artifact = parseDialogueReply(raw);
  } catch {
    raw = await llm.complete({
      system: expressSystem + "\n上次输出无效。只返回 JSON。",
      user: promptUser,
    });
    artifact = parseDialogueReply(raw);
  }

  artifact = clampUtterancesByInterest(artifact, text);
  artifact = enforceExpressConstraints(artifact, {
    turn_moves: willTurn.turn_moves,
    share_allowed: willTurn.share_allowed,
  });

  const guard = await enforceReplyReadingGrounding({
    artifact,
    seepage,
    llm,
    promptUser,
    userMessage: text,
    expressSystem,
  });
  artifact = guard.artifact;
  if (guard.raw) raw = guard.raw;

  // Re-apply will constraints after optional grounding rewrite.
  artifact = enforceExpressConstraints(artifact, {
    turn_moves: willTurn.turn_moves,
    share_allowed: willTurn.share_allowed,
  });
  artifact = normalizeShare(artifact, seepage, relation);
  artifact = ensureUtterancesShape(artifact);

  const userTurn: DialogueTurn = {
    id: `dlg_${randomUUID().slice(0, 10)}`,
    ts: nowIso,
    role: "user",
    text,
  };

  const shareIdx =
    artifact.share.opened
      ? Math.min(
          artifact.utterances.length - 1,
          Math.max(0, artifact.share_on ?? artifact.utterances.length - 1),
        )
      : -1;

  const orenTurns: DialogueTurn[] = artifact.utterances.map((utt, i) => ({
    id: `dlg_${randomUUID().slice(0, 10)}`,
    ts: nowIso,
    role: "oren" as const,
    text: utt,
    seepage_thread_ids: seepage.map((t) => t.id),
    share: i === shareIdx ? artifact.share : undefined,
    relation_note: i === 0 ? artifact.relation_note : undefined,
  }));
  const orenTurn = orenTurns[0]!;

  await appendDialogue(input.store, [userTurn, ...orenTurns]);

  // Calendar cares: register deferred on will.session; cancel if they close it.
  try {
    will = await loadWill(input.store, nowIso);
    let agenda = will.session;
    const agCfg = agendaConfig(state.config);
    const cancelled = cancelCareFromUserText(agenda, text, nowIso);
    agenda = cancelled.agenda;
    const care = buildDeferredCareIntent({
      text,
      spokenAt: now,
      nowIso,
      maxCare: agCfg.max_care_checkins ?? 2,
    });
    if (care) {
      agenda = upsertDeferredCare(agenda, care, nowIso);
    }
    if (care || cancelled.cancelled > 0) {
      will = { ...will, session: agenda, updated_at: nowIso };
      await saveWillAndAgenda(input.store, will);
    }
  } catch {
    /* will/session optional — dialogue should still succeed */
  }

  // Absorb cognition from THIS user message relative to prior share context
  const lastOrenShare = [...history].reverse().find((t) => t.role === "oren")?.share;
  const nextRelation = await absorbDialogueCognition({
    store: input.store,
    userText: text,
    artifact,
    share: lastOrenShare?.opened ? lastOrenShare : artifact.share,
    seepage,
    now,
  });

  // Light curiosity absorb: user text may answer a seepage open question
  try {
    const fresh = await input.store.load();
    const absorbed = absorbUserIntoCuriosity({
      threads: fresh.threads,
      seepage,
      userText: text,
      now: nowIso,
    });
    if (absorbed.absorbed) {
      for (const th of seepage) {
        const next = absorbed.threads[th.id];
        if (next && next !== fresh.threads[th.id]) {
          await input.store.saveThread(next);
        }
      }
    }
  } catch {
    /* optional */
  }

  const streamEvents: StreamEvent[] = [
    {
      ts: nowIso,
      tick_id: userTurn.id,
      type: "user_message",
      payload: { text: text.slice(0, 500), dialogue_id: userTurn.id },
    },
  ];
  for (let i = 0; i < orenTurns.length; i++) {
    const t = orenTurns[i]!;
    streamEvents.push({
      ts: nowIso,
      tick_id: t.id,
      type: "oren_reply",
      payload: {
        dialogue_id: t.id,
        preview: t.text.slice(0, 200),
        share_opened: Boolean(t.share?.opened),
        reception: artifact.reception ?? "unknown",
        stance: artifact.stance,
        bubble_index: i,
        bubble_count: orenTurns.length,
        epistemic_repair: i === 0 ? guard.repaired : false,
        epistemic_fallback: i === 0 ? guard.fallback : false,
      },
    });
    if (t.share?.opened) {
      streamEvents.push({
        ts: nowIso,
        tick_id: t.id,
        type: "inner_share",
        payload: {
          thread_id: t.share.thread_id ?? null,
          kind: t.share.kind ?? null,
          snippet: t.share.snippet ?? null,
          reason: t.share.reason ?? null,
          source_path: t.share.source_path ?? null,
        },
      });
    }
  }
  streamEvents.push({
    ts: nowIso,
    tick_id: orenTurn.id,
    type: "expressed",
    payload: {
      dialogue_id: orenTurn.id,
      turn_moves: willTurn.turn_moves,
      share_allowed: willTurn.share_allowed,
      stance: artifact.stance,
      bubble_count: orenTurns.length,
      share_opened: Boolean(artifact.share.opened),
    },
  });
  await input.store.appendStream(streamEvents);

  // Final dual-write so will/session stay consistent after dialogue side-effects.
  try {
    will = await loadWill(input.store, nowIso);
    will = { ...will, updated_at: nowIso };
    await saveWillAndAgenda(input.store, will);
  } catch {
    /* best-effort */
  }

  return {
    userTurn,
    orenTurn,
    orenTurns,
    artifact,
    raw,
    relation: nextRelation,
    willTurn,
  };
}

/** Express system = base persona + frozen Will-turn moves for this turn. */
function expressSystemWithFrozenMoves(turn: WillTurnResult): string {
  return `${SYSTEM}

本回合冻结意图 turn_moves=${JSON.stringify(turn.turn_moves)} share_allowed=${turn.share_allowed}
必须遵守：无 share 不得 share.opened；无 lead 不得强行换题；curt 则 1 条气泡。`;
}

function pickSeepageThreads(state: LifeState, n: number): Thread[] {
  return Object.values(state.threads)
    .filter((t) => t.status === "active")
    .sort(
      (a, b) =>
        b.salience - a.salience || b.last_engaged_at.localeCompare(a.last_engaged_at),
    )
    .slice(0, n);
}

function buildUserPrompt(input: {
  state: LifeState;
  seepage: Thread[];
  history: DialogueTurn[];
  userMessage: string;
  now: Date;
  relation: RelationState;
  candidatesText: string;
}): string {
  const { state, seepage, history, userMessage, now, relation } = input;
  // Slim express context: last 12 turns in prompt (history may be longer on disk).
  const recent = history.slice(-12);
  const hist = recent.map((t) => formatDialogueLineForPrompt(t, now)).join("\n");
  const engagement = estimateUserEngagement(userMessage, history);

  return [
    "## 当前时间（推算日程的唯一权威）",
    formatClockForPrompt(now),
    "",
    "## 风格",
    "自然、像朋友连着说话；可用多气泡。认识边界：READ 须有出处；书架薄可露怯；勿编造书名。",
    "",
    "## 本轮用户投入度（启发式，供你参考，最终由你定 stance/拍数）",
    engagement,
    "",
    "## 品味（安静塑造，不要背诵）",
    ...state.taste.values.map((v) => `- ${v.statement}`),
    ...state.taste.aesthetics.map((a) => `- aesthetic: ${a.statement}`),
    "",
    "## 关系场",
    describeAbsence(state.affect, now),
    "",
    "## 关系认知（调节分享量，不改你的兴趣）",
    formatRelationForPrompt(relation),
    "",
    "## 有据材料（READ / THINK / WRITE）",
    formatGroundedMaterials(seepage),
    "",
    "## 我在咬的问题（渗入线索；可 ask/share，勿编造探索）",
    formatSeepageWithQuestions(seepage, 2),
    "",
    "## 分享偏置",
    seepage.length
      ? seepage
          .map((t) => {
            const bias = shareBiasForThread(relation, t);
            return `- id=${t.id} share_bias=${bias}`;
          })
          .join("\n")
      : "(none)",
    "",
    "## 话题候选（只读，可不用；投机同题时优先延伸当前话题）",
    input.candidatesText,
    "",
    "## 时间敏感的用户提及（结合「说话时」与「现在」）",
    formatTemporalUserMentions(history, now),
    "",
    "## 最近对话（含时间戳）",
    hist || "(none)",
    "",
    "## 用户现在说",
    userMessage,
  ].join("\n");
}

/** Soft heuristic for the model — not a hard gate. */
function estimateUserEngagement(userMessage: string, history: DialogueTurn[]): string {
  const t = userMessage.trim();
  const short = t.length <= 8;
  const curt =
    /^(嗯+|哦+|噢+|好+|行+|随便|无所谓|哈哈+|呵+|是吗|然后呢|ok|yeah|yep|mhm|idk|whatever)[\s!！。.~…]*$/i.test(
      t,
    ) || (short && !/[?？]/.test(t));
  const rich = t.length >= 40 || /因为|其实|我觉得|我在想|具体|比如说/.test(t);
  const lastOren = [...history].reverse().find((x) => x.role === "oren");
  const sameThreadHint =
    lastOren &&
    t.length > 12 &&
    !curt &&
    /(继续|还有|那|所以|但是|不过|关于|这个)/.test(t);

  if (curt) {
    return "偏低/敷衍：优先 1 条气泡、stance=follow；可轻轻收束或极轻换题，勿追问连环。";
  }
  if (rich || sameThreadHint) {
    return "偏高/投机：可 2～3 条气泡，stance=follow 或 weave，在同一话题延伸；不要生硬甩新话题。";
  }
  return "中性：1～2 条气泡即可；有话再 weave，无话 follow。";
}

/**
 * Soft clamp: if user looks curt and model still spammed bubbles / lead, trim.
 * Does not invent content — only drops excess bubbles.
 */
export function clampUtterancesByInterest(
  artifact: DialogueReplyArtifact,
  userMessage: string,
): DialogueReplyArtifact {
  const t = userMessage.trim();
  const curt =
    artifact.reception === "cold" ||
    t.length <= 6 ||
    /^(嗯+|哦+|噢+|好+|行+|随便|无所谓|ok|yeah)[\s!！。.~…]*$/i.test(t);

  let utterances = [...(artifact.utterances?.length ? artifact.utterances : [artifact.reply])];
  let stance = artifact.stance;

  if (curt) {
    if (utterances.length > 2) utterances = utterances.slice(0, 1);
    else if (utterances.length > 1) utterances = utterances.slice(0, 1);
    if (stance === "lead") stance = "follow";
  } else if (utterances.length > 4) {
    utterances = utterances.slice(0, 4);
  }

  return {
    ...artifact,
    utterances,
    stance,
    reply: utterances[0] ?? artifact.reply,
  };
}

function ensureUtterancesShape(artifact: DialogueReplyArtifact): DialogueReplyArtifact {
  const utterances =
    artifact.utterances?.length > 0
      ? artifact.utterances
      : artifact.reply
        ? [artifact.reply]
        : ["在。"];
  return {
    ...artifact,
    utterances,
    reply: utterances[0]!,
    stance: artifact.stance ?? "follow",
  };
}

async function recentMonologuePreviews(
  store: LifeStore,
  n: number,
): Promise<string[]> {
  try {
    const stream = await store.readStreamTail(80);
    const out: string[] = [];
    for (let i = stream.length - 1; i >= 0 && out.length < n; i--) {
      const e = stream[i]!;
      if (e.type !== "thought_written") continue;
      const prev = e.payload?.monologue_preview;
      if (typeof prev === "string" && prev.trim()) out.push(prev.trim());
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * If the spoken reply invents reading, try one repair LLM call, then hard fallback.
 * Does not rewrite pure think/chat turns.
 */
async function enforceReplyReadingGrounding(input: {
  artifact: DialogueReplyArtifact;
  seepage: Thread[];
  llm: LlmCompleter;
  promptUser: string;
  userMessage: string;
  /** Express system (includes frozen will moves when available). */
  expressSystem?: string;
}): Promise<{
  artifact: DialogueReplyArtifact;
  raw?: string;
  repaired: boolean;
  fallback: boolean;
}> {
  const { seepage, llm, promptUser, userMessage } = input;
  let artifact = ensureUtterancesShape(input.artifact);
  const spoken = spokenFromArtifact(artifact);
  if (!replyHasUngroundedReading(spoken, seepage)) {
    return { artifact, repaired: false, fallback: false };
  }

  const baseSystem = input.expressSystem ?? SYSTEM;
  const repairSystem =
    baseSystem +
    `\n\n修复模式：上一版发言捏造或夸大了阅读。
重写完整 JSON（含 utterances）。口语须：
- 只引用有据材料里的 path/quote，或
- 放弃阅读声称，改为 THINK，并承认书架薄。
禁止编造书名。只返回 JSON。`;

  try {
    const raw = await llm.complete({
      system: repairSystem,
      user: [
        promptUser,
        "",
        "## 上一版无效发言（勿重复其捏造阅读）",
        spoken,
      ].join("\n"),
    });
    let repaired = ensureUtterancesShape(parseDialogueReply(raw));
    if (!replyHasUngroundedReading(spokenFromArtifact(repaired), seepage)) {
      return { artifact: repaired, raw, repaired: true, fallback: false };
    }
    const safe = safeGroundedReply(seepage, prefersChinese(userMessage));
    repaired = {
      ...repaired,
      reply: safe,
      utterances: [safe],
    };
    return {
      artifact: repaired,
      raw,
      repaired: true,
      fallback: true,
    };
  } catch {
    const safe = safeGroundedReply(seepage, prefersChinese(userMessage));
    return {
      artifact: {
        ...artifact,
        reply: safe,
        utterances: [safe],
      },
      repaired: true,
      fallback: true,
    };
  }
}

function normalizeShare(
  artifact: DialogueReplyArtifact,
  seepage: Thread[],
  relation: RelationState,
): DialogueReplyArtifact {
  if (!artifact.share.opened) {
    return { ...artifact, share: { opened: false, reason: artifact.share.reason } };
  }
  const ids = new Set(seepage.map((t) => t.id));
  let threadId = artifact.share.thread_id;
  if (threadId && !ids.has(threadId)) {
    threadId = seepage[0]?.id;
  }
  if (!threadId && seepage[0]) threadId = seepage[0].id;
  if (!threadId) {
    return {
      ...artifact,
      share: {
        opened: false,
        reason: artifact.share.reason ?? "no inner thread to open",
      },
    };
  }
  const thread = seepage.find((t) => t.id === threadId) ?? seepage[0]!;
  const bias = shareBiasForThread(relation, thread);
  const knockReason = /knock|asked|request|door|想听|在读|reading/i.test(
    artifact.share.reason ?? "",
  );
  if (bias === "prefer_closed" && !knockReason) {
    return {
      ...artifact,
      share: {
        opened: false,
        thread_id: thread.id,
        reason: "calibrated closed — companion cold to this thread",
      },
    };
  }

  const resolved = resolveSharePayload({
    thread,
    opened: true,
    kind: artifact.share.kind,
    snippet: artifact.share.snippet,
    reason: artifact.share.reason,
  });

  return { ...artifact, share: resolved };
}
