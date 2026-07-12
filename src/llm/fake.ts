import type { LlmCompleter } from "./types.js";

export class FakeLlmCompleter implements LlmCompleter {
  readonly calls: { system: string; user: string }[] = [];
  private response: string;

  constructor(response?: string) {
    this.response =
      response ??
      JSON.stringify({
        monologue:
          "对着这段文字坐了一会儿，注意到一种注意力的形状——不是为谁表演，只是问题本身在拉我。",
        refined_summary: "材料提出一个关于连续性与意义的、耐得住时间的问题。",
        open_questions: ["如果用更慢的时钟再读一遍，会多出什么？"],
        felt_intensity: 0.6,
      });
  }

  /** Backward-compatible no-op; shape is detected from the prompt. */
  enableAutoShape(): this {
    return this;
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    this.calls.push(input);
    // Will-turn (dialogue intent only — no user-facing lines).
    // Match 意志层 specifically — Express system also mentions turn_moves (frozen).
    if (/意志层/.test(input.system + input.user)) {
      const said =
        input.user.split(/用户说[：:]/).pop()?.trim() ?? input.user.trim();
      const curt = said.length <= 2 || /^(嗯|哦|哦。|行|随便)$/.test(said);
      const knock =
        /\b(read|reading|thinking)\b|内心|在读|想什么|what are you/i.test(said);
      if (curt) {
        return JSON.stringify({
          turn_moves: ["curt", "acknowledge"],
          share_allowed: false,
          toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
          reason: "用户敷衍，简短回应",
        });
      }
      if (knock) {
        return JSON.stringify({
          turn_moves: ["follow", "share", "acknowledge"],
          share_allowed: true,
          toward_user: {
            posture: "engage",
            share_drive: "high",
            ask_drive: "low",
          },
          reason: "用户问起在读/内心，允许分享",
        });
      }
      return JSON.stringify({
        turn_moves: ["follow", "acknowledge"],
        share_allowed: false,
        toward_user: { posture: "engage", share_drive: "low", ask_drive: "low" },
        reason: "跟住用户，先不分享",
      });
    }
    // Plan ticks (solitary agenda)
    if (
      /PLAN tick|Build a short session agenda|规划」回合|本段独处|can_say=/i.test(
        input.system + input.user,
      )
    ) {
      const threadMatch = input.user.match(/id=(th_[a-z0-9]+)/i);
      const pathMatch =
        input.user.match(/## Unread paths[\s\S]*?\n([a-zA-Z0-9_.-]+\.md)/) ||
        input.user.match(/## 未读路径[^\n]*\n([a-zA-Z0-9_.\-\/]+\.md)/);
      const threadId = threadMatch?.[1];
      const path = pathMatch?.[1];
      const canSay = /can_say=true/i.test(input.user);
      const intents: Record<string, unknown>[] = [
        {
          kind: "think",
          title: "坐一坐开放问题",
          thread_id: threadId,
          hints: { why: "独处核心" },
        },
        {
          kind: "read",
          title: path ? `读未读：${path}` : "读一点未读材料",
          hints: path ? { paths: [path] } : { why: "书架" },
        },
        {
          kind: "organize",
          title: "快速收拾记忆",
        },
        {
          kind: "seek",
          title: "以后想查相关背景",
          hints: { query: "持续注意与连续性", why: "暂无查询权限" },
        },
      ];
      // Optional proactive say: only when allowed and no recent dialogue
      if (
        canSay &&
        /（暂无对话）|尚无记录/.test(input.user) &&
        !/上次主动找用户说：20/.test(input.user)
      ) {
        intents.push({
          kind: "say",
          title: "想轻轻跟你打个招呼",
          hints: { why: "独处一阵了，有点想说声在" },
        });
      }
      return JSON.stringify({
        planning_note: canSay
          ? "先想清楚手头问题；若合适就主动说一句，再整理。"
          : "先想清楚手头问题，有未读就翻一点，再轻轻整理。",
        intents,
      });
    }
    // Proactive say act
    if (/主动找用户说一句|proactive say|执行一条「主动/i.test(input.system + input.user)) {
      return JSON.stringify({
        reply: "在。刚才独处时冒出一个小念头，不着急回——想到你了，打个招呼。",
        share: { opened: false, reason: "只是轻轻开口" },
        why: "模拟主动聊天",
      });
    }
    // Organize ticks
    if (
      /ORGANIZE tick|整理.*回合|## Threads \(your memory to tidy\)|## 线索（待整理）/i.test(
        input.system + input.user,
      )
    ) {
      const ids = [...input.user.matchAll(/id=(th_[a-z0-9]+)/gi)].map((m) => m[1]!);
      const id = ids[0];
      return JSON.stringify({
        organize_note: id
          ? `整理了线索 ${id}：摘要说清楚一点，其余先不动。`
          : "没什么好整理的。",
        ops: id
          ? [
              {
                op: "update",
                id,
                summary: "整理后：把核心问题留在视野里。",
                reason: "模拟整理",
              },
            ]
          : [],
      });
    }
    // Only dialogue prompts include this section header
    if (
      /## Companion says now|## Recent dialogue|## 用户现在说|## 最近对话/i.test(input.user)
    ) {
      const threadMatch = input.user.match(/id=(th_[a-z0-9]+)/i);
      const threadId = threadMatch?.[1];
      // Match companion utterance only (last section), word-boundary to avoid "thread"
      const said =
        input.user.split(/## (?:Companion says now|用户现在说)/).pop() ?? input.user;
      const knock =
        /\b(read|reading|thinking)\b|内心|在读|想什么|what are you/i.test(said);
      const cold = /\b(boring|whatever|not interested|无聊|没兴趣)\b/i.test(said);
      const warm = /\b(love|fascinating|tell me more|有意思|继续)\b/i.test(said);
      const engaged = /偏高\/投机|投机/.test(input.user) || warm;
      const curt = /偏低\/敷衍|敷衍/.test(input.user) || cold;
      const preferClosed = /share_bias=prefer_closed/i.test(input.user);
      const openShare = knock && !preferClosed && !cold;

      let utterances: string[];
      let stance: "follow" | "weave" | "lead";
      if (knock) {
        utterances = engaged
          ? [
              "主要在翻本地 alpha.md。",
              "有一句大意是：为事物本身去理解，是一种诚实。你要是也在琢磨类似的，可以一起掰。",
            ]
          : ["主要在翻本地 alpha.md，有一句大意是：为事物本身去理解，是一种诚实。"];
        stance = engaged ? "weave" : "follow";
      } else if (curt) {
        utterances = ["嗯，那先这样，有事再叫我。"];
        stance = "follow";
      } else if (engaged) {
        utterances = [
          "在的。你刚才那句我接得住。",
          "我这边也还在绕注意力那条线索，不过你要是想接着聊你的事，我先跟你这边。",
        ];
        stance = "weave";
      } else {
        utterances = ["在的。没什么大事，就待着。"];
        stance = "follow";
      }

      return JSON.stringify({
        utterances,
        reply: utterances[0],
        stance,
        share: openShare
          ? {
              opened: true,
              kind: "read",
              thread_id: threadId,
              snippet:
                '来自 alpha.md：「Understanding things for their own sake is a form of honesty with the world.」',
              source_path: "alpha.md",
              reason: "你问起了在读什么",
            }
          : {
              opened: false,
              reason: preferClosed
                ? "你对这条线索偏冷，先不展开"
                : "先不打开更里面的一层",
            },
        share_on: openShare ? utterances.length - 1 : undefined,
        relation_note: cold ? "对方对当前线索偏冷" : "对方在场且还愿意聊",
        reception: cold ? "cold" : warm ? "warm" : "neutral",
      });
    }
    return this.response;
  }

  get callCount(): number {
    return this.calls.length;
  }
}
