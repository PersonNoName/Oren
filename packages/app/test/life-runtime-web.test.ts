import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityInvocationOutcome,
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import { ScriptedWebAdapter } from "@oren/web";
import { describe, expect, it } from "vitest";
import { LifeRuntime } from "../src/index.js";

const TEST_NOW = "2026-07-26T00:00:00.000Z";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "oren-web-runtime-")), "life.db");
}

function completed(reason: string): CognitionOutcome {
  return {
    kind: "completed",
    proposals: [{ type: "NoAction", reason }],
    usage: { totalTokens: 0 },
  };
}

describe("LifeRuntime web integration", () => {
  it("records successful search and read observations that survive restart", async () => {
    const databasePath = tempDb();
    const outcomes: CapabilityInvocationOutcome[] = [];
    const webPort = new ScriptedWebAdapter({
      search: (query) => ({
        results: [{
          title: `Result for ${query}`,
          url: "https://example.com/result",
          snippet: "A grounded search snippet.",
        }],
      }),
      read: (url) => ({
        url,
        title: "Grounded page",
        text: "The complete grounded page text.",
      }),
    });
    const cognition: CognitionPort = {
      async run(
        frame: LifeFrame,
        capabilityPort: CognitionCapabilityPort,
        signal: AbortSignal,
      ): Promise<CognitionOutcome> {
        const search = frame.capabilities.find(({ name }) => name === "web.search")!;
        const read = frame.capabilities.find(({ name }) => name === "web.read")!;
        outcomes.push(await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: search,
          arguments: { query: "grounded facts" },
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        }, signal));
        outcomes.push(await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: read,
          arguments: { url: "https://example.com/article" },
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        }, signal));
        return completed("web observations recorded");
      },
    };
    const first = await LifeRuntime.create(databasePath, cognition, {
      now: () => TEST_NOW,
      webPort,
    });
    let beforeRestart;
    try {
      await first.initialize("oren-1", "person-1");
      await first.receiveUserMessage("oren-1", "person-1", "Research this");
      await first.drain();

      expect(outcomes.map(({ kind }) => kind)).toEqual(["completed", "completed"]);
      expect(first.inspect("oren-1").budgets.webQuotaRemaining).toBe(6);
      beforeRestart = await first.recall("oren-1", {
        kinds: ["external_fact"],
        limit: 10,
      });
      expect(beforeRestart).toHaveLength(2);
      expect(beforeRestart.every(({ confidence }) => confidence === 0.7)).toBe(true);
      expect(beforeRestart.some(({ text }) => text.includes("grounded search snippet"))).toBe(true);
      expect(beforeRestart.some(({ text }) => text.includes("complete grounded page text"))).toBe(true);
    } finally {
      await first.close();
    }

    const noOpCognition: CognitionPort = {
      async run() {
        return completed("restart");
      },
    };
    const second = await LifeRuntime.create(databasePath, noOpCognition);
    try {
      const afterRestart = await second.recall("oren-1", {
        kinds: ["external_fact"],
        limit: 10,
      });
      expect(afterRestart).toEqual(beforeRestart);
    } finally {
      await second.close();
    }
  });

  it("rejects web calls before the broker when quota is exhausted", async () => {
    const databasePath = tempDb();
    let adapterCalls = 0;
    let finalOutcome: CapabilityInvocationOutcome | undefined;
    const webPort = new ScriptedWebAdapter({
      search: () => {
        adapterCalls += 1;
        return {
          results: [{
            title: "Result",
            url: "https://example.com/result",
            snippet: "Fact",
          }],
        };
      },
      read: (url) => ({ url, text: "unused" }),
    });
    const cognition: CognitionPort = {
      async run(frame, capabilityPort, signal) {
        const search = frame.capabilities.find(({ name }) => name === "web.search")!;
        for (let attempt = 0; attempt < 9; attempt += 1) {
          finalOutcome = await capabilityPort.invoke({
            orenId: frame.orenId,
            descriptor: search,
            arguments: { query: `attempt ${attempt}` },
            stateVersion: frame.stateVersion,
            correlationId: frame.correlationId,
          }, signal);
        }
        return completed("quota exhausted");
      },
    };
    const runtime = await LifeRuntime.create(databasePath, cognition, { webPort });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "Use all web quota");

      expect(finalOutcome).toEqual({
        kind: "rejected",
        reason: "web_quota_exhausted",
      });
      expect(adapterCalls).toBe(8);
      expect(runtime.inspect("oren-1").budgets.webQuotaRemaining).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("does not record an observation or spend quota for empty search results", async () => {
    const databasePath = tempDb();
    let searchOutcome: CapabilityInvocationOutcome | undefined;
    const webPort = new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: (url) => ({ url, text: "unused" }),
    });
    const cognition: CognitionPort = {
      async run(frame, capabilityPort, signal) {
        const search = frame.capabilities.find(({ name }) => name === "web.search")!;
        searchOutcome = await capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor: search,
          arguments: { query: "nothing" },
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        }, signal);
        return completed("empty search");
      },
    };
    const runtime = await LifeRuntime.create(databasePath, cognition, { webPort });
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "Find nothing");
      await runtime.drain();

      expect(searchOutcome).toEqual({ kind: "completed", output: { results: [] } });
      expect(runtime.inspect("oren-1").budgets.webQuotaRemaining).toBe(8);
      expect(await runtime.recall("oren-1", { kinds: ["external_fact"] })).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

  it("does not register web capabilities without an explicit opt-in", async () => {
    const databasePath = tempDb();
    let capabilityNames: readonly string[] = [];
    const cognition: CognitionPort = {
      async run(frame) {
        capabilityNames = frame.capabilities.map(({ name }) => name);
        return completed("captured capabilities");
      },
    };
    const runtime = await LifeRuntime.create(databasePath, cognition);
    try {
      await runtime.initialize("oren-1", "person-1");
      await runtime.receiveUserMessage("oren-1", "person-1", "Stay offline");

      expect(capabilityNames).not.toContain("web.search");
      expect(capabilityNames).not.toContain("web.read");
    } finally {
      await runtime.close();
    }
  });
});
