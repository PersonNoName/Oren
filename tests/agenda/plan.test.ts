import { describe, expect, it } from "vitest";
import { materializeAgenda, parsePlanArtifact } from "../../src/agenda/plan.js";
import {
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type LifeState,
} from "../../src/types.js";

describe("agenda plan", () => {
  it("parses plan JSON", () => {
    const p = parsePlanArtifact(
      JSON.stringify({
        planning_note: "hi",
        intents: [
          { kind: "think", title: "ponder" },
          { kind: "seek", title: "look up X", hints: { query: "X" } },
        ],
      }),
    );
    expect(p.intents).toHaveLength(2);
    expect(p.intents[1]!.kind).toBe("seek");
  });

  it("blocks seek when not authorized", () => {
    const state: LifeState = {
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
    const agenda = materializeAgenda({
      parsed: {
        planning_note: "n",
        intents: [
          { kind: "think", title: "a" },
          { kind: "seek", title: "b", hints: { query: "q" } },
          { kind: "idle", title: "c" },
        ],
      },
      now: "t",
      config: state.config,
      state,
      unreadPaths: [],
      allowSeek: true,
      canSeek: false,
    });
    const seek = Object.values(agenda.intents).find((i) => i.kind === "seek");
    expect(seek?.status).toBe("blocked");
    expect(seek?.blocked_reason).toBe("seek_not_authorized");
  });
});
