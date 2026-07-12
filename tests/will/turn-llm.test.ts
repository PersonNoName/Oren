import { describe, expect, it } from "vitest";
import { FakeLlmCompleter } from "../../src/llm/fake.js";
import {
  defaultAffect,
  defaultConfig,
  defaultRelation,
  defaultTaste,
  defaultWill,
  type LifeState,
} from "../../src/types.js";
import { runWillTurn } from "../../src/will/turn.js";

function minimalState(): LifeState {
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

describe("runWillTurn", () => {
  it("uses FakeLlm auto-shape: curt for 嗯", async () => {
    const llm = new FakeLlmCompleter().enableAutoShape();
    const now = "2026-07-12T00:00:00.000Z";
    const result = await runWillTurn({
      llm,
      will: defaultWill(now),
      state: minimalState(),
      userText: "嗯",
      seepage: [],
      relation: defaultRelation(now),
      now,
    });
    expect(result.failed).toBe(false);
    expect(result.turn.turn_moves).toEqual(["curt", "acknowledge"]);
    expect(result.turn.share_allowed).toBe(false);
    expect(result.will.last_reason).toBeTruthy();
    expect(llm.callCount).toBe(1);
  });

  it("uses FakeLlm auto-shape: follow+acknowledge for normal text", async () => {
    const llm = new FakeLlmCompleter().enableAutoShape();
    const now = "2026-07-12T00:00:00.000Z";
    const result = await runWillTurn({
      llm,
      will: defaultWill(now),
      state: minimalState(),
      userText: "今天想聊聊注意力的事",
      seepage: [],
      relation: defaultRelation(now),
      now,
    });
    expect(result.failed).toBe(false);
    expect(result.turn.turn_moves).toEqual(["follow", "acknowledge"]);
    expect(result.turn.share_allowed).toBe(false);
  });

  it("on parse failure uses safeFallbackTurn and failed=true", async () => {
    const now = "2026-07-12T00:00:00.000Z";
    const broken = {
      async complete() {
        return "<<<no json>>>";
      },
    };
    const result = await runWillTurn({
      llm: broken,
      will: defaultWill(now),
      state: minimalState(),
      userText: "嗯",
      seepage: [],
      relation: defaultRelation(now),
      now,
    });
    expect(result.failed).toBe(true);
    expect(result.raw).toBe("");
    expect(result.turn.turn_moves).toEqual(["curt", "acknowledge"]);
    expect(result.turn.share_allowed).toBe(false);
  });

  it("strips share when share_allowed is false; clears share_allowed without share move", async () => {
    const now = "2026-07-12T00:00:00.000Z";
    const stripShare = {
      async complete() {
        return JSON.stringify({
          turn_moves: ["follow", "share"],
          share_allowed: false,
          reason: "inconsistent share",
        });
      },
    };
    const a = await runWillTurn({
      llm: stripShare,
      will: defaultWill(now),
      state: minimalState(),
      userText: "说说你在读什么",
      seepage: [],
      relation: defaultRelation(now),
      now,
    });
    expect(a.failed).toBe(false);
    expect(a.turn.turn_moves).not.toContain("share");
    expect(a.turn.share_allowed).toBe(false);

    const clearFlag = {
      async complete() {
        return JSON.stringify({
          turn_moves: ["follow", "acknowledge"],
          share_allowed: true,
          reason: "allowed without move",
        });
      },
    };
    const b = await runWillTurn({
      llm: clearFlag,
      will: defaultWill(now),
      state: minimalState(),
      userText: "说说你在读什么",
      seepage: [],
      relation: defaultRelation(now),
      now,
    });
    expect(b.failed).toBe(false);
    expect(b.turn.share_allowed).toBe(false);
    expect(b.turn.turn_moves).toEqual(["follow", "acknowledge"]);
  });
});
