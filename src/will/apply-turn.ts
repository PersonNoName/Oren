import type { Will } from "../types.js";
import type { WillTurnResult } from "./parse-turn.js";

export function applyWillTurnPatch(
  will: Will,
  turn: WillTurnResult,
  now: string,
): Will {
  return {
    ...will,
    updated_at: now,
    toward_user: {
      posture: turn.toward_user?.posture ?? will.toward_user.posture,
      share_drive: turn.toward_user?.share_drive ?? will.toward_user.share_drive,
      ask_drive: turn.toward_user?.ask_drive ?? will.toward_user.ask_drive,
    },
    last_reason: turn.reason ?? will.last_reason,
  };
}

export function safeFallbackTurn(userText: string): WillTurnResult {
  const t = userText.trim();
  const curt = t.length <= 2 || /^(嗯|哦|哦。|行|随便)$/.test(t);
  if (curt) {
    return {
      turn_moves: ["curt", "acknowledge"],
      share_allowed: false,
      toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
      reason: "fallback_curt",
    };
  }
  return {
    turn_moves: ["follow", "acknowledge"],
    share_allowed: false,
    reason: "fallback_follow",
  };
}
