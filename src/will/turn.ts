import type { LlmCompleter } from "../llm/types.js";
import type { LifeState, RelationState, Thread, Will } from "../types.js";
import { applyWillTurnPatch, safeFallbackTurn } from "./apply-turn.js";
import { parseWillTurn, type WillTurnResult } from "./parse-turn.js";

const SYSTEM = `你是 Oren 的意志层，只决定本回合意图，不写对用户台词。
只返回 JSON：
{
  "turn_moves": ["follow"|"ask"|"weave"|"lead"|"share"|"care"|"curt"|"acknowledge"],
  "share_allowed": boolean,
  "toward_user": { "posture": "engage"|"soft_check"|"quiet"|"care", "share_drive": "low"|"mid"|"high", "ask_drive": "low"|"mid"|"high" },
  "reason": string
}
规则：用户敷衍 → curt；无充分理由勿 lead/share；share_allowed 仅当 moves 含 share 且关系不冷。
中文 reason。`;

export async function runWillTurn(input: {
  llm: LlmCompleter;
  will: Will;
  state: LifeState;
  userText: string;
  seepage: Thread[];
  relation: RelationState;
  now: string;
}): Promise<{ turn: WillTurnResult; will: Will; raw: string; failed: boolean }> {
  const user = [
    `当前焦点：${input.will.focus.summary}`,
    `对用户：${JSON.stringify(input.will.toward_user)}`,
    `渗入线索：${input.seepage.map((t) => t.title).join("；") || "无"}`,
    `冷话题：${input.relation.cold_topics.map((c) => c.key).slice(0, 5).join(",") || "无"}`,
    `用户说：${input.userText}`,
  ].join("\n");

  try {
    const raw = await input.llm.complete({ system: SYSTEM, user });
    let turn = parseWillTurn(raw);
    // consistency: share_allowed requires share move
    if (turn.share_allowed && !turn.turn_moves.includes("share")) {
      turn = { ...turn, share_allowed: false };
    }
    if (turn.turn_moves.includes("share") && !turn.share_allowed) {
      turn = { ...turn, turn_moves: turn.turn_moves.filter((m) => m !== "share") };
    }
    const will = applyWillTurnPatch(input.will, turn, input.now);
    return { turn, will, raw, failed: false };
  } catch {
    const turn = safeFallbackTurn(input.userText);
    const will = applyWillTurnPatch(input.will, turn, input.now);
    return { turn, will, raw: "", failed: true };
  }
}
