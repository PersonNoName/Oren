import { describe, expect, it, vi } from "vitest";
import type { CapabilityDescriptor } from "@oren/kernel";
import { toPiTool } from "../src/index.js";
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

describe("toPiTool", () => {
  it("returns an immediate capability result without terminating", async () => {
    const invoke = vi.fn(async () => ({ kind: "completed", output: { value: 2 } } as const));
    const tool = toPiTool(descriptor, createFrame(), { invoke });

    const result = await tool.execute("tool-1", { by: 1 }, undefined, undefined);

    expect(result).toMatchObject({
      content: [{ type: "text", text: "{\"value\":2}" }],
      details: { kind: "completed", output: { value: 2 } },
    });
    expect(result.terminate).not.toBe(true);
    expect(invoke).toHaveBeenCalledWith({
      orenId: "oren-1",
      descriptor,
      arguments: { by: 1 },
      stateVersion: 1,
      correlationId: "corr-1",
    });
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
      text: "External effect queued; execution is pending receipt effect-1.",
    }]);
  });
});
