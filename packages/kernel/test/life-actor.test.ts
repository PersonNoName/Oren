import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  LifeActor,
  type CognitionJob,
  type EventEnvelope,
  type LifeRepositoryPort,
} from "../src/index.js";

describe("LifeActor", () => {
  it.each([
    {
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" } as const,
      triggerKind: "scheduled_wake" as const,
    },
    {
      event: {
        type: "EffectCompleted",
        effectId: "effect-1",
        receipt: { transactionId: "tx-1" },
      } as const,
      triggerKind: "effect_result" as const,
    },
  ])("maps $event.type inbox work to $triggerKind cognition", ({ event, triggerKind }) => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: () => undefined,
      commitIfVersion: () => true,
      commitInbox: (_inboxId, _orenId, _owner, _token, accepted) => {
        events.push(...accepted);
        return true;
      },
    };
    let id = 0;
    const actor = new LifeActor(
      repository,
      () => `id-${++id}`,
      () => "2026-07-24T00:00:00.000Z",
    );

    const result = actor.handleInbox({
      inboxId: "inbox-1",
      orenId: "oren-1",
      correlationId: "corr-1",
      event,
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
    });

    expect(result).toEqual({
      orenId: "oren-1",
      episodeId: "id-1",
      baseStateVersion: 2,
      triggerKind,
      correlationId: "corr-1",
    });
    expect(events.map((accepted) => accepted.payload.type)).toEqual([
      event.type,
      "CognitionRequested",
    ]);
  });

  it("does not return a CognitionJob when the inbox lease commit loses", () => {
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: () => undefined,
      commitIfVersion: () => true,
      commitInbox: () => false,
    };
    const actor = new LifeActor(
      repository,
      () => "id",
      () => "2026-07-24T00:00:00.000Z",
    );

    expect(actor.handleInbox({
      inboxId: "inbox-1",
      orenId: "oren-1",
      correlationId: "corr-1",
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" },
      leaseOwner: "worker-1",
      leaseToken: "stale",
    })).toBeUndefined();
  });

  it("persists CognitionRequested and returns a job immediately", () => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: (_orenId, accepted) => events.push(...accepted),
      commitIfVersion: (_orenId, _expectedVersion, accepted) => {
        events.push(...accepted);
        return true;
      },
      commitInbox: (_inboxId, _orenId, _leaseOwner, _leaseToken, accepted) => {
        events.push(...accepted);
        return true;
      },
    };
    let id = 0;
    const actor = new LifeActor(
      repository,
      () => `id-${++id}`,
      () => "2026-07-23T00:00:00.000Z",
    );

    const job = actor.handleUserMessage("oren-1", "person-1", "hello");

    expect(job).toEqual<CognitionJob>({
      orenId: "oren-1",
      episodeId: "id-1",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
      correlationId: "id-2",
    });
    expect(events.map((event) => event.eventId)).toEqual(["id-3", "id-4"]);
    expect(events.map((event) => event.payload.type)).toEqual([
      "UserMessageReceived",
      "CognitionRequested",
    ]);
    expect(events.every((event) => event.occurredAt === "2026-07-23T00:00:00.000Z")).toBe(true);
    expect(events.every((event) => event.recordedAt === "2026-07-23T00:00:00.000Z")).toBe(true);
  });

  it("maps accepted cognition proposals into ordered domain events", () => {
    const events: EventEnvelope[] = [];
    const state = { ...createInitialLifeState("oren-1", "person-1"), version: 2 };
    const repository: LifeRepositoryPort = {
      loadState: () => state,
      commit: (_orenId, accepted) => events.push(...accepted),
      commitIfVersion: (_orenId, _expectedVersion, accepted) => {
        events.push(...accepted);
        return true;
      },
      commitInbox: (_inboxId, _orenId, _leaseOwner, _leaseToken, accepted) => {
        events.push(...accepted);
        return true;
      },
    };
    let id = 0;
    const actor = new LifeActor(repository, () => `event-${++id}`, () => "2026-07-23T00:00:00.000Z");

    const result = actor.acceptCognition({
      orenId: "oren-1",
      episodeId: "episode-1",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
      correlationId: "corr-1",
    }, [
      { type: "AdvanceThread", threadId: "thread-1", summary: "hello" },
      { type: "NoAction", reason: "already captured" },
      { type: "UpdateDisposition", disposition: "curious", reason: "user asked" },
      { type: "ExpressToUser", text: "Hi", reason: "not persistent" },
      { type: "ScheduleWake", scheduleId: "wake-1", at: "2026-07-24T00:00:00.000Z", purpose: "follow up" },
    ]);

    expect(result).toEqual({ accepted: true });
    expect(events.map((event) => event.eventId)).toEqual(["event-1", "event-2", "event-3", "event-4"]);
    expect(events.map((event) => event.payload.type)).toEqual([
      "CognitionCompleted",
      "ThreadAdvanced",
      "DispositionUpdated",
      "WakeScheduled",
    ]);
  });

  it("rejects a cognition result based on an older state version without committing", () => {
    const state = {
      ...createInitialLifeState("oren-1", "person-1"),
      version: 3,
    };
    const repository: LifeRepositoryPort = {
      loadState: () => state,
      commit: () => { throw new Error("stale result must not commit"); },
      commitIfVersion: () => { throw new Error("stale result must not commit"); },
      commitInbox: () => { throw new Error("stale result must not commit"); },
    };
    const actor = new LifeActor(repository, () => "id", () => "2026-07-23T00:00:00.000Z");

    expect(actor.acceptCognition({
      orenId: "oren-1",
      episodeId: "episode-old",
      baseStateVersion: 2,
      triggerKind: "health_check",
      correlationId: "corr-old",
    }, [{ type: "NoAction", reason: "nothing" }])).toEqual({
      accepted: false,
      reason: "stale_state_version",
    });
  });

  it("rejects a stale effect request without dispatching or committing", () => {
    const repository: LifeRepositoryPort = {
      loadState: () => ({ ...createInitialLifeState("oren-1", "person-1"), version: 3 }),
      commit: () => { throw new Error("stale effect must not commit"); },
      commitIfVersion: () => { throw new Error("stale effect must not commit"); },
      commitInbox: () => { throw new Error("stale effect must not commit"); },
    };
    const actor = new LifeActor(repository, () => "id", () => "2026-07-23T00:00:00.000Z");

    expect(actor.requestEffect("oren-1", "corr-1", {
      effectId: "effect-1",
      orenId: "oren-1",
      correlationId: "corr-1",
      capability: "test.write",
      arguments: {},
      grantIds: [],
      stateVersion: 2,
    })).toEqual({
      accepted: false,
      reason: "stale_state_version",
    });
  });

  it("records an accepted effect request without dispatching it", () => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => ({ ...createInitialLifeState("oren-1", "person-1"), version: 2 }),
      commit: (_orenId, accepted) => events.push(...accepted),
      commitIfVersion: (_orenId, _expectedVersion, accepted) => {
        events.push(...accepted);
        return true;
      },
      commitInbox: (_inboxId, _orenId, _leaseOwner, _leaseToken, accepted) => {
        events.push(...accepted);
        return true;
      },
    };
    const actor = new LifeActor(repository, () => "event-1", () => "2026-07-23T00:00:00.000Z");

    expect(actor.requestEffect("oren-1", "corr-1", {
      effectId: "effect-1",
      orenId: "oren-1",
      correlationId: "corr-1",
      capability: "test.write",
      arguments: {},
      grantIds: [],
      stateVersion: 2,
    })).toEqual({ accepted: true });
    expect(events.map((event) => event.payload.type)).toEqual(["EffectRequested"]);
  });

  it("records cognition failures and interruptions using the job correlation", () => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: (_orenId, accepted) => events.push(...accepted),
      commitIfVersion: (_orenId, _expectedVersion, accepted) => {
        events.push(...accepted);
        return true;
      },
      commitInbox: (_inboxId, _orenId, _leaseOwner, _leaseToken, accepted) => {
        events.push(...accepted);
        return true;
      },
    };
    let id = 0;
    const actor = new LifeActor(repository, () => `event-${++id}`, () => "2026-07-23T00:00:00.000Z");
    const job: CognitionJob = {
      orenId: "oren-1",
      episodeId: "episode-1",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
      correlationId: "corr-1",
    };

    actor.recordCognitionExit(job, { kind: "failed", message: "model unavailable" });
    actor.recordCognitionExit(job, { kind: "aborted", reason: "shutdown" });

    expect(events.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
    expect(events.map((event) => event.correlationId)).toEqual(["corr-1", "corr-1"]);
    expect(events.map((event) => event.payload)).toEqual([
      { type: "CognitionFailed", episodeId: "episode-1", message: "model unavailable" },
      { type: "EpisodeInterrupted", episodeId: "episode-1", reason: "shutdown" },
    ]);
  });

  it("returns the existing reservation when retried with the post-reservation job version", () => {
    let state = {
      ...createInitialLifeState("oren-1", "person-1"),
      version: 2,
      budgets: {
        autonomyRemaining: 5,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    };
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => state,
      commit: () => undefined,
      commitIfVersion: (_orenId, expectedVersion, accepted) => {
        if (state.version !== expectedVersion) return false;
        events.push(...accepted);
        state = accepted.reduce((current, event) => {
          const autonomyReservations = current.autonomyReservations ?? {};
          if (event.payload.type !== "AutonomyConsumed") {
            return { ...current, version: current.version + 1 };
          }
          return {
            ...current,
            version: current.version + 1,
            budgets: {
              ...current.budgets,
              autonomyRemaining: current.budgets.autonomyRemaining - event.payload.amount,
            },
            autonomyReservations: {
              ...autonomyReservations,
              [event.payload.episodeId]: {
                amount: event.payload.amount,
                baseStateVersion: event.payload.baseStateVersion,
                correlationId: event.correlationId,
              },
            },
          };
        }, state);
        return true;
      },
      commitInbox: () => false,
    };
    let id = 0;
    const actor = new LifeActor(
      repository,
      () => `event-${++id}`,
      () => "2026-07-24T00:00:00.000Z",
    );
    const original: CognitionJob = {
      orenId: "oren-1",
      episodeId: "episode-1",
      baseStateVersion: 2,
      triggerKind: "scheduled_wake",
      correlationId: "corr-1",
    };

    const first = actor.consumeAutonomy(original, 3);
    expect(first).toMatchObject({ accepted: true, job: { baseStateVersion: 3 } });
    if (!first.accepted) throw new Error("reservation failed");
    expect(actor.consumeAutonomy(first.job, 3)).toEqual(first);
    expect(events).toHaveLength(1);
    expect(state.budgets.autonomyRemaining).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid autonomy cost %s before persistence",
    (amount) => {
      const repository: LifeRepositoryPort = {
        loadState: () => ({
          ...createInitialLifeState("oren-1", "person-1"),
          budgets: {
            autonomyRemaining: 5,
            interactionMaxSteps: 8,
            commitmentRemaining: {},
          },
        }),
        commit: () => undefined,
        commitIfVersion: () => {
          throw new Error("invalid amount must not persist");
        },
        commitInbox: () => false,
      };
      const actor = new LifeActor(repository, () => "event", () => "2026-07-24T00:00:00.000Z");

      expect(actor.consumeAutonomy({
        orenId: "oren-1",
        episodeId: "episode-1",
        baseStateVersion: 0,
        triggerKind: "health_check",
        correlationId: "corr-1",
      }, amount)).toEqual({ accepted: false, reason: "invalid_autonomy_cost" });
    },
  );
});
