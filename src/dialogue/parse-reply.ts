import type { DialogueReplyArtifact } from "../types.js";

export class DialogueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialogueParseError";
  }
}

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
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  if (!reply) throw new DialogueParseError("reply text is required");

  let share: DialogueReplyArtifact["share"] = { opened: false };
  if (obj.share && typeof obj.share === "object") {
    const s = obj.share as Record<string, unknown>;
    share = {
      opened: Boolean(s.opened),
      thread_id: typeof s.thread_id === "string" ? s.thread_id : undefined,
      snippet: typeof s.snippet === "string" ? s.snippet : undefined,
      reason: typeof s.reason === "string" ? s.reason : undefined,
    };
  }

  return {
    reply,
    share,
    relation_note:
      typeof obj.relation_note === "string" ? obj.relation_note.trim() : undefined,
  };
}

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1];
  return raw;
}
