import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  LifeActor,
  type CognitionJob,
  type EventEnvelope,
  type LifeRepositoryPort,
} from "../src/index.js";

describe("LifeActor", () => {
  it("persists CognitionRequested and returns a job immediately", () => {
    const events: EventEnvelope[] = [];
    const repository: LifeRepositoryPort = {
      loadState: () => createInitialLifeState("oren-1", "person-1"),
      commit: (_orenId, accepted) => events.push(...accepted),
      commitInbox: (_inboxId, _orenId, accepted) => events.push(...accepted),
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
      commitInbox: (_inboxId, _orenId, accepted) => events.push(...accepted),
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
      commitInbox: (_inboxId, _orenId, accepted) => events.push(...accepted),
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
      commitInbox: (_inboxId, _orenId, accepted) => events.push(...accepted),
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
});
