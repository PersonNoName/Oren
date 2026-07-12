import type {
  ConversationStance,
  DialogueMoveKind,
  DialogueReplyArtifact,
} from "../types.js";

export function enforceExpressConstraints(
  artifact: DialogueReplyArtifact,
  opts: { turn_moves: DialogueMoveKind[]; share_allowed: boolean },
): DialogueReplyArtifact {
  const moves = new Set(opts.turn_moves);
  let stance: ConversationStance = stanceFromMoves(opts.turn_moves);

  let utterances = [...artifact.utterances];
  let share = { ...artifact.share };

  if (!opts.share_allowed || !moves.has("share")) {
    share = { opened: false, reason: share.reason ?? "will_blocked_share" };
  }

  if (moves.has("curt")) {
    utterances = utterances.slice(0, 1);
    stance = "follow";
    share = { opened: false, reason: "curt" };
  }

  // Safety: never leave lead without an explicit lead move
  if (!moves.has("lead") && stance === "lead") stance = "follow";

  const reply = utterances[0] ?? artifact.reply;
  return { ...artifact, stance, utterances, reply, share };
}

export function stanceFromMoves(moves: DialogueMoveKind[]): ConversationStance {
  if (moves.includes("lead")) return "lead";
  if (moves.includes("weave")) return "weave";
  return "follow";
}
