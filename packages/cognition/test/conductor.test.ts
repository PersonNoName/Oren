import { describe, expect, it } from "vitest";
import { createInitialLifeState } from "@oren/kernel";
import {
  Conductor,
  ScriptedCognitionAdapter,
  type CognitionCapabilityPort,
} from "../src/index.js";

const capability = {
  extensionId: "test",
  name: "test.read",
  description: "Read a deterministic value",
  inputSchema: { type: "object" },
  outputSchema: { type: "number" },
  permissionRequirements: [],
  traits: ["read_only", "replay_safe"] as const,
  cancellable: true,
  timeoutMs: 1000,
};

const capabilityPort: CognitionCapabilityPort = {
  async invoke() {
    return { kind: "rejected", reason: "not used" };
  },
};

describe("Conductor", () => {
  it("builds a bounded LifeFrame with capability summaries", () => {
    const frame = new Conductor().createFrame({
      state: createInitialLifeState("oren-1", "person-1"),
      correlationId: "corr-1",
      trigger: { kind: "foreground_user", summary: "hello" },
      capabilities: [capability],
      maxSteps: 8,
    });

    expect(frame).toMatchObject({
      orenId: "oren-1",
      stateVersion: 0,
      trigger: { kind: "foreground_user" },
      maxSteps: 8,
    });
    expect(frame.capabilities[0]?.name).toBe("test.read");
  });

  it("limits active thread IDs to sixteen", () => {
    const state = {
      ...createInitialLifeState("oren-1", "person-1"),
      attention: {
        ...createInitialLifeState("oren-1", "person-1").attention,
        activeThreadIds: Array.from({ length: 18 }, (_, index) => `thread-${index}`),
      },
    };

    const frame = new Conductor().createFrame({
      state,
      correlationId: "corr-1",
      trigger: { kind: "foreground_user", summary: "hello" },
      capabilities: [capability],
      maxSteps: 8,
    });

    expect(frame.attention.threadIds).toEqual(
      Array.from({ length: 16 }, (_, index) => `thread-${index}`),
    );
  });

  it("projects state values without retaining the mutable state", () => {
    const state = {
      ...createInitialLifeState("oren-1", "person-1"),
      identity: { ethosVersion: 2, currentDisposition: "focused" },
      attention: {
        activeThreadIds: ["thread-1"],
        currentFocus: "question-1",
        unresolvedQuestions: [],
      },
      relationship: { primaryPersonId: "person-1", currentContextRef: "context-1" },
    };
    const frame = new Conductor().createFrame({
      state,
      correlationId: "corr-1",
      trigger: { kind: "foreground_user", summary: "hello" },
      capabilities: [capability],
      maxSteps: 8,
    });

    state.identity.currentDisposition = "changed";
    state.attention.activeThreadIds[0] = "other-thread";
    state.relationship.currentContextRef = "other-context";

    expect(frame).toMatchObject({
      identity: { ethosVersion: 2, disposition: "focused" },
      attention: { focus: "question-1", threadIds: ["thread-1"] },
      relationship: { primaryPersonId: "person-1", contextRef: "context-1" },
    });
    expect(frame).not.toHaveProperty("state");
  });

  it("returns an aborted outcome without calling a pre-aborted script", async () => {
    const controller = new AbortController();
    controller.abort();
    let scriptCalled = false;
    const script = async () => {
      scriptCalled = true;
      return {
        kind: "completed" as const,
        proposals: [],
        usage: { totalTokens: 1 },
      };
    };
    const adapter = new ScriptedCognitionAdapter(script);
    const frame = new Conductor().createFrame({
      state: createInitialLifeState("oren-1", "person-1"),
      correlationId: "corr-1",
      trigger: { kind: "foreground_user", summary: "hello" },
      capabilities: [capability],
      maxSteps: 8,
    });

    const outcome = await adapter.run(frame, capabilityPort, controller.signal);

    expect(outcome).toEqual({ kind: "aborted", usage: { totalTokens: 0 } });
    expect(scriptCalled).toBe(false);
  });
});
