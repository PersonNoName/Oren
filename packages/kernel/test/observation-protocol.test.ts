import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  webQuotaRemaining,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";

describe("webQuotaRemaining helper", () => {
  it("defaults missing field to 0 and reads explicit values", () => {
    const base = createInitialLifeState("oren-1", "person-1");
    expect(base.budgets.webQuotaRemaining).toBe(8);
    expect(webQuotaRemaining(base)).toBe(8);
    const legacy = {
      ...base,
      budgets: {
        autonomyRemaining: 0,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    } as LifeState;
    expect(webQuotaRemaining(legacy)).toBe(0);
  });
});

describe("ObservationRecorded", () => {
  it("canonicalizes a valid observation and rejects bad confidence/url/excerpt", () => {
    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_page",
      sourceUrl: "https://example.com/a",
      excerpt: "正文摘要",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
    })).toMatchObject({ type: "ObservationRecorded", confidence: 0.7 });

    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_page",
      sourceUrl: "https://example.com/a",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 1.5,
    })).toBeUndefined();

    expect(canonicalizeCoreEvent({
      type: "ObservationRecorded",
      observationId: "o1",
      kind: "web_search_result",
      sourceUrl: "https://example.com/a",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
      // search 缺 query
    })).toBeUndefined();
  });

  it("reducer decrements web quota and rejects when exhausted", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const envelope: EventEnvelope = {
      eventId: "e1",
      orenId: "oren-1",
      schemaVersion: 1,
      occurredAt: "2026-07-26T00:00:00.000Z",
      recordedAt: "2026-07-26T00:00:00.000Z",
      source: "test",
      causationId: null,
      correlationId: "c1",
      payload: {
        type: "ObservationRecorded",
        observationId: "o1",
        kind: "web_page",
        sourceUrl: "https://example.com/a",
        excerpt: "hi",
        retrievedAt: "2026-07-26T00:00:00.000Z",
        confidence: 0.7,
      },
    };
    const next = reduceLifeState(state, envelope);
    expect(next.budgets.webQuotaRemaining).toBe(7);
    expect(next.version).toBe(1);

    const exhausted = {
      ...state,
      budgets: { ...state.budgets, webQuotaRemaining: 0 },
    };
    expect(() => reduceLifeState(exhausted, envelope)).toThrow(/web quota/i);
  });
});

describe("LifeActor.recordObservation", () => {
  it("commits ObservationRecorded when quota remains and rejects when exhausted", () => {
    const committed: EventEnvelope[][] = [];
    let state: LifeState = createInitialLifeState("oren-1", "person-1");
    let ids = 0;
    const actor = new LifeActor(
      {
        loadState: () => state,
        loadEvents: () => [],
        commit: (_orenId, events) => {
          committed.push([...events]);
          state = events.reduce(reduceLifeState, state);
        },
        commitIfVersion: () => true,
        commitInbox: () => true,
      commitDeliverInbox: () => false,
      },
      () => `id-${++ids}`,
      () => "2026-07-26T00:00:00.000Z",
    );

    const ok = actor.recordObservation("oren-1", "corr-1", {
      kind: "web_search_result",
      sourceUrl: "https://example.com/1",
      title: "搜索：城市步行",
      excerpt: "[1] ...",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      query: "城市步行系统",
      confidence: 0.7,
    });
    expect(ok).toEqual({ accepted: true });
    expect(committed[0]![0]!.payload.type).toBe("ObservationRecorded");
    expect(state.budgets.webQuotaRemaining).toBe(7);

    state = { ...state, budgets: { ...state.budgets, webQuotaRemaining: 0 } };
    const denied = actor.recordObservation("oren-1", "corr-1", {
      kind: "web_page",
      sourceUrl: "https://example.com/2",
      excerpt: "x",
      retrievedAt: "2026-07-26T00:00:00.000Z",
      confidence: 0.7,
    });
    expect(denied).toEqual({ accepted: false, reason: "web_quota_exhausted" });
  });
});
