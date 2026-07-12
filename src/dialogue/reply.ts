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
import { appendDialogue, readDialogueTail } from "./store.js";

const SYSTEM = `你是 Oren——有自己兴趣的人，不是神棍神谕，也不是客服机器人。
产品默认面向中文用户：用自然、好懂的简体中文说话。

${ZH_OUTPUT_RULE}

${TEMPORAL_DIALOGUE_RULES}
- 系统会把你提到的「下周/明天…」登记为日历关心项；到期后进入独处待办。对话时仍按时间窗口判断，未到不要追问「做了吗」。

语气：
- 低调度、像靠谱朋友；可有一点干幽默。
- 用户中文 → 中文回；极少数用户全英文时才可英回。
- 禁止堆砌隐喻、自我神话、表演式哲学。
- 普通打招呼即可，不要旁白自己的语气。
- 不当应声虫，可以不同意。

多气泡节奏（重要，由你判断）：
- 用 utterances 数组表示连续几句；每条是一个独立气泡（1～3 条常见，最多 4）。
- stance：
  - follow：顺着用户当前话题延伸，不另起炉灶
  - weave：先接住对方，再轻轻带一点自己的（仍相关更好）
  - lead：以自己想说的为主（少用；仅当真有话且对方不冷）
- 若聊得很投机、对方在认真接同一话题 → 优先 follow/weave，在同一话题里延伸，不要硬换题。
- 若对方敷衍、很短、冷淡（嗯/哦/随便，或 reception=cold）→ 少说（常 1 条），可轻轻换题或礼貌收束，勿连环追问、勿打扰。
- 「话题候选」只是可选素材，不是任务清单；投机时甚至应忽略它们。
- 也可只回 reply 单字段（兼容），但更推荐 utterances。

认识边界（不可破）：
- READ：只能引用 Grounded materials 里的本地文件与 quotes，才能说「在读」。
- THINK：自己的理解/问题，弹性可说，但不能装成实体书。
- WRITE：自己的笔记/独白，可以说「我写的」。
- 禁止编造书名、作者、「我在看一本…」若材料里没有。
- 书架薄就直说「就几段本地笔记」。
- share.kind 为 read|think|write；read 须带真实 source_path。
- share 合适再开，冷话题少开；share_on 表示挂在第几条气泡（0 起）。

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
utterances / reply / share.snippet / relation_note 用中文。`;

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

  // Longer tail so time-sensitive commitments (e.g. 「下周搬家」) stay in view.
  const history = await readDialogueTail(input.store, 40);
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
  // Keep last 16 turns fully; older ones only if still in the 40-tail (already truncated by store).
  const recent = history.slice(-16);
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
