import { describe, expect, it } from "vitest";
import {
  createInitialLifeState,
  evaluateReachability,
  LifeActor,
  reduceLifeState,
  type EventEnvelope,
  type LifeRepositoryPort,
  type LifeState,
} from "../src/index.js";

function fakeRepo(initial: LifeState): {
  readonly repo: LifeRepositoryPort;
  readonly events: EventEnvelope[];
} {
  let state = initial;
  const events: EventEnvelope[] = [];
  return {
    events,
    repo: {
      loadState: () => state,
      loadEvents: () => events,
      commit: (_orenId, accepted) => {
        events.push(...accepted);
        for (const event of accepted) {
          state = reduceLifeState(state, event);
        }
      },
      commitIfVersion: (_orenId, expectedVersion, accepted) => {
        if (state.version !== expectedVersion) return false;
        events.push(...accepted);
        for (const event of accepted) {
          state = reduceLifeState(state, event);
        }
        return true;
      },
      commitInbox: () => false,
      commitDeliverInbox: () => false,
    },
  };
}

describe("evaluateReachability", () => {
  const base = createInitialLifeState("oren-1", "person-1").reachability!;

  it("delivers non-proactive immediately even in quiet hours", () => {
    const d = evaluateReachability(base, "2026-07-26T23:00:00.000Z", false);
    expect(d).toEqual({ action: "deliver" });
  });

  it("defers proactive during quiet hours", () => {
    const d = evaluateReachability(base, "2026-07-26T23:00:00.000Z", true);
    expect(d.action).toBe("defer");
    if (d.action === "defer") {
      expect(d.cause).toBe("quiet_hours");
      expect(d.deferUntil > "2026-07-26T23:00:00.000Z").toBe(true);
    }
  });

  it("defers proactive when frequency cap hit", () => {
    const capped = {
      ...base,
      quietHours: null,
      proactiveDayKey: "2026-07-26",
      proactiveCountToday: 3,
      maxProactivePerDay: 3,
    };
    const d = evaluateReachability(capped, "2026-07-26T12:00:00.000Z", true);
    expect(d.action).toBe("defer");
    if (d.action === "defer") expect(d.cause).toBe("frequency_cap");
  });

  it("defers all proactive when maxProactivePerDay is zero", () => {
    const noProactive = {
      ...base,
      quietHours: null,
      maxProactivePerDay: 0,
      proactiveDayKey: null,
      proactiveCountToday: 0,
    };
    const d = evaluateReachability(noProactive, "2026-07-26T12:00:00.000Z", true);
    expect(d.action).toBe("defer");
    if (d.action === "defer") expect(d.cause).toBe("frequency_cap");
  });
});

describe("delivery + policy events", () => {
  it("MessageDelivered increments proactive count for proactive=true", () => {
    const { repo, events: _events } = fakeRepo(createInitialLifeState("oren-1", "person-1"));
    let id = 0;
    const actor = new LifeActor(repo, () => `id-${++id}`, () => "2026-07-26T12:00:00.000Z");

    actor.recordMessageDelivered("oren-1", "corr-1", {
      deliveryId: "d1",
      text: "share",
      reason: "progress",
      channel: "panel",
      proactive: true,
    });

    const state = repo.loadState("oren-1");
    expect(state.reachability?.proactiveDayKey).toBe("2026-07-26");
    expect(state.reachability?.proactiveCountToday).toBe(1);
  });

  it("MessageDeferred also schedules WakeScheduled with deliver: purpose", () => {
    const { repo, events } = fakeRepo(createInitialLifeState("oren-1", "person-1"));
    let id = 0;
    const actor = new LifeActor(repo, () => `id-${++id}`, () => "2026-07-26T23:00:00.000Z");

    actor.recordMessageDeferred("oren-1", "corr-1", {
      deliveryId: "d2",
      text: "later",
      reason: "progress",
      deferUntil: "2026-07-27T08:00:00.000Z",
      cause: "quiet_hours",
    });

    expect(events.some((e) => e.payload.type === "MessageDeferred")).toBe(true);
    expect(events.some((e) =>
      e.payload.type === "WakeScheduled"
      && e.payload.purpose === "deliver:d2"
    )).toBe(true);
  });

  it("GrantRevoked removes grantId from state", () => {
    const initial = {
      ...createInitialLifeState("oren-1", "person-1"),
      grantIds: ["g1"],
    };
    const { repo } = fakeRepo(initial);
    let id = 0;
    const actor = new LifeActor(repo, () => `id-${++id}`, () => "2026-07-26T12:00:00.000Z");

    actor.revokeGrant("oren-1", "corr-1", "g1", "user revoked");

    expect(repo.loadState("oren-1").grantIds).toEqual([]);
  });
});
