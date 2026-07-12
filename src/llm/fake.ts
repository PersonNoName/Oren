import type { LlmCompleter } from "./types.js";

export class FakeLlmCompleter implements LlmCompleter {
  readonly calls: { system: string; user: string }[] = [];
  private response: string;

  constructor(response?: string) {
    this.response =
      response ??
      JSON.stringify({
        monologue:
          "翻了两段关于日常的笔记，觉得挺实在——手机、地铁、和朋友闲聊这些事，比空讲道理好懂。",
        refined_summary: "材料在写这个时代的日常：忙、碎、但还能跟人说几句实话。",
        open_questions: ["下次想再看看城市生活那篇，对照一下自己的节奏。"],
        felt_intensity: 0.55,
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
      const qMatch =
        input.user.match(/open=\[?"([^"\]]{4,80})"/) ||
        input.user.match(/当前最咬人的问题：([^\n（]+)/);
      const threadId = threadMatch?.[1];
      const path = pathMatch?.[1];
      const openQ = qMatch?.[1]?.trim() || "我想搞懂最近卡住的那件事";
      const canSay = /can_say=true/i.test(input.user);
      const noUnread = /（none unread）|\(none unread\)|无未读/i.test(input.user);
      const intents: Record<string, unknown>[] = [
        {
          kind: "think",
          title: `想清楚：${openQ.slice(0, 40)}`,
          thread_id: threadId,
          hints: {
            mode: "ruminate",
            open_questions: [openQ],
            why: "被这个问题勾住",
          },
        },
        {
          kind: "think",
          title: `随手记：${openQ.slice(0, 36)}`,
          thread_id: threadId,
          hints: {
            mode: "note",
            open_questions: [openQ],
            why: "主动记一笔，不是读后交差",
          },
        },
      ];
      // Optional read only when there is a path and we have a question to serve
      if (path && !noUnread) {
        intents.push({
          kind: "read",
          title: `为问题翻：${path}`,
          hints: {
            paths: [path],
            open_questions: [openQ],
            why: `推进：${openQ.slice(0, 80)}`,
          },
        });
      }
      intents.push(
        {
          kind: "organize",
          title: "快速收拾记忆",
        },
        {
          kind: "seek",
          title: "以后想查相关背景",
          hints: {
            query: openQ.slice(0, 80),
            why: "先记下愿望，外面还查不了",
            open_questions: [openQ],
          },
        },
      );
      // Optional proactive say: only when allowed and no recent dialogue
      if (
        canSay &&
        /（暂无对话）|尚无记录/.test(input.user) &&
        !/上次主动找用户说：20/.test(input.user)
      ) {
        intents.push({
          kind: "say",
          title: "想把这个问题轻轻抛给对方",
          hints: { why: `好奇：${openQ.slice(0, 60)}` },
        });
      }
      return JSON.stringify({
        planning_note: canSay
          ? `最咬人的是「${openQ.slice(0, 40)}」。先想、记一笔；若合适再跟朋友说一声。`
          : `最咬人的是「${openQ.slice(0, 40)}」。先想、记一笔；有材料再翻，不打卡式读库。`,
        intents,
      });
    }
    // Note-mode think
    if (/mode=note|主动写一笔笔记|agenda_think_note/i.test(input.system + input.user)) {
      return JSON.stringify({
        monologue:
          "记一笔：我不是在完成阅读任务，是真的卡在这个问题上。先把疑问写清楚，以后再决定要不要翻书架。",
        refined_summary: "主动笔记：问题比未读文件更优先。",
        open_questions: ["我真正想搞懂的是什么？", "有没有不必读库也能想的角度？"],
        felt_intensity: 0.45,
      });
    }
    // Proactive say act
    if (/主动找用户说一句|proactive say|执行一条「主动/i.test(input.system + input.user)) {
      return JSON.stringify({
        reply: "在不在？我刚自己待了一会儿，突然想问你今天顺不顺。",
        share: { opened: false, reason: "就打个招呼" },
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
