import type { DialogueMoveKind, DriveLevel, WillPosture } from "../types.js";

const MOVES = new Set<DialogueMoveKind>([
  "follow",
  "ask",
  "weave",
  "lead",
  "share",
  "care",
  "curt",
  "acknowledge",
]);

export interface WillTurnResult {
  turn_moves: DialogueMoveKind[];
  share_allowed: boolean;
  toward_user?: {
    posture?: WillPosture;
    share_drive?: DriveLevel;
    ask_drive?: DriveLevel;
  };
  reason?: string;
  /** optional open_moves titles to enqueue — keep minimal in v1 */
  promote_open?: { kind: DialogueMoveKind; title: string }[];
}

export function parseWillTurn(raw: string): WillTurnResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("will-turn: no JSON");
  const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  let moves = Array.isArray(obj.turn_moves)
    ? (obj.turn_moves as string[]).filter((m): m is DialogueMoveKind =>
        MOVES.has(m as DialogueMoveKind),
      )
    : [];
  if (moves.length === 0) moves = ["follow", "acknowledge"];
  // hard caps
  if (moves.includes("curt")) {
    moves = moves.filter((m) => m === "curt" || m === "acknowledge" || m === "follow");
  }
  return {
    turn_moves: moves.slice(0, 4),
    share_allowed: Boolean(obj.share_allowed),
    toward_user: obj.toward_user as WillTurnResult["toward_user"],
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}
