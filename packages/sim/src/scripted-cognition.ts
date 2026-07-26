import {
  ScriptedCognitionAdapter,
  type CognitionOutcome,
  type CognitionPort,
  type LifeFrame,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";

export type CognitionTurn =
  | { readonly proposals: readonly Proposal[] }
  | { readonly outcome: CognitionOutcome }
  | {
      readonly when: (frame: LifeFrame) => boolean;
      readonly proposals?: readonly Proposal[];
      readonly outcome?: CognitionOutcome;
    };

function turnMatches(turn: CognitionTurn, frame: LifeFrame): boolean {
  if ("when" in turn) {
    return turn.when(frame);
  }
  return true;
}

function turnToOutcome(turn: CognitionTurn): CognitionOutcome {
  if ("outcome" in turn && turn.outcome !== undefined) {
    return turn.outcome;
  }
  if ("proposals" in turn && turn.proposals !== undefined) {
    return {
      kind: "completed",
      proposals: turn.proposals,
      usage: { totalTokens: 0 },
    };
  }
  return {
    kind: "completed",
    proposals: [{ type: "NoAction", reason: "empty turn" }],
    usage: { totalTokens: 0 },
  };
}

function exhaustedOutcome(mode: "no_action" | "fail"): CognitionOutcome {
  if (mode === "fail") {
    return {
      kind: "failed",
      message: "Sequenced cognition script exhausted",
      usage: { totalTokens: 0 },
    };
  }
  return {
    kind: "completed",
    proposals: [{ type: "NoAction", reason: "script exhausted" }],
    usage: { totalTokens: 0 },
  };
}

export function createSequencedCognition(
  turns: readonly CognitionTurn[],
  options?: { readonly exhaust?: "no_action" | "fail" },
): CognitionPort {
  const exhaust = options?.exhaust ?? "no_action";
  let nextIndex = 0;

  return new ScriptedCognitionAdapter(async (frame) => {
    for (let i = nextIndex; i < turns.length; i += 1) {
      const turn = turns[i]!;
      if (!turnMatches(turn, frame)) {
        continue;
      }
      nextIndex = i + 1;
      return turnToOutcome(turn);
    }
    return exhaustedOutcome(exhaust);
  });
}
