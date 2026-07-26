import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PanelInboxAdapter } from "@oren/channel";
import type { CognitionOutcome, CognitionPort } from "@oren/cognition";
import { FakeEmbedder } from "@oren/memory";
import { Guard } from "@oren/kernel";
import { describe, expect, it } from "vitest";
import { LifeRuntime } from "../src/index.js";

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
});
