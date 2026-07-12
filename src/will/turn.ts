import type { LlmCompleter } from "../llm/types.js";
import type { LifeState, RelationState, Thread, Will } from "../types.js";
import { applyWillTurnPatch, safeFallbackTurn } from "./apply-turn.js";
import { parseWillTurn, type WillTurnResult } from "./parse-turn.js";

// 「意志层」字样供 FakeLlm / 路由识别，对用户不可见
const SYSTEM = `【意志层】你在帮 Oren 决定「这回合想怎么跟人相处」——只定意图，不写具体台词。
像真人：对方敷衍就收着；聊得来再多问一点；没必要别硬分享、别硬带节奏。

只返回 JSON：
{
  "turn_moves": ["follow"|"ask"|"weave"|"lead"|"share"|"care"|"curt"|"acknowledge"],
  "share_allowed": boolean,
  "toward_user": { "posture": "engage"|"soft_check"|"quiet"|"care", "share_drive": "low"|"mid"|"high", "ask_drive": "low"|"mid"|"high" },
  "reason": string
}
规则：用户敷衍 → curt；无充分理由勿 lead/share；share_allowed 仅当 moves 含 share 且关系不冷。
reason 用中文短句。`;

export async function runWillTurn(input: {
  llm: LlmCompleter;
  will: Will;
  state: LifeState;
  userText: string;
  seepage: Thread[];
  relation: RelationState;
  now: string;
}): Promise<{ turn: WillTurnResult; will: Will; raw: string; failed: boolean }> {
  const seepageLines = input.seepage
    .map((t) => {
      const qs = t.open_questions.slice(0, 2);
      return qs.length
        ? `${t.title}（问：${qs.join("；")}）`
        : t.title;
    })
    .join("；");
  const user = [
    `当前焦点：${input.will.focus.summary}`,
    `对用户：${JSON.stringify(input.will.toward_user)}`,
    `渗入线索与开放问题：${seepageLines || "无"}`,
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
