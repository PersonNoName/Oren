import { buildAgendaPlan } from "../agenda/plan.js";
import type { CorpusIndex } from "../corpus/index.js";
import type { LlmCompleter } from "../llm/types.js";
import type { LifeState, RelationState, Will } from "../types.js";

/**
 * Will-revise: replan the session agenda and fold the result into Will.
 * Thin wrapper around buildAgendaPlan + session/solitude assign.
 */
export async function reviseWill(input: {
  will: Will;
  state: LifeState;
  index: CorpusIndex;
  llm: LlmCompleter;
  now: string;
  relation?: RelationState | null;
  unreadPaths: string[];
  canSeek: boolean;
  canSay?: boolean;
  dialogueSummary?: string;
  lastProactiveSayAt?: string | null;
}): Promise<{ will: Will; raw: string }> {
  const { agenda, raw } = await buildAgendaPlan({
    state: input.state,
    index: input.index,
    llm: input.llm,
    now: input.now,
    relation: input.relation,
    previous: input.will.session,
    unreadPaths: input.unreadPaths,
    canSeek: input.canSeek,
    canSay: input.canSay,
    dialogueSummary: input.dialogueSummary,
    lastProactiveSayAt: input.lastProactiveSayAt,
  });

  let will: Will = {
    ...input.will,
    updated_at: input.now,
    session: agenda,
    last_reason: agenda.planning_note ?? "revised",
    solitude: {
      ...input.will.solitude,
      note: agenda.planning_note,
    },
  };

  // If plan has a pending say intent, gently lean toward soft outreach.
  if (hasPendingSay(agenda)) {
    will = {
      ...will,
      toward_user: {
        ...will.toward_user,
        posture:
          will.toward_user.posture === "quiet" ||
          will.toward_user.posture === "care"
            ? "soft_check"
            : will.toward_user.posture,
        share_drive:
          will.toward_user.share_drive === "low" ? "mid" : will.toward_user.share_drive,
      },
    };
  }

  return { will, raw };
}

function hasPendingSay(agenda: Will["session"]): boolean {
  return agenda.queue.some((id) => {
    const it = agenda.intents[id];
    return it?.kind === "say" && it.status === "pending";
  });
}
