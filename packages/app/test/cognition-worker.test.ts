import { describe, expect, it } from "vitest";
import { Conductor, type CognitionPort } from "@oren/cognition";
import {
  createInitialLifeState,
  Guard,
  LifeActor,
  reduceLifeState,
  type CognitionJob,
  type EventEnvelope,
  type LifeRepositoryPort,
  type LifeState,
} from "@oren/kernel";
import { CognitionWorker } from "../src/index.js";

describe("CognitionWorker", () => {
  it("durably consumes the exact background autonomy cost before model work", async () => {
    const harness = actorHarness({
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    const observedFrameVersions: number[] = [];
    const cognition: CognitionPort = {
      run: async (frame) => {
        observedFrameVersions.push(frame.stateVersion);
        return { kind: "completed", proposals: [], usage: { totalTokens: 10 } };
      },
    };
    const worker = new CognitionWorker(
      cognition,
      new Conductor(),
      harness.actor,
      new Guard(),
      (job) => ({
        state: harness.state,
        correlationId: job.correlationId,
        trigger: { kind: job.triggerKind, summary: "background check" },
        capabilities: [],
        maxSteps: 3,
      }),
      { invoke: async () => ({ kind: "rejected", reason: "not used" }) },
    );

    await worker.run(job("scheduled_wake"), new AbortController().signal);

    expect(harness.events.map((event) => event.payload)).toEqual([
      {
        type: "AutonomyConsumed",
        episodeId: "episode-1",
        baseStateVersion: 2,
        amount: 3,
      },
      {
        type: "CognitionCompleted",
        episodeId: "episode-1",
        baseStateVersion: 3,
        proposals: [],
      },
    ]);
    expect(observedFrameVersions).toEqual([3]);
    expect(harness.state.budgets.autonomyRemaining).toBe(2);
  });

  it.each(["foreground_user", "effect_result"] as const)(
    "never charges autonomy for %s cognition",
    async (triggerKind) => {
      const harness = actorHarness({
        ...createInitialLifeState("oren-1", "person-1"),
        version: 2,
      });
      const worker = workerFor(harness, async () => ({
        kind: "completed",
        proposals: [],
        usage: { totalTokens: 1 },
      }), 3);

      await worker.run(job(triggerKind), new AbortController().signal);

      expect(harness.events.map((event) => event.payload.type)).toEqual([
        "CognitionCompleted",
      ]);
      expect(harness.state.budgets.autonomyRemaining).toBe(0);
    },
  );

  it("records a guard denial without invoking the model", async () => {
    const harness = actorHarness({
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 2,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    let modelCalls = 0;
    const worker = workerFor(harness, async () => {
      modelCalls += 1;
      return { kind: "completed", proposals: [], usage: { totalTokens: 1 } };
    }, 3);

    await worker.run(job("health_check"), new AbortController().signal);

    expect(modelCalls).toBe(0);
    expect(harness.events.map((event) => event.payload)).toEqual([{
      type: "CognitionDenied",
      episodeId: "episode-1",
      reason: "autonomy_budget_exhausted",
    }]);
  });

  it("cannot consume autonomy twice when the same durable job is retried", async () => {
    const harness = actorHarness({
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    let modelCalls = 0;
    const worker = workerFor(harness, async () => {
      modelCalls += 1;
      return { kind: "completed", proposals: [], usage: { totalTokens: 1 } };
    }, 3);

    await worker.run(job("scheduled_wake"), new AbortController().signal);
    await worker.run(job("scheduled_wake"), new AbortController().signal);

    expect(modelCalls).toBe(1);
    expect(harness.state.budgets.autonomyRemaining).toBe(2);
    expect(harness.events.map((event) => event.payload.type)).toEqual([
      "AutonomyConsumed",
      "CognitionCompleted",
      "CognitionDenied",
    ]);
    expect(harness.events.at(-1)?.payload).toEqual({
      type: "CognitionDenied",
      episodeId: "episode-1",
      reason: "stale_state_version",
    });
  });

  it("durably records waiting, failure, thrown, and interrupted outcomes", async () => {
    const outcomes = [
      {
        run: async () => ({
          kind: "waiting_for_effect" as const,
          effectId: "effect-1",
          usage: { totalTokens: 1 },
        }),
        expected: {
          type: "CognitionWaitingForEffect",
          episodeId: "episode-1",
          effectId: "effect-1",
        },
      },
      {
        run: async () => ({
          kind: "failed" as const,
          message: "model unavailable",
          usage: { totalTokens: 1 },
        }),
        expected: {
          type: "CognitionFailed",
          episodeId: "episode-1",
          message: "model unavailable",
        },
      },
      {
        run: async () => {
          throw new Error("adapter exploded");
        },
        expected: {
          type: "CognitionFailed",
          episodeId: "episode-1",
          message: "adapter exploded",
        },
      },
    ];

    for (const outcome of outcomes) {
      const harness = actorHarness({
        ...createInitialLifeState("oren-1", "person-1"),
        version: 2,
      });
      await workerFor(harness, outcome.run, 1).run(
        job("foreground_user"),
        new AbortController().signal,
      );
      expect(harness.events.at(-1)?.payload).toEqual(outcome.expected);
    }

    const interrupted = actorHarness({
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
    });
    const controller = new AbortController();
    controller.abort("trigger_priority");
    await workerFor(interrupted, async () => ({
      kind: "aborted",
      usage: { totalTokens: 0 },
    }), 1).run(job("foreground_user"), controller.signal);
    expect(interrupted.events.at(-1)?.payload).toEqual({
      type: "EpisodeInterrupted",
      episodeId: "episode-1",
      reason: "trigger_priority",
    });
  });

  it("records a pre-start foreground interruption without spending background autonomy", async () => {
    const harness = actorHarness({
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    });
    let modelCalls = 0;
    const controller = new AbortController();
    controller.abort("foreground_user");

    await workerFor(harness, async () => {
      modelCalls += 1;
      return { kind: "completed", proposals: [], usage: { totalTokens: 1 } };
    }, 3).run(job("health_check"), controller.signal);

    expect(modelCalls).toBe(0);
    expect(harness.state.budgets.autonomyRemaining).toBe(5);
    expect(harness.events.map((event) => event.payload)).toEqual([{
      type: "EpisodeInterrupted",
      episodeId: "episode-1",
      reason: "foreground_user",
    }]);
  });

  it("does not run the model when post-reservation frame loading is stale", async () => {
    const initial = {
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    };
    const harness = actorHarness(initial);
    let modelCalls = 0;
    const worker = new CognitionWorker(
      {
        run: async () => {
          modelCalls += 1;
          return { kind: "completed", proposals: [], usage: { totalTokens: 1 } };
        },
      },
      new Conductor(),
      harness.actor,
      new Guard(),
      (candidate) => ({
        state: initial,
        correlationId: candidate.correlationId,
        trigger: { kind: candidate.triggerKind, summary: "stale loader" },
        capabilities: [],
        maxSteps: 3,
      }),
      { invoke: async () => ({ kind: "rejected", reason: "not used" }) },
    );

    await worker.run(job("health_check"), new AbortController().signal);

    expect(modelCalls).toBe(0);
    expect(harness.events.map((event) => event.payload.type)).toEqual([
      "AutonomyConsumed",
      "CognitionDenied",
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

function actorHarness(initial: LifeState) {
  let state = initial;
  const events: EventEnvelope[] = [];
  const apply = (accepted: readonly EventEnvelope[]) => {
    events.push(...accepted);
    state = accepted.reduce(reduceLifeState, state);
  };
  const repository = {
    loadState: () => state,
    commit: (_orenId: string, accepted: readonly EventEnvelope[]) => {
      apply(accepted);
    },
    commitIfVersion: (
      _orenId: string,
      expectedVersion: number,
      accepted: readonly EventEnvelope[],
    ) => {
      if (state.version !== expectedVersion) return false;
      apply(accepted);
      return true;
    },
    commitInbox: () => false,
  } as LifeRepositoryPort;
  let id = 0;
  return {
    actor: new LifeActor(
      repository,
      () => `event-${++id}`,
      () => "2026-07-24T00:00:00.000Z",
    ),
    events,
    get state() {
      return state;
    },
  };
}

function workerFor(
  harness: ReturnType<typeof actorHarness>,
  run: CognitionPort["run"],
  maxSteps: number,
) {
  return new CognitionWorker(
    { run },
    new Conductor(),
    harness.actor,
    new Guard(),
    (candidate) => ({
      state: harness.state,
      correlationId: candidate.correlationId,
      trigger: { kind: candidate.triggerKind, summary: "test" },
      capabilities: [],
      maxSteps,
    }),
    { invoke: async () => ({ kind: "rejected", reason: "not used" }) },
  );
}
