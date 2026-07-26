import { describe, expect, it, vi } from "vitest";
import type { CapabilityDescriptor } from "@oren/kernel";
import { toLlmToolName, toPiTool } from "../src/index.js";
import { createFrame } from "./fixtures.js";

const descriptor: CapabilityDescriptor = {
  extensionId: "test-counter",
  name: "test.increment",
  description: "Increment the counter",
  inputSchema: {
    type: "object",
    properties: { by: { type: "number" } },
    required: ["by"],
  },
  outputSchema: { type: "number" },
  permissionRequirements: ["test.write"],
  traits: ["external_side_effect"],
  cancellable: false,
  timeoutMs: 1000,
};

describe("toLlmToolName", () => {
  it("replaces characters outside [a-zA-Z0-9_-] with underscores", () => {
    expect(toLlmToolName("test.increment")).toBe("test_increment");
    expect(toLlmToolName("web.search")).toBe("web_search");
    expect(toLlmToolName("oren_commit")).toBe("oren_commit");
  });
});

describe("toPiTool", () => {
  it("exposes a sanitized LLM tool name while invoking the original descriptor", async () => {
    const invoke = vi.fn(async () => ({ kind: "completed", output: { value: 2 } } as const));
    const tool = toPiTool(descriptor, createFrame(), { invoke });
    const signal = new AbortController().signal;

    expect(tool.name).toBe("test_increment");
    expect(tool.label).toBe("test_increment");
    expect(tool.description).toContain("test_increment");
    expect(tool.description).toContain("持久能力");

    const result = await tool.execute("tool-1", { by: 1 }, signal, undefined);

    expect(result).toMatchObject({
      content: [{ type: "text", text: "{\"value\":2}" }],
      details: { kind: "completed", output: { value: 2 } },
    });
    expect(result.terminate).not.toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      {
        orenId: "oren-1",
        descriptor,
        arguments: { by: 1 },
        stateVersion: 1,
        correlationId: "corr-1",
      },
      signal,
    );
  });

  it("terminates the Pi turn when Oren persists an external effect", async () => {
    const tool = toPiTool(descriptor, createFrame(), {
      invoke: async () => ({ kind: "waiting_for_effect", effectId: "effect-1" }),
    });

    const result = await tool.execute("tool-1", { by: 1 }, undefined, undefined);

    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({
      kind: "waiting_for_effect",
      effectId: "effect-1",
    });
    expect(result.content).toEqual([{
      type: "text",
      text: "持久效应已排队，等待回执 effect-1；本轮思考结束，请勿重复调用同一持久能力。",
    }]);
  });
});
