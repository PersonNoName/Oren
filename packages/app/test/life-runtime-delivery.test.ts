import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedChannelAdapter } from "@oren/channel";
import type { CognitionOutcome, CognitionPort } from "@oren/cognition";
import {
  createInitialLifeState,
  type EventEnvelope,
  type LifeState,
} from "@oren/kernel";
import { FakeEmbedder } from "@oren/memory";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { describe, expect, it } from "vitest";
import { LifeRuntime } from "../src/index.js";

const QUIET_NOW = "2026-07-26T23:00:00.000Z";
const DAY_NOW = "2026-07-26T12:00:00.000Z";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-delivery-runtime-")), "life.db");
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

function envelope(
  eventId: string,
  orenId: string,
  correlationId: string,
  payload: EventEnvelope["payload"],
  occurredAt = QUIET_NOW,
): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt,
    recordedAt: occurredAt,
    source: "life-runtime-delivery-test",
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

function loadPayloads(path: string, orenId: string): EventEnvelope["payload"][] {
  const repository = new SqliteLifeRepository(openDatabase(path), () => QUIET_NOW);
  try {
    return repository.loadEvents(orenId).map((event) => event.payload);
  } finally {
    repository.close();
  }
}

describe("LifeRuntime ExpressToUser delivery", () => {
  it("foreground ExpressToUser delivers immediately via channel", async () => {
    const channel = new ScriptedChannelAdapter();
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("hello"), {
      now: () => QUIET_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
      channelPort: channel,
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "hi");
      await runtime.drain();

      expect(channel.calls).toHaveLength(1);
      expect(channel.calls[0]).toMatchObject({
        text: "hello",
        reason: "reply",
        proactive: false,
      });
      const payloads = loadPayloads(path, "oren-1");
      expect(payloads.some((payload) =>
        payload.type === "MessageDelivered"
        && payload.text === "hello"
        && payload.proactive === false
      )).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("proactive ExpressToUser during quiet hours defers and does not call channel", async () => {
    const channel = new ScriptedChannelAdapter();
    const path = tempDb();
    const repository = new SqliteLifeRepository(openDatabase(path), () => QUIET_NOW);
    repository.initialize(stateWithAutonomy());
    repository.commit("oren-1", [
      envelope("schedule", "oren-1", "corr-schedule", {
        type: "WakeScheduled",
        scheduleId: "proactive-wake",
        at: QUIET_NOW,
        purpose: "share progress",
      }),
    ]);
    repository.close();

    const cognition: CognitionPort = {
      async run(frame) {
        if (frame.trigger.kind !== "scheduled_wake") {
          return {
            kind: "completed",
            proposals: [{ type: "NoAction", reason: "ignored" }],
            usage: { totalTokens: 0 },
          };
        }
        return {
          kind: "completed",
          proposals: [{
            type: "ExpressToUser",
            text: "Here is a proactive update for you.",
            reason: "progress",
          }],
          usage: { totalTokens: 0 },
        };
      },
    };
    const runtime = await LifeRuntime.create(path, cognition, {
      now: () => QUIET_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
      channelPort: channel,
    });
    try {
      await runtime.drain();

      expect(channel.calls).toHaveLength(0);
      const payloads = loadPayloads(path, "oren-1");
      expect(payloads.some((payload) => payload.type === "MessageDeferred")).toBe(true);
      expect(payloads.some((payload) =>
        payload.type === "WakeScheduled"
        && payload.purpose.startsWith("deliver:")
      )).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("deliver: wake completes deferred delivery without new cognition proposals requirement", async () => {
    const channel = new ScriptedChannelAdapter();
    const path = tempDb();
    const deliveryId = "delivery-1";
    const repository = new SqliteLifeRepository(openDatabase(path), () => DAY_NOW);
    repository.initialize(stateWithAutonomy());
    repository.commit("oren-1", [
      envelope("deferred", "oren-1", "corr-defer", {
        type: "MessageDeferred",
        deliveryId,
        text: "delayed hello",
        reason: "progress",
        deferUntil: DAY_NOW,
        cause: "quiet_hours",
      }, DAY_NOW),
      envelope("schedule", "oren-1", "corr-defer", {
        type: "WakeScheduled",
        scheduleId: deliveryId,
        at: DAY_NOW,
        purpose: `deliver:${deliveryId}`,
      }, DAY_NOW),
    ]);
    repository.close();

    const cognition: CognitionPort = {
      async run() {
        throw new Error("Deliver wake must not invoke cognition");
      },
    };
    const runtime = await LifeRuntime.create(path, cognition, {
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
      channelPort: channel,
    });
    try {
      await runtime.drain();

      expect(channel.calls).toHaveLength(1);
      expect(channel.calls[0]).toMatchObject({
        deliveryId,
        text: "delayed hello",
        proactive: true,
      });
      const payloads = loadPayloads(path, "oren-1");
      expect(payloads.some((payload) =>
        payload.type === "MessageDelivered"
        && payload.deliveryId === deliveryId
        && payload.proactive === true
      )).toBe(true);
      expect(payloads.some((payload) => payload.type === "CognitionRequested")).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
