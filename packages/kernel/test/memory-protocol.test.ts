import { describe, expect, it } from "vitest";
import {
  canonicalizeCoreEvent,
  canonicalizeProposal,
  createInitialLifeState,
  LifeActor,
  reduceLifeState,
  type CognitionJob,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";

describe("memory proposals", () => {
  it("canonicalizes a valid Remember proposal and preserves optional fields", () => {
    expect(canonicalizeProposal({
      type: "Remember",
      text: "用户在准备一场关于城市步行系统的演讲",
      kind: "user_statement",
    })).toEqual({
      type: "Remember",
      text: "用户在准备一场关于城市步行系统的演讲",
      kind: "user_statement",
    });
    expect(canonicalizeProposal({
      type: "Remember",
      text: "判断：用户最近的低落与工作压力有关",
      kind: "oren_judgment",
      confidence: 0.6,
      reviewCondition: "下次用户主动谈到工作时复查",
      threadId: "thread-1",
    })).toMatchObject({ type: "Remember", confidence: 0.6, threadId: "thread-1" });
  });

  it("rejects invalid Remember proposals", () => {
    // oren_judgment 必须带 confidence
    expect(canonicalizeProposal({
      type: "Remember", text: "判断", kind: "oren_judgment",
    })).toBeUndefined();
    // confidence 越界
    expect(canonicalizeProposal({
      type: "Remember", text: "x", kind: "oren_judgment", confidence: 1.5,
    })).toBeUndefined();
    // 空文本 / 非法 kind / 多余键
    expect(canonicalizeProposal({ type: "Remember", text: "", kind: "user_statement" }))
      .toBeUndefined();
    expect(canonicalizeProposal({ type: "Remember", text: "x", kind: "diary" }))
      .toBeUndefined();
    expect(canonicalizeProposal({ type: "Remember", text: "x", kind: "user_statement", extra: 1 }))
      .toBeUndefined();
  });

  it("canonicalizes ReviseBelief and Forget with mandatory reasons", () => {
    expect(canonicalizeProposal({
      type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "用户已决定留下",
    })).toEqual({ type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "用户已决定留下" });
    expect(canonicalizeProposal({
      type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "",
    })).toBeUndefined();
    expect(canonicalizeProposal({ type: "Forget", memoryId: "m1", reason: "已无跨时间价值" }))
      .toEqual({ type: "Forget", memoryId: "m1", reason: "已无跨时间价值" });
    expect(canonicalizeProposal({ type: "Forget", memoryId: "", reason: "r" }))
      .toBeUndefined();
  });

  it("canonicalizes the three memory core events", () => {
    expect(canonicalizeCoreEvent({
      type: "MemoryRemembered", memoryId: "m1", kind: "external_fact", text: "事实",
    })).toMatchObject({ type: "MemoryRemembered", memoryId: "m1" });
    expect(canonicalizeCoreEvent({
      type: "MemoryRemembered", memoryId: "m1", kind: "oren_judgment", text: "判断",
    })).toBeUndefined(); // judgment 缺 confidence
    expect(canonicalizeCoreEvent({
      type: "BeliefRevised", memoryId: "m1", confidence: 0.1, reason: "r",
    })).toMatchObject({ type: "BeliefRevised" });
    expect(canonicalizeCoreEvent({
      type: "MemoryForgotten", memoryId: "m1", reason: "r",
    })).toMatchObject({ type: "MemoryForgotten" });
  });

  it("memory events advance the version without changing LifeState shape", () => {
    const state = createInitialLifeState("oren-1", "person-1");
    const envelope: EventEnvelope = {
      eventId: "e1", orenId: "oren-1", schemaVersion: 1,
      occurredAt: "2026-07-26T00:00:00.000Z", recordedAt: "2026-07-26T00:00:00.000Z",
      source: "test", causationId: null, correlationId: "c1",
      payload: { type: "MemoryForgotten", memoryId: "m1", reason: "r" },
    };
    const next = reduceLifeState(state, envelope);
    expect(next.version).toBe(1);
    expect(next.attention).toEqual(state.attention);
  });
});

describe("LifeActor memory proposal mapping", () => {
  function makeActor(committed: EventEnvelope[][]): {
    actor: LifeActor; job: CognitionJob;
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
      orenId: "oren-1", episodeId: "ep-1", baseStateVersion: 7,
      triggerKind: "foreground_user", correlationId: "corr-1",
    };
    return { actor, job };
  }

  it("maps Remember/ReviseBelief/Forget to memory events with generated memoryId", () => {
    const committed: EventEnvelope[][] = [];
    const { actor, job } = makeActor(committed);
    const result = actor.acceptCognition(job, [
      { type: "Remember", text: "判断：早跑改善了状态", kind: "oren_judgment", confidence: 0.7 },
      { type: "ReviseBelief", memoryId: "m-old", confidence: 0.1, reason: "已失效" },
      { type: "Forget", memoryId: "m-noise", reason: "无跨时间价值" },
    ]);
    expect(result.accepted).toBe(true);
    const payloads = committed[0]!.map(({ payload }) => payload);
    const remembered = payloads.find((payload) => payload.type === "MemoryRemembered");
    expect(remembered).toMatchObject({
      kind: "oren_judgment", text: "判断：早跑改善了状态", confidence: 0.7,
    });
    expect(remembered && "memoryId" in remembered && remembered.memoryId.length > 0).toBe(true);
    expect(payloads).toContainEqual({
      type: "BeliefRevised", memoryId: "m-old", confidence: 0.1, reason: "已失效",
    });
    expect(payloads).toContainEqual({
      type: "MemoryForgotten", memoryId: "m-noise", reason: "无跨时间价值",
    });
  });
});
