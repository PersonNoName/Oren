import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelInboxAdapter } from "@oren/channel";
import { ScriptedCognitionAdapter, type CognitionOutcome, type CognitionPort } from "@oren/cognition";
import { FakeEmbedder } from "@oren/memory";
import {
  createInitialLifeState,
  Guard,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { describe, expect, it } from "vitest";
import { LifeRuntime } from "../src/index.js";
import { buildPanelSnapshot } from "../src/panel-snapshot.js";

const DAY_NOW = "2026-07-26T12:00:00.000Z";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-panel-runtime-")), "life.db");
}

function sequenceIds(prefix = "id"): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function cognitionThatExpresses(text: string): CognitionPort {
  return {
    async run(): Promise<CognitionOutcome> {
      return {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text, reason: "reply" }],
        usage: { totalTokens: 0 },
      };
    },
  };
}

/** Durable test.increment on user message; ExpressToUser only after effect_result (needs drain). */
function cognitionExpressingAfterDurableEffect(text: string): CognitionPort {
  return new ScriptedCognitionAdapter(async (frame, capabilityPort, signal) => {
    if (frame.trigger.kind === "foreground_user") {
      const increment = frame.capabilities.find(({ name }) => name === "test.increment");
      if (!increment) {
        return {
          kind: "failed",
          message: "test.increment capability missing",
          usage: { totalTokens: 0 },
        };
      }
      const pending = await capabilityPort.invoke({
        orenId: frame.orenId,
        descriptor: increment,
        arguments: { by: 1 },
        stateVersion: frame.stateVersion,
        correlationId: frame.correlationId,
      }, signal);
      if (pending.kind !== "waiting_for_effect") {
        return {
          kind: "failed",
          message: "expected durable effect before express",
          usage: { totalTokens: 0 },
        };
      }
      return { ...pending, usage: { totalTokens: 0 } };
    }
    if (frame.trigger.kind === "effect_result") {
      return {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text, reason: "after durable effect" }],
        usage: { totalTokens: 0 },
      };
    }
    return {
      kind: "completed",
      proposals: [{ type: "NoAction", reason: "unexpected trigger" }],
      usage: { totalTokens: 0 },
    };
  });
}

function envelope(
  eventId: string,
  orenId: string,
  correlationId: string,
  payload: EventEnvelope["payload"],
  occurredAt = DAY_NOW,
): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt,
    recordedAt: occurredAt,
    source: "life-runtime-panel-test",
    causationId: null,
    correlationId,
    payload,
  };
}

function stateWithAutonomy(
  orenId = "oren-1",
  personId = "person-1",
): LifeState {
  return {
    ...createInitialLifeState(orenId, personId),
    budgets: {
      autonomyRemaining: 32,
      interactionMaxSteps: 8,
      commitmentRemaining: {},
    },
  };
}

