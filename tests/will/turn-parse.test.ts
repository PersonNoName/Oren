// tests/will/turn-parse.test.ts
import { describe, expect, it } from "vitest";
import { parseWillTurn } from "../../src/will/parse-turn.js";
import { applyWillTurnPatch, safeFallbackTurn } from "../../src/will/apply-turn.js";
import { defaultWill } from "../../src/types.js";

describe("parseWillTurn", () => {
  it("parses moves and patch", () => {
    const t = parseWillTurn(
      JSON.stringify({
        turn_moves: ["follow", "acknowledge"],
        share_allowed: false,
        toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
        reason: "user curt",
      }),
    );
    expect(t.turn_moves).toEqual(["follow", "acknowledge"]);
    expect(t.share_allowed).toBe(false);
  });

  it("rejects empty moves by filling follow+acknowledge", () => {
    const t = parseWillTurn(JSON.stringify({ turn_moves: [] }));
    expect(t.turn_moves.length).toBeGreaterThan(0);
  });

  it("filters invalid moves and caps at 4", () => {
    const t = parseWillTurn(
      JSON.stringify({
        turn_moves: ["follow", "bogus", "ask", "weave", "lead", "share", "care"],
        share_allowed: true,
      }),
    );
    expect(t.turn_moves).toEqual(["follow", "ask", "weave", "lead"]);
    expect(t.share_allowed).toBe(true);
  });

  it("when curt present, keeps only curt/acknowledge/follow", () => {
    const t = parseWillTurn(
      JSON.stringify({
        turn_moves: ["curt", "lead", "share", "acknowledge", "follow", "ask"],
      }),
    );
    expect(t.turn_moves).toEqual(["curt", "acknowledge", "follow"]);
  });

  it("parses JSON embedded in surrounding text", () => {
    const t = parseWillTurn('prefix {"turn_moves":["ask"],"share_allowed":true} suffix');
    expect(t.turn_moves).toEqual(["ask"]);
    expect(t.share_allowed).toBe(true);
  });
});

describe("applyWillTurnPatch", () => {
  it("updates toward_user", () => {
    const w = defaultWill("t");
    const next = applyWillTurnPatch(
      w,
      {
        turn_moves: ["curt"],
        share_allowed: false,
        toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
        reason: "cold",
      },
      "t",
    );
    expect(next.toward_user.posture).toBe("quiet");
    expect(next.last_reason).toContain("cold");
  });
});

describe("safeFallbackTurn", () => {
  it("uses curt+acknowledge for short or filler text", () => {
    expect(safeFallbackTurn("嗯").turn_moves).toEqual(["curt", "acknowledge"]);
    expect(safeFallbackTurn("ok").turn_moves).toEqual(["curt", "acknowledge"]);
    expect(safeFallbackTurn("随便").turn_moves).toEqual(["curt", "acknowledge"]);
  });

  it("uses follow+acknowledge otherwise", () => {
    const t = safeFallbackTurn("今天天气怎么样？");
    expect(t.turn_moves).toEqual(["follow", "acknowledge"]);
    expect(t.share_allowed).toBe(false);
  });
});
