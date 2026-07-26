import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  canonicalizeProposal,
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  type CognitionJob,
  type Commitment,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";

function envelope(
  payload: EventEnvelope["payload"],
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: "e1",
    orenId: "oren-1",
    schemaVersion: 1,
    occurredAt: "2026-07-26T00:00:00.000Z",
    recordedAt: "2026-07-26T00:00:00.000Z",
    source: "test",
    causationId: null,
    correlationId: "c1",
    payload,
    ...overrides,
  };
}

function commitment(
  id: string,
  overrides: Partial<Commitment> = {},
): Commitment {
  return {
    commitmentId: id,
    goal: `goal-${id}`,
    status: "active",
    nextStep: `step-${id}`,
    mayAdvanceAutonomously: true,
    ...overrides,
  };
}

describe("commitments", () => {
  it("UpsertCommitment appends and replaces by id", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const first = reduceLifeState(state, envelope({
      type: "CommitmentUpserted",
      commitmentId: "c1",
      goal: "finish report",
      status: "active",
      nextStep: "draft outline",
      mayAdvanceAutonomously: true,
    }));
    expect(first.commitments).toEqual([{
      commitmentId: "c1",
      goal: "finish report",
      status: "active",
      nextStep: "draft outline",
      mayAdvanceAutonomously: true,
    }]);

    const second = reduceLifeState(first, envelope({
      type: "CommitmentUpserted",
      commitmentId: "c2",
      goal: "exercise",
      status: "active",
      nextStep: "run 3km",
      mayAdvanceAutonomously: false,
    }));
    expect(second.commitments).toHaveLength(2);
    expect(second.commitments?.[1]).toMatchObject({ commitmentId: "c2" });

    const replaced = reduceLifeState(second, envelope({
      type: "CommitmentUpserted",
      commitmentId: "c1",
      goal: "finish report",
      status: "paused",
      nextStep: "wait for review",
      mayAdvanceAutonomously: false,
    }));
    expect(replaced.commitments).toHaveLength(2);
    expect(replaced.commitments?.[0]).toEqual({
      commitmentId: "c1",
      goal: "finish report",
      status: "paused",
      nextStep: "wait for review",
      mayAdvanceAutonomously: false,
    });
  });

  it("CommitmentStatusChanged on unknown id is no-op on state but event valid", () => {
    const state: LifeState = {
      ...createInitialLifeState("oren-1", "person-1"),
      commitments: [commitment("c1")],
      version: 3,
    };
    const event = envelope({
      type: "CommitmentStatusChanged",
      commitmentId: "missing",
      status: "done",
      reason: "completed elsewhere",
    });
    expect(canonicalizeCoreEvent(event.payload)).toMatchObject({
      type: "CommitmentStatusChanged",
      commitmentId: "missing",
    });
    const next = reduceLifeState(state, event);
    expect(next.version).toBe(4);
    expect(next.commitments).toEqual(state.commitments);
  });

  it("CommitmentStatusChanged updates status and optional nextStep", () => {
    const state: LifeState = {
      ...createInitialLifeState("oren-1", "person-1"),
      commitments: [commitment("c1", { nextStep: "old step" })],
    };
    const next = reduceLifeState(state, envelope({
      type: "CommitmentStatusChanged",
      commitmentId: "c1",
      status: "done",
      nextStep: "celebrate",
      reason: "finished",
    }));
    expect(next.commitments?.[0]).toEqual({
      commitmentId: "c1",
      goal: "goal-c1",
      status: "done",
      nextStep: "celebrate",
      mayAdvanceAutonomously: true,
    });
  });

  it("caps commitments at 32 dropping oldest done first", () => {
    let state: LifeState = {
      ...createInitialLifeState("oren-1", "person-1"),
      commitments: Array.from({ length: 32 }, (_, i) => commitment(`c${i}`, {
        status: i < 5 ? "done" : "active",
      })),
    };
    state = reduceLifeState(state, envelope({
      type: "CommitmentUpserted",
      commitmentId: "c-new",
      goal: "new goal",
      status: "active",
      nextStep: "start",
      mayAdvanceAutonomously: true,
    }));
    expect(state.commitments).toHaveLength(32);
    expect(state.commitments?.some((c) => c.commitmentId === "c-new")).toBe(true);
    expect(state.commitments?.some((c) => c.commitmentId === "c0")).toBe(false);
  });
});