describe("LifeRuntime panel", () => {
  it("updateReachabilityPolicy persists and shows in snapshot", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("unused"), {
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      runtime.updateReachabilityPolicy({
        quietHours: null,
        maxProactivePerDay: 5,
        deferWhenQuiet: true,
      }, "user preference");

      const snapshot = runtime.getPanelSnapshot();
      expect(snapshot.reachability.maxProactivePerDay).toBe(5);
      expect(snapshot.reachability.quietHours).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("revokeGrant marks grant revoked and Guard denies", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("unused"), {
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      const grantId = "runtime:oren-1:test-counter";
      runtime.revokeGrant(grantId, "user revoked");

      const snapshot = runtime.getPanelSnapshot();
      expect(snapshot.grants).toEqual([
        {
          grantId,
          capabilityPattern: "test.*",
          revoked: true,
        },
      ]);

      const decision = new Guard().evaluateCapability({
        capability: "test.increment",
        grants: [],
        now: DAY_NOW,
      });
      expect(decision).toEqual({ allowed: false, reason: "missing_or_expired_grant" });
    } finally {
      await runtime.close();
    }
  });

  it("POST /api/message drains durable work before response (no external drain)", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(
      path,
      cognitionExpressingAfterDurableEffect("from panel post"),
      {
        enablePanel: true,
        now: () => DAY_NOW,
        nextId: sequenceIds(),
        embedder: new FakeEmbedder(),
      },
    );
    try {
      await runtime.initialize("oren-1", "person-1");
      const url = runtime.panelUrl();
      expect(url).toBeDefined();

      const post = await fetch(`${url}/api/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi from panel" }),
      });
      expect(post.ok).toBe(true);

      // Cognition ends in waiting_for_effect; ExpressToUser needs drainToFixedPoint.
      // Intentionally no runtime.drain() here — postMessage must have drained.
      const res = await fetch(`${url}/api/snapshot`);
      const snapshot = await res.json();
      expect(snapshot.inbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "delivered",
            text: "from panel post",
          }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("enablePanel serves snapshot reflecting delivered message", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("panel hello"), {
      enablePanel: true,
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "hi");
      await runtime.drain();

      const url = runtime.panelUrl();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await fetch(`${url}/api/snapshot`);
      expect(res.ok).toBe(true);
      const snapshot = await res.json();
      expect(snapshot.inbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "delivered",
            text: "panel hello",
          }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("uses explicit PanelInboxAdapter for snapshot inbox when passed with enablePanel", async () => {
    const inbox = new PanelInboxAdapter(() => DAY_NOW);
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("inbox text"), {
      enablePanel: true,
      channelPort: inbox,
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "hi");
      await runtime.drain();

      const snapshot = runtime.getPanelSnapshot();
      expect(snapshot.inbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "delivered",
            text: "inbox text",
          }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("getPanelSnapshot inbox includes delivered after ExpressToUser delivery", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("event hello"), {
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "hi");
      await runtime.drain();

      const snapshot = runtime.getPanelSnapshot();
      expect(snapshot.inbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "delivered",
            text: "event hello",
          }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("buildPanelSnapshot projects delivered inbox from events without adapter", () => {
    const path = tempDb();
    const repository = new SqliteLifeRepository(openDatabase(path), () => DAY_NOW);
    const state = stateWithAutonomy();
    repository.initialize(state);
    repository.commit("oren-1", [
      envelope("delivered", "oren-1", "corr-1", {
        type: "MessageDelivered",
        deliveryId: "delivery-event-only",
        text: "from events",
        reason: "reply",
        channel: "panel",
        proactive: false,
      }),
    ]);
    try {
      const snapshot = buildPanelSnapshot(repository, "oren-1", state);
      expect(snapshot.inbox).toEqual([
        expect.objectContaining({
          deliveryId: "delivery-event-only",
          status: "delivered",
          text: "from events",
        }),
      ]);
    } finally {
      repository.close();
    }
  });

  it("buildPanelSnapshot suppresses deferred row after later delivery for same id", () => {
    const path = tempDb();
    const repository = new SqliteLifeRepository(openDatabase(path), () => DAY_NOW);
    const state = stateWithAutonomy();
    repository.initialize(state);
    const deliveryId = "delivery-defer-then-deliver";
    repository.commit("oren-1", [
      envelope("deferred", "oren-1", "corr-1", {
        type: "MessageDeferred",
        deliveryId,
        text: "delayed hello",
        reason: "progress",
        deferUntil: DAY_NOW,
        cause: "quiet_hours",
      }),
      envelope("delivered", "oren-1", "corr-1", {
        type: "MessageDelivered",
        deliveryId,
        text: "delayed hello",
        reason: "progress",
        channel: "panel",
        proactive: true,
      }),
    ]);
    try {
      const snapshot = buildPanelSnapshot(repository, "oren-1", state);
      expect(snapshot.inbox).toHaveLength(1);
      expect(snapshot.inbox[0]).toMatchObject({
        deliveryId,
        status: "delivered",
        text: "delayed hello",
      });
    } finally {
      repository.close();
    }
  });
});
