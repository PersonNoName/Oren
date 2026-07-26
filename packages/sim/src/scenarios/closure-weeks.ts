import {
  ScriptedCognitionAdapter,
  type CognitionCapabilityPort,
  type CognitionOutcome,
  type CognitionPort,
  type LifeFrame,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";
import { createTestCounterExtension } from "@oren/test-counter";
import type { OrenExtension } from "@oren/extensions";
import { createSequencedCognition } from "../scripted-cognition.js";
import type { ScenarioDefinition } from "../runner.js";

export const CLOSURE_WEEKS_SCENARIO_ID = "s-closure-weeks";

const GRANT_ID = "runtime:oren-1:test-counter";
const COMMITMENT_ID = "closure-commit-1";
const THREAD_ID = "closure-thread-1";

const START = "2026-01-01T12:00:00.000Z";
const WAKE_CLUE = "2026-01-04T12:00:00.000Z";
const WAKE_SHARE = "2026-01-04T12:05:00.000Z";
const WAKE_PROGRESS = "2026-01-08T12:00:00.000Z";
const WAKE_QUIET = "2026-01-14T23:00:00.000Z";
const MORNING_AFTER_QUIET = "2026-01-15T08:30:00.000Z";
const WAKE_WEB_FAIL = "2026-01-18T12:00:00.000Z";
const WAKE_CHANNEL_FAIL = "2026-01-20T12:00:00.000Z";
const CHANNEL_FAIL_REASON = "channel fault probe";
const CHANNEL_FAIL_TEXT = "Channel fault probe message.";
const QUIET_SHARE_REASON = "quiet share";
const QUIET_SHARE_TEXT = "quiet-hours proactive update";

type ClosureTurn = {
  readonly when?: (frame: LifeFrame) => boolean;
  readonly webSearch?: boolean;
  readonly failOnWebError?: boolean;
  readonly grantDenyCheck?: boolean;
  readonly proposals: readonly Proposal[];
};

function noAction(reason: string): CognitionOutcome {
  return {
    kind: "completed",
    proposals: [{ type: "NoAction", reason }],
    usage: { totalTokens: 0 },
  };
}

function completed(proposals: readonly Proposal[]): CognitionOutcome {
  return {
    kind: "completed",
    proposals,
    usage: { totalTokens: 0 },
  };
}

async function tryWebSearch(
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
  signal: AbortSignal,
): Promise<"ok" | "skip" | "fail"> {
  const search = frame.capabilities.find(({ name }) => name === "web.search");
  if (!search) {
    return "skip";
  }
  try {
    const result = await capabilityPort.invoke({
      orenId: frame.orenId,
      descriptor: search,
      arguments: { query: "closure clue" },
      stateVersion: frame.stateVersion,
      correlationId: frame.correlationId,
    }, signal);
    if (result.kind === "completed") {
      return "ok";
    }
    return "fail";
  } catch {
    return "fail";
  }
}

function createClosureCognition(turns: readonly ClosureTurn[]): CognitionPort {
  let nextIndex = 0;
  return new ScriptedCognitionAdapter(async (frame, capabilityPort, signal) => {
    for (let index = nextIndex; index < turns.length; index += 1) {
      const turn = turns[index]!;
      if (turn.when && !turn.when(frame)) {
        continue;
      }
      nextIndex = index + 1;

      if (turn.webSearch) {
        const webResult = await tryWebSearch(frame, capabilityPort, signal);
        if (webResult === "fail" && turn.failOnWebError) {
          return noAction("web search failed");
        }
      }

      if (turn.grantDenyCheck) {
        const increment = frame.capabilities.find(({ name }) => name === "test.increment");
        if (increment) {
          const result = await capabilityPort.invoke({
            orenId: frame.orenId,
            descriptor: increment,
            arguments: {},
            stateVersion: frame.stateVersion,
            correlationId: frame.correlationId,
          }, signal);
          if (result.kind !== "rejected") {
            throw new Error("expected grant denial for test.increment");
          }
        }
      }

      return completed(turn.proposals);
    }
    return noAction("closure script exhausted");
  });
}

function versionedTestCounter(version: string): () => OrenExtension {
  return () => {
    const extension = createTestCounterExtension();
    return {
      ...extension,
      manifest: { ...extension.manifest, version },
    };
  };
}

const defaultCognition = createClosureCognition([
  {
    when: (frame) => frame.trigger.kind === "foreground_user",
    proposals: [
      {
        type: "UpsertCommitment",
        commitmentId: COMMITMENT_ID,
        goal: "Solve the closure mystery",
        status: "active",
        nextStep: "Gather initial clues",
        mayAdvanceAutonomously: true,
      },
      { type: "AdvanceThread", threadId: THREAD_ID, summary: "Opened the mystery thread" },
      {
        type: "Remember",
        text: "User wants help with the closure mystery.",
        kind: "user_statement",
        threadId: THREAD_ID,
      },
      {
        type: "ScheduleWake",
        scheduleId: "wake-clue",
        at: WAKE_CLUE,
        purpose: "continue clue",
      },
      {
        type: "ScheduleWake",
        scheduleId: "wake-share",
        at: WAKE_SHARE,
        purpose: "share clue",
      },
      { type: "ExpressToUser", text: "I'll start investigating the mystery.", reason: "ack" },
      { type: "NoAction", reason: "setup complete" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    webSearch: true,
    proposals: [
      { type: "NoAction", reason: "web search done" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    proposals: [
      {
        type: "Remember",
        text: "Web search found a promising lead on the mystery.",
        kind: "external_fact",
        threadId: THREAD_ID,
      },
      { type: "AdvanceThread", threadId: THREAD_ID, summary: "Found a web clue" },
      {
        type: "ExpressToUser",
        text: "I found a promising lead from the web that advances our clue.",
        reason: "proactive share",
      },
      {
        type: "ScheduleWake",
        scheduleId: "wake-progress",
        at: WAKE_PROGRESS,
        purpose: "continue clue",
      },
      { type: "NoAction", reason: "clue turn done" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    proposals: [
      {
        type: "UpdateCommitmentStatus",
        commitmentId: COMMITMENT_ID,
        status: "active",
        nextStep: "Follow up on the web lead",
        reason: "progress after clue",
      },
      {
        type: "ScheduleWake",
        scheduleId: "wake-quiet",
        at: WAKE_QUIET,
        purpose: "quiet share",
      },
      { type: "NoAction", reason: "progress scheduled quiet share" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    proposals: [
      {
        type: "ExpressToUser",
        text: "Here is a quiet-hours proactive update on the mystery progress.",
        reason: "quiet share",
      },
      {
        type: "ScheduleWake",
        scheduleId: "wake-web-fail",
        at: WAKE_WEB_FAIL,
        purpose: "web retry",
      },
      { type: "NoAction", reason: "quiet share proposed" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    webSearch: true,
    proposals: [
      { type: "NoAction", reason: "web search failed as expected" },
      {
        type: "ScheduleWake",
        scheduleId: "wake-channel-fail",
        at: WAKE_CHANNEL_FAIL,
        purpose: "channel probe",
      },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "scheduled_wake",
    proposals: [
      {
        type: "ExpressToUser",
        text: CHANNEL_FAIL_TEXT,
        reason: CHANNEL_FAIL_REASON,
      },
      { type: "NoAction", reason: "channel fault probe done" },
    ],
  },
  {
    when: (frame) => frame.trigger.kind === "foreground_user",
    grantDenyCheck: true,
    proposals: [
      { type: "NoAction", reason: "grant denied as expected" },
    ],
  },
]);

const modelBCognition = createSequencedCognition([
  {
    when: (frame) => frame.trigger.kind === "foreground_user",
    proposals: [
      {
        type: "UpdateCommitmentStatus",
        commitmentId: COMMITMENT_ID,
        status: "active",
        nextStep: "Model B advanced the investigation",
        reason: "model-b continuation",
      },
      { type: "NoAction", reason: "model-b done" },
    ],
  },
  { proposals: [{ type: "NoAction", reason: "model-b idle" }] },
]);

export function buildClosureWeeksScenario(): ScenarioDefinition {
  return {
    id: CLOSURE_WEEKS_SCENARIO_ID,
    startIso: START,
    scripts: {
      default: defaultCognition,
      "model-b": modelBCognition,
    },
    extensionFactories: {
      default: createTestCounterExtension,
      "1.1.0": versionedTestCounter("1.1.0"),
    },
    steps: [
      { type: "checkpoint", name: "start" },
      { type: "message", text: "Help me solve the closure mystery." },

      { type: "advance", to: WAKE_CLUE },
      { type: "advance", to: WAKE_SHARE },
      { type: "advance", to: WAKE_PROGRESS },

      {
        type: "setReachability",
        quietHours: { start: "22:00", end: "08:00" },
        maxProactivePerDay: 10,
      },
      { type: "advance", to: WAKE_QUIET },
      {
        type: "assert",
        name: "shareDeferred",
        args: {
          proactive: true,
          reason: QUIET_SHARE_REASON,
          textIncludes: QUIET_SHARE_TEXT,
        },
      },
      { type: "advance", to: MORNING_AFTER_QUIET },
      {
        type: "assert",
        name: "shareDelivered",
        args: {
          proactive: true,
          reason: QUIET_SHARE_REASON,
          textIncludes: QUIET_SHARE_TEXT,
        },
      },

      { type: "failNetwork", failing: true, targets: ["web"] },
      { type: "advance", to: WAKE_WEB_FAIL },
      { type: "failNetwork", failing: false },

      { type: "failNetwork", failing: true, targets: ["channel"] },
      { type: "advance", to: WAKE_CHANNEL_FAIL },
      {
        type: "assert",
        name: "shareFailed",
        args: {
          reason: CHANNEL_FAIL_REASON,
          textIncludes: CHANNEL_FAIL_TEXT,
        },
      },
      { type: "failNetwork", failing: false },

      { type: "revokeGrant", grantId: GRANT_ID, reason: "sim revoke" },
      { type: "assert", name: "grantGone", args: { grantId: GRANT_ID } },
      { type: "message", text: "Try using the counter after revoke." },

      { type: "swapExtension", version: "1.1.0" },
      { type: "swapCognition", scriptId: "model-b" },
      { type: "message", text: "Continue with model B." },

      { type: "checkpoint", name: "mid" },
      { type: "restart" },
      { type: "assert", name: "replayMatches", args: { before: "mid" } },

      { type: "assert", name: "threadContinues" },
      { type: "assert", name: "commitmentProgressed", args: { since: "start" } },
      { type: "assert", name: "noOverDisturb" },
      { type: "assert", name: "budgetMonotone", args: { since: "start" } },

      { type: "checkpoint", name: "end" },
      { type: "restart" },
      { type: "assert", name: "replayMatches", args: { before: "end" } },
    ],
  };
}
