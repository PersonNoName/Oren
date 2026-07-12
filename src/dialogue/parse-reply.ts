import type {
  ConversationStance,
  DialogueReplyArtifact,
} from "../types.js";
import { parseShareKind } from "./epistemics.js";

export class DialogueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialogueParseError";
  }
}

const MAX_UTTERANCES = 4;
const MAX_UTTERANCE_CHARS = 600;

export function parseDialogueReply(raw: string): DialogueReplyArtifact {
  const text = stripFences(raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new DialogueParseError("reply is not valid JSON");
      }
    } else {
      throw new DialogueParseError("reply is not valid JSON");
    }
  }
  if (!data || typeof data !== "object") {
    throw new DialogueParseError("reply root must be object");
  }
  const obj = data as Record<string, unknown>;

  const utterances = normalizeUtterances(obj);
  if (utterances.length === 0) {
    throw new DialogueParseError("reply text is required");
  }
  const reply = utterances[0]!;

  let share: DialogueReplyArtifact["share"] = { opened: false };
  if (obj.share && typeof obj.share === "object") {
    const s = obj.share as Record<string, unknown>;
    const kind = parseShareKind(s.kind);
    share = {
      opened: Boolean(s.opened),
      kind,
      thread_id: typeof s.thread_id === "string" ? s.thread_id : undefined,
      snippet: typeof s.snippet === "string" ? s.snippet : undefined,
      reason: typeof s.reason === "string" ? s.reason : undefined,
      source_path: typeof s.source_path === "string" ? s.source_path : undefined,
      chunk_id: typeof s.chunk_id === "string" ? s.chunk_id : undefined,
    };
  }

  let reception: DialogueReplyArtifact["reception"] = "unknown";
  if (typeof obj.reception === "string") {
    const r = obj.reception.toLowerCase();
    if (r === "warm" || r === "neutral" || r === "cold" || r === "unknown") {
      reception = r;
    }
  }

  const stance = normalizeStance(obj.stance, reception);

  let share_on: number | undefined;
  if (typeof obj.share_on === "number" && Number.isFinite(obj.share_on)) {
    share_on = Math.max(0, Math.min(utterances.length - 1, Math.floor(obj.share_on)));
  } else if (share.opened) {
    share_on = utterances.length - 1;
  }

  return {
    reply,
    utterances,
    stance,
    share,
    relation_note:
      typeof obj.relation_note === "string" ? obj.relation_note.trim() : undefined,
    reception,
    share_on,
  };
}

function normalizeUtterances(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(obj.utterances)) {
    for (const item of obj.utterances) {
      if (typeof item !== "string") continue;
      const t = item.trim().slice(0, MAX_UTTERANCE_CHARS);
      if (t) out.push(t);
      if (out.length >= MAX_UTTERANCES) break;
    }
  }
  if (out.length === 0 && typeof obj.reply === "string") {
    const t = obj.reply.trim().slice(0, MAX_UTTERANCE_CHARS);
    if (t) out.push(t);
  }
  // Also accept legacy multi-paragraph reply as soft split only when no utterances array
  if (
    out.length === 1 &&
    !Array.isArray(obj.utterances) &&
    typeof obj.reply === "string" &&
    /\n\n+/.test(obj.reply)
  ) {
    const parts = obj.reply
      .split(/\n\n+/)
      .map((p) => p.trim().slice(0, MAX_UTTERANCE_CHARS))
      .filter(Boolean)
      .slice(0, MAX_UTTERANCES);
    if (parts.length > 1) return parts;
  }
  return out;
}

function normalizeStance(
  raw: unknown,
  reception: DialogueReplyArtifact["reception"],
): ConversationStance {
  if (typeof raw === "string") {
    const s = raw.toLowerCase().trim();
    if (s === "follow" || s === "weave" || s === "lead") return s;
  }
  // Soft default: cold → follow; else weave-friendly default follow (model should set explicitly)
  if (reception === "cold") return "follow";
  return "follow";
}

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1];
  return raw;
}
