import { describe, expect, it } from "vitest";
import {
  enforceExpressConstraints,
  stanceFromMoves,
} from "../../src/dialogue/express-constraints.js";
import type { DialogueReplyArtifact } from "../../src/types.js";

function base(over: Partial<DialogueReplyArtifact> = {}): DialogueReplyArtifact {
  return {
    reply: "hello",
    utterances: ["hello"],
    stance: "lead",
    share: { opened: true, kind: "think", snippet: "x" },
    ...over,
  };
}

describe("enforceExpressConstraints", () => {
  it("blocks share when not allowed", () => {
    const a = enforceExpressConstraints(base(), {
      turn_moves: ["follow"],
      share_allowed: false,
    });
    expect(a.share.opened).toBe(false);
  });

  it("blocks share when share move missing even if allowed", () => {
    const a = enforceExpressConstraints(base(), {
      turn_moves: ["follow"],
      share_allowed: true,
    });
    expect(a.share.opened).toBe(false);
  });

  it("allows share when move present and allowed", () => {
    const a = enforceExpressConstraints(base(), {
      turn_moves: ["follow", "share"],
      share_allowed: true,
    });
    expect(a.share.opened).toBe(true);
  });

  it("downgrades lead when move missing", () => {
    const a = enforceExpressConstraints(base({ stance: "lead" }), {
      turn_moves: ["follow", "acknowledge"],
      share_allowed: false,
    });
    expect(a.stance).toBe("follow");
  });

  it("sets weave stance from weave move", () => {
    const a = enforceExpressConstraints(base({ stance: "follow" }), {
      turn_moves: ["weave", "acknowledge"],
      share_allowed: false,
    });
    expect(a.stance).toBe("weave");
  });

  it("sets lead stance from lead move", () => {
    const a = enforceExpressConstraints(base({ stance: "follow" }), {
      turn_moves: ["lead", "share"],
      share_allowed: true,
    });
    expect(a.stance).toBe("lead");
  });

  it("curtails bubbles when curt", () => {
    const a = enforceExpressConstraints(
      base({ utterances: ["a", "b", "c"], reply: "a" }),
      { turn_moves: ["curt"], share_allowed: false },
    );
    expect(a.utterances.length).toBeLessThanOrEqual(1);
    expect(a.stance).toBe("follow");
    expect(a.share.opened).toBe(false);
  });
});

describe("stanceFromMoves", () => {
  it("prefers lead over weave over follow", () => {
    expect(stanceFromMoves(["lead", "weave"])).toBe("lead");
    expect(stanceFromMoves(["weave", "follow"])).toBe("weave");
    expect(stanceFromMoves(["follow", "acknowledge"])).toBe("follow");
    expect(stanceFromMoves([])).toBe("follow");
  });
});
