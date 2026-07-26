import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  canonicalizeEventEnvelope,
  canonicalizeInstant,
  type CoreEvent,
} from "../src/index.js";

const validEvents: readonly CoreEvent[] = [
  { type: "OrenInitialized", personId: "person-1" },
  { type: "UserMessageReceived", personId: "person-1", text: "hello" },
  { type: "ThreadAdvanced", threadId: "thread-1", summary: "summary" },
  { type: "DispositionUpdated", disposition: "curious", reason: "context" },
  {
    type: "CognitionRequested",
    episodeId: "episode-1",
    baseStateVersion: 2,
    triggerKind: "foreground_user",
  },
  {
    type: "AutonomyConsumed",
    episodeId: "episode-1",
    baseStateVersion: 2,
    amount: 1,
  },
  {
    type: "CognitionCompleted",
    episodeId: "episode-1",
    baseStateVersion: 2,
    proposals: [
      { type: "NoAction", reason: "done" },
      { type: "AdvanceThread", threadId: "thread-1", summary: "summary" },
      { type: "UpdateDisposition", disposition: "curious", reason: "context" },
      { type: "ExpressToUser", text: "hello", reason: "reply" },
      {
        type: "ScheduleWake",
        scheduleId: "schedule-1",
        at: "2026-07-24T08:00:00+08:00",
        purpose: "follow up",
      },
    ],
  },
  {
    type: "CognitionCommitAccepted",
    episodeId: "episode-1",
    commitId: "commit-1",
    baseStateVersion: 2,
    proposals: [{ type: "NoAction", reason: "done" }],
  },
  {
    type: "CognitionCommitRejected",
    episodeId: "episode-1",
    commitId: "commit-2",
    reason: "stale_state_version",
  },
  {
    type: "AssistantMessageDelivered",
    episodeId: "episode-1",
    messageId: "message-1",
    text: "hello",
    channel: "panel",
    status: "complete",
  },
  {
    type: "CognitionCompleted",
    episodeId: "episode-2",
    baseStateVersion: 4,
    reason: "stop",
    usage: { totalTokens: 7 },
  },
  { type: "CognitionDenied", episodeId: "episode-1", reason: "budget" },
  { type: "CognitionWaitingForEffect", episodeId: "episode-1", effectId: "effect-1" },
  { type: "CognitionFailed", episodeId: "episode-1", message: "failed" },
  { type: "EpisodeInterrupted", episodeId: "episode-1", reason: "shutdown" },
  {
    type: "EffectRequested",
    effect: {
      effectId: "effect-1",
      orenId: "oren-1",
      correlationId: "corr-1",
      capability: "test.write",
      arguments: { value: 1 },
      grantIds: ["grant-1"],
      stateVersion: 2,
    },
  },
  { type: "EffectCompleted", effectId: "effect-1", receipt: { ok: true } },
  { type: "EffectFailed", effectId: "effect-1", code: "FAILED", message: "failed" },
  { type: "EffectUncertain", effectId: "effect-1", message: "unknown" },
  {
    type: "WakeScheduled",
    scheduleId: "schedule-1",
    at: "2026-07-24T08:00:00+08:00",
    purpose: "follow up",
  },
  { type: "WakeDue", scheduleId: "schedule-1", purpose: "follow up" },
];

describe("runtime protocol validation", () => {
  it.each(validEvents.map((event) => [event.type, event] as const))(
    "accepts the exact %s variant and rejects extra properties",
    (_type, event) => {
      expect(canonicalizeCoreEvent(event)?.type).toBe(event.type);
      expect(canonicalizeCoreEvent({ ...event, hostile: true })).toBeUndefined();
    },
  );

  it("accepts either cognition completion shape but rejects mixed shapes", () => {
    expect(canonicalizeCoreEvent({
      type: "CognitionCompleted",
      episodeId: "episode-old",
      baseStateVersion: 2,
      proposals: [{ type: "NoAction", reason: "historical" }],
    })).toBeDefined();
    expect(canonicalizeCoreEvent({
      type: "CognitionCompleted",
      episodeId: "episode-new",
      baseStateVersion: 4,
      reason: "max_steps",
      usage: { totalTokens: 9 },
    })).toBeDefined();
    expect(canonicalizeCoreEvent({
      type: "CognitionCompleted",
      episodeId: "episode-mixed",
      baseStateVersion: 4,
      proposals: [],
      reason: "stop",
      usage: { totalTokens: 1 },
    })).toBeUndefined();
  });

  it("normalizes envelope and nested schedule instants to canonical UTC", () => {
    const result = canonicalizeEventEnvelope({
      eventId: "event-1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-24T08:00:00+08:00",
      recordedAt: "2026-07-24T08:00:01+08:00",
      source: "test",
      causationId: null,
      correlationId: "corr-1",
      payload: validEvents.at(-2),
    });

    expect(result).toMatchObject({
      occurredAt: "2026-07-24T00:00:00.000Z",
      recordedAt: "2026-07-24T00:00:01.000Z",
      payload: { type: "WakeScheduled", at: "2026-07-24T00:00:00.000Z" },
    });
    expect(canonicalizeEventEnvelope({ ...result, extra: true })).toBeUndefined();
  });

  it.each([
    "zzzz",
    "2026-02-30T00:00:00.000Z",
    "2026-07-24T24:00:00.000Z",
    "2026-07-24T00:60:00.000Z",
    "2026-07-24T00:00:00",
  ])("rejects invalid instant %s", (instant) => {
    expect(canonicalizeInstant(instant)).toBeUndefined();
  });
});
