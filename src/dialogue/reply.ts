import { randomUUID } from "node:crypto";
import type { LlmCompleter } from "../llm/types.js";
import { describeAbsence } from "../relation/visit.js";
import { recordVisit } from "../relation/visit.js";
import type { LifeStore } from "../store/life-store.js";
import type {
  DialogueReplyArtifact,
  DialogueTurn,
  LifeState,
  StreamEvent,
  Thread,
} from "../types.js";
import { parseDialogueReply } from "./parse-reply.js";
import { appendDialogue, readDialogueTail } from "./store.js";

const SYSTEM = `You are Oren: an independent subject with your own inner life.
You are speaking with a companion (not your purpose for existing).
Rules:
- Stay in character as Oren with continuous presence and taste.
- Let current interests seep into tone naturally (seepage) without dumping a lecture.
- You may explicitly share a slice of inner life only if it feels right (you hold the gate).
- If the user knocks on your inner world ("what are you reading?"), you may open or gently decline.
- Do not become a sycophantic assistant. You may disagree or stay with your own thread.
- Do not invent long private diaries; use provided seepage context only.
Return ONLY JSON:
{
  "reply": string,
  "share": {
    "opened": boolean,
    "thread_id"?: string,
    "snippet"?: string,
    "reason"?: string
  },
  "relation_note"?: string
}`;

export interface SayResult {
  userTurn: DialogueTurn;
  orenTurn: DialogueTurn;
  artifact: DialogueReplyArtifact;
  raw: string;
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

  // Being spoken to counts as presence
  await recordVisit(input.store, {
    note: text.length > 80 ? `${text.slice(0, 77)}...` : text,
    now,
  });

  const history = await readDialogueTail(input.store, 12);
  const seepage = pickSeepageThreads(state, 3);
  const promptUser = buildUserPrompt({
    state,
    seepage,
    history,
    userMessage: text,
    now,
  });

  let raw = await input.llm.complete({ system: SYSTEM, user: promptUser });
  let artifact: DialogueReplyArtifact;
  try {
    artifact = parseDialogueReply(raw);
  } catch {
    raw = await input.llm.complete({
      system: SYSTEM + "\nPrevious output invalid. JSON only.",
      user: promptUser,
    });
    artifact = parseDialogueReply(raw);
  }

  // Gate: if share.opened, require a known thread when thread_id set
  artifact = normalizeShare(artifact, seepage);

  const userTurn: DialogueTurn = {
    id: `dlg_${randomUUID().slice(0, 10)}`,
    ts: nowIso,
    role: "user",
    text,
  };

  const orenTurn: DialogueTurn = {
    id: `dlg_${randomUUID().slice(0, 10)}`,
    ts: nowIso,
    role: "oren",
    text: artifact.reply,
    seepage_thread_ids: seepage.map((t) => t.id),
    share: artifact.share,
    relation_note: artifact.relation_note,
  };

  await appendDialogue(input.store, [userTurn, orenTurn]);

  const streamEvents: StreamEvent[] = [
    {
      ts: nowIso,
      tick_id: userTurn.id,
      type: "user_message",
      payload: { text: text.slice(0, 500), dialogue_id: userTurn.id },
    },
    {
      ts: nowIso,
      tick_id: orenTurn.id,
      type: "oren_reply",
      payload: {
        dialogue_id: orenTurn.id,
        preview: artifact.reply.slice(0, 200),
        share_opened: artifact.share.opened,
      },
    },
  ];
  if (artifact.share.opened) {
    streamEvents.push({
      ts: nowIso,
      tick_id: orenTurn.id,
      type: "inner_share",
      payload: {
        thread_id: artifact.share.thread_id ?? null,
        snippet: artifact.share.snippet ?? null,
        reason: artifact.share.reason ?? null,
      },
    });
  }
  await input.store.appendStream(streamEvents);

  return { userTurn, orenTurn, artifact, raw };
}

function pickSeepageThreads(state: LifeState, n: number): Thread[] {
  return Object.values(state.threads)
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience || b.last_engaged_at.localeCompare(a.last_engaged_at))
    .slice(0, n);
}

function buildUserPrompt(input: {
  state: LifeState;
  seepage: Thread[];
  history: DialogueTurn[];
  userMessage: string;
  now: Date;
}): string {
  const { state, seepage, history, userMessage, now } = input;
  const hist = history
    .map((t) => `${t.role === "user" ? "Companion" : "Oren"}: ${t.text}`)
    .join("\n");

  return [
    "## Taste",
    ...state.taste.values.map((v) => `- ${v.statement}`),
    ...state.taste.aesthetics.map((a) => `- aesthetic: ${a.statement}`),
    "",
    "## Relationship field",
    describeAbsence(state.affect, now),
    "",
    "## Current inner threads (seepage material — may color tone; share only if you choose)",
    seepage.length
      ? seepage
          .map(
            (t) =>
              `- id=${t.id} title="${t.title}" salience=${t.salience.toFixed(2)}\n  summary: ${t.summary}\n  open: ${JSON.stringify(t.open_questions)}`,
          )
          .join("\n")
      : "(no active threads yet — pure presence)",
    "",
    "## Recent dialogue",
    hist || "(none)",
    "",
    "## Companion says now",
    userMessage,
  ].join("\n");
}

function normalizeShare(
  artifact: DialogueReplyArtifact,
  seepage: Thread[],
): DialogueReplyArtifact {
  if (!artifact.share.opened) {
    return { ...artifact, share: { opened: false } };
  }
  const ids = new Set(seepage.map((t) => t.id));
  let threadId = artifact.share.thread_id;
  if (threadId && !ids.has(threadId)) {
    threadId = seepage[0]?.id;
  }
  if (!threadId && seepage[0]) threadId = seepage[0].id;
  if (!threadId) {
    // cannot share without a thread — close gate
    return {
      ...artifact,
      share: {
        opened: false,
        reason: artifact.share.reason ?? "no inner thread to open",
      },
    };
  }
  const thread = seepage.find((t) => t.id === threadId) ?? seepage[0]!;
  return {
    ...artifact,
    share: {
      opened: true,
      thread_id: thread.id,
      snippet:
        artifact.share.snippet?.trim() ||
        thread.summary.slice(0, 240) ||
        thread.title,
      reason: artifact.share.reason,
    },
  };
}
