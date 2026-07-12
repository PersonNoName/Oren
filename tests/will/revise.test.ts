import { describe, expect, it } from "vitest";
import type { LlmCompleter } from "../../src/llm/types.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  defaultWill,
  type LifeState,
} from "../../src/types.js";
import { reviseWill } from "../../src/will/revise.js";

function fakePlanLlm(planJson: object): LlmCompleter {
  return {
    complete: async () => JSON.stringify(planJson),
  };
}

function emptyState(): LifeState {
  return {
    meta: {
      oren_id: "o",
      schema_version: 1,
      created_at: "t",
      last_tick_at: null,
      tick_count: 0,
    },
    config: defaultConfig(),
    taste: defaultTaste("t"),
    affect: defaultAffect("t"),
    threads: {},
  };
}

describe("reviseWill", () => {
  it("assigns session from plan and updates solitude note", async () => {
    const now = "2026-07-12T00:00:00.000Z";
    const will = defaultWill(now);
    const result = await reviseWill({
      will,
      state: emptyState(),
      index: { docs: [], updated_at: now },
      llm: fakePlanLlm({
        planning_note: "先想想再说",
        intents: [
          { kind: "think", title: "想一想" },
          { kind: "idle", title: "休息" },
          { kind: "organize", title: "整理" },
        ],
      }),
      now,
      unreadPaths: [],
      canSeek: false,
    });

    expect(result.will.session.planning_note).toBe("先想想再说");
    expect(result.will.solitude.note).toBe("先想想再说");
    expect(result.will.last_reason).toBe("先想想再说");
    expect(result.will.updated_at).toBe(now);
    expect(result.will.session.queue.length).toBeGreaterThanOrEqual(3);
    expect(result.will.toward_user.posture).toBe("quiet");
    expect(result.will.toward_user.share_drive).toBe("low");
  });

  it("bumps toward_user when plan has pending say", async () => {
    const now = "2026-07-12T00:00:00.000Z";
    const will = defaultWill(now);
    const result = await reviseWill({
      will,
      state: emptyState(),
      index: { docs: [], updated_at: now },
      llm: fakePlanLlm({
        planning_note: "想跟用户打个招呼",
        intents: [
          { kind: "say", title: "轻轻问一句近况", hints: { why: "太久没聊" } },
          { kind: "think", title: "想一想" },
          { kind: "idle", title: "休息" },
        ],
      }),
      now,
      unreadPaths: [],
      canSeek: false,
      canSay: true,
    });

    const say = Object.values(result.will.session.intents).find(
      (i) => i.kind === "say",
    );
    expect(say?.status).toBe("pending");
    expect(result.will.toward_user.posture).toBe("soft_check");
    expect(result.will.toward_user.share_drive).toBe("mid");
  });
});
