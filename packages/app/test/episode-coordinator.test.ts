import { describe, expect, it } from "vitest";
import type {
  CognitionEvent,
  StreamingCognitionPort,
} from "@oren/cognition";
import type {
  ForegroundSpeechPort,
  SpeechEvent,
} from "@oren/channel";
import {
  Conductor,
} from "@oren/cognition";
import {
  createInitialLifeState,
  Guard,
  LifeActor,
  reduceLifeState,
  type CognitionJob,
  type EventEnvelope,
  type LifeRepositoryPort,
} from "@oren/kernel";
import { EpisodeCoordinator } from "../src/index.js";

describe("episode lifecycle coordinator", () => {
  it("delivers foreground speech and completes without a commit", async () => {
    const harness = actorHarness();
    const speech = speechHarness();
    const cognition = scripted([
      { type: "speech.started", utteranceId: "message-1" },
      { type: "speech.delta", utteranceId: "message-1", text: "你好" },
      { type: "speech.completed", utteranceId: "message-1" },
      {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 3 },
      },
    ]);
    const coordinator = coordinatorFor(harness, cognition, speech.port);

    await coordinator.run(job("foreground_user"), new AbortController().signal);

    expect(speech.events).toEqual([
      {
        type: "speech.started",
        episodeId: "episode-1",
        messageId: "message-1",
      },
      { type: "speech.delta", messageId: "message-1", text: "你好" },
      {
        type: "speech.completed",
        messageId: "message-1",
        status: "complete",
      },
    ]);
    expect(harness.events.map(({ payload }) => payload.type)).toEqual([
      "AssistantMessageDelivered",
      "CognitionCompleted",
    ]);
  });

  it("keeps delivered speech when a later commit is rejected", async () => {
    const harness = actorHarness(true);
    const speech = speechHarness();
    const cognition: StreamingCognitionPort = {
      stream(_frame, handlers) {
        return (async function* (): AsyncIterable<CognitionEvent> {
          yield { type: "speech.started", utteranceId: "message-1" };
          yield { type: "speech.delta", utteranceId: "message-1", text: "先回答。" };
          yield { type: "speech.completed", utteranceId: "message-1" };
          const receipt = await handlers.submitCommit({
            commitId: "commit-1",
            proposals: [{
              type: "AdvanceThread",
              threadId: "thread-1",
              summary: "later",
            }],
          }, new AbortController().signal);
          yield { type: "commit.resolved", receipt };
          yield {
            type: "episode.completed",
            reason: "stop",
            usage: { totalTokens: 4 },
          };
        })();
      },
    };
    const coordinator = coordinatorFor(harness, cognition, speech.port);

    await coordinator.run(job("foreground_user"), new AbortController().signal);

    expect(harness.events.map(({ payload }) => payload.type)).toEqual([
      "AssistantMessageDelivered",
      "CognitionCommitRejected",
      "CognitionCompleted",
    ]);
  });

  it("records partial foreground speech as interrupted on abort", async () => {
    const harness = actorHarness();
    const speech = speechHarness();
    const coordinator = coordinatorFor(harness, scripted([
      { type: "speech.started", utteranceId: "message-1" },
      { type: "speech.delta", utteranceId: "message-1", text: "说到一半" },
      { type: "episode.aborted", usage: { totalTokens: 2 } },
    ]), speech.port);

    await coordinator.run(job("foreground_user"), new AbortController().signal);

    expect(speech.events.at(-1)).toEqual({
      type: "speech.completed",
      messageId: "message-1",
      status: "interrupted",
    });
    expect(harness.events.map(({ payload }) => payload.type)).toEqual([
      "AssistantMessageDelivered",
      "EpisodeInterrupted",
    ]);
    expect(harness.events[0]?.payload).toMatchObject({ status: "interrupted" });
  });

  it("suppresses raw background speech", async () => {
    const harness = actorHarness();
    const speech = speechHarness();
    const coordinator = coordinatorFor(harness, scripted([
      { type: "speech.started", utteranceId: "private-1" },
      { type: "speech.delta", utteranceId: "private-1", text: "不应直接展示" },
      { type: "speech.completed", utteranceId: "private-1" },
      {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 3 },
      },
    ]), speech.port);

    await coordinator.run(job("effect_result"), new AbortController().signal);

    expect(speech.events).toEqual([]);
    expect(harness.events.map(({ payload }) => payload.type)).toEqual([
      "CognitionCompleted",
    ]);
  });

  it("fails malformed speech ordering instead of persisting a blank message", async () => {
    const harness = actorHarness();
    const speech = speechHarness();
    const coordinator = coordinatorFor(harness, scripted([
      { type: "speech.delta", utteranceId: "missing", text: "orphan" },
      {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 1 },
      },
    ]), speech.port);

    await coordinator.run(job("foreground_user"), new AbortController().signal);

    expect(speech.events).toEqual([]);
    expect(harness.events.map(({ payload }) => payload.type)).toEqual([
      "CognitionFailed",
    ]);
  });
});

function job(triggerKind: CognitionJob["triggerKind"]): CognitionJob {
  return {
    orenId: "oren-1",
    episodeId: "episode-1",
    baseStateVersion: 2,
    triggerKind,
    correlationId: "corr-1",
  };
}

function scripted(events: readonly CognitionEvent[]): StreamingCognitionPort {
  return {
    stream() {
      return (async function* (): AsyncIterable<CognitionEvent> {
        for (const event of events) yield event;
      })();
    },
  };
}

function speechHarness(): {
  readonly events: SpeechEvent[];
  readonly port: ForegroundSpeechPort;
} {
  const events: SpeechEvent[] = [];
  return {
    events,
    port: {
      async startSpeech(input) {
        events.push({ type: "speech.started", ...input });
      },
      async appendSpeech(input) {
        events.push({ type: "speech.delta", ...input });
      },
      async completeSpeech(input) {
        events.push({ type: "speech.completed", ...input });
      },
    },
  };
}

function actorHarness(rejectFirstCommit = false) {
  let state = {
    ...createInitialLifeState("oren-1", "person-1"),
    version: 2,
  };
  const events: EventEnvelope[] = [];
  let rejected = false;
  const apply = (accepted: readonly EventEnvelope[]) => {
    events.push(...accepted);
    state = accepted.reduce(reduceLifeState, state);
  };
  const repository: LifeRepositoryPort = {
    loadState: () => state,
    loadEvents: () => events,
    commit: (_orenId, accepted) => apply(accepted),
    commitIfVersion: (_orenId, expectedVersion, accepted) => {
      if (
        rejectFirstCommit
        && !rejected
        && accepted[0]?.payload.type === "CognitionCommitAccepted"
      ) {
        rejected = true;
        return false;
      }
      if (state.version !== expectedVersion) return false;
      apply(accepted);
      return true;
    },
    commitInbox: () => false,
    commitDeliverInbox: () => false,
  };
  let id = 0;
  return {
    actor: new LifeActor(
      repository,
      () => `event-${++id}`,
      () => "2026-07-26T00:00:00.000Z",
    ),
    events,
    get state() {
      return state;
    },
  };
}

function coordinatorFor(
  harness: ReturnType<typeof actorHarness>,
  cognition: StreamingCognitionPort,
  speech: ForegroundSpeechPort,
): EpisodeCoordinator {
  return new EpisodeCoordinator(
    cognition,
    new Conductor(),
    harness.actor,
    new Guard(),
    (candidate) => ({
      state: harness.state,
      correlationId: candidate.correlationId,
      trigger: { kind: candidate.triggerKind, summary: "test" },
      capabilities: [],
      maxSteps: 8,
    }),
    { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
    speech,
  );
}