describe("commitment validation", () => {
  it("canonicalizes valid UpsertCommitment and UpdateCommitmentStatus proposals", () => {
    expect(canonicalizeProposal({
      type: "UpsertCommitment",
      goal: "finish report",
      status: "active",
      nextStep: "draft",
      mayAdvanceAutonomously: true,
    })).toEqual({
      type: "UpsertCommitment",
      goal: "finish report",
      status: "active",
      nextStep: "draft",
      mayAdvanceAutonomously: true,
    });
    expect(canonicalizeProposal({
      type: "UpsertCommitment",
      commitmentId: "c1",
      goal: "finish report",
      status: "paused",
      nextStep: "wait",
      mayAdvanceAutonomously: false,
    })).toMatchObject({ commitmentId: "c1", status: "paused" });
    expect(canonicalizeProposal({
      type: "UpdateCommitmentStatus",
      commitmentId: "c1",
      status: "done",
      reason: "finished",
    })).toEqual({
      type: "UpdateCommitmentStatus",
      commitmentId: "c1",
      status: "done",
      reason: "finished",
    });
  });

  it("rejects invalid commitment proposals", () => {
    expect(canonicalizeProposal({
      type: "UpsertCommitment",
      goal: "",
      status: "active",
      nextStep: "x",
      mayAdvanceAutonomously: true,
    })).toBeUndefined();
    expect(canonicalizeProposal({
      type: "UpsertCommitment",
      goal: "g",
      status: "invalid",
      nextStep: "x",
      mayAdvanceAutonomously: true,
    })).toBeUndefined();
    expect(canonicalizeProposal({
      type: "UpdateCommitmentStatus",
      commitmentId: "c1",
      status: "done",
      reason: "",
    })).toBeUndefined();
  });

  it("canonicalizes commitment core events", () => {
    expect(canonicalizeCoreEvent({
      type: "CommitmentUpserted",
      commitmentId: "c1",
      goal: "g",
      status: "active",
      nextStep: "s",
      mayAdvanceAutonomously: false,
    })).toMatchObject({ type: "CommitmentUpserted", commitmentId: "c1" });
    expect(canonicalizeCoreEvent({
      type: "CommitmentStatusChanged",
      commitmentId: "c1",
      status: "paused",
      reason: "user asked",
    })).toMatchObject({ type: "CommitmentStatusChanged" });
  });
});

describe("LifeActor commitment mapping", () => {
  function makeActor(committed: EventEnvelope[][]): {
    actor: LifeActor;
    job: CognitionJob;
  } {
    let ids = 0;
    const state: { current: LifeState } = {
      current: { ...createInitialLifeState("oren-1", "person-1"), version: 7 },
    };
    const actor = new LifeActor(
      {
        loadState: () => state.current,
        commit: (_orenId, events) => { committed.push([...events]); },
        commitIfVersion: () => true,
        commitInbox: () => true,
      },
      () => `id-${ids += 1}`,
      () => "2026-07-26T00:00:00.000Z",
    );
    const job: CognitionJob = {
      orenId: "oren-1",
      episodeId: "ep-1",
      baseStateVersion: 7,
      triggerKind: "foreground_user",
      correlationId: "corr-1",
    };
    return { actor, job };
  }

  it("acceptCognition maps UpsertCommitment and UpdateCommitmentStatus", () => {
    const committed: EventEnvelope[][] = [];
    const { actor, job } = makeActor(committed);
    const result = actor.acceptCognition(job, [
      {
        type: "UpsertCommitment",
        goal: "track reading",
        status: "active",
        nextStep: "read chapter 1",
        mayAdvanceAutonomously: true,
      },
      {
        type: "UpdateCommitmentStatus",
        commitmentId: "c-existing",
        status: "paused",
        reason: "user asked to pause",
      },
    ]);
    expect(result.accepted).toBe(true);
    const payloads = committed[0]!.map(({ payload }) => payload);
    const upserted = payloads.find((payload) => payload.type === "CommitmentUpserted");
    expect(upserted).toMatchObject({
      goal: "track reading",
      status: "active",
      nextStep: "read chapter 1",
      mayAdvanceAutonomously: true,
    });
    expect(upserted && "commitmentId" in upserted && upserted.commitmentId.length > 0).toBe(true);
    expect(payloads).toContainEqual({
      type: "CommitmentStatusChanged",
      commitmentId: "c-existing",
      status: "paused",
      reason: "user asked to pause",
    });
  });

  it("updateCommitmentStatus from actor commits CommitmentStatusChanged", () => {
    const committed: EventEnvelope[][] = [];
    const { actor } = makeActor(committed);
    actor.updateCommitmentStatus("oren-1", "corr-2", {
      commitmentId: "c1",
      status: "done",
      nextStep: "archive",
      reason: "completed from panel",
    });
    expect(committed[0]).toHaveLength(1);
    expect(committed[0]![0]!.payload).toEqual({
      type: "CommitmentStatusChanged",
      commitmentId: "c1",
      status: "done",
      nextStep: "archive",
      reason: "completed from panel",
    });
  });
});
