import type { OrenExtension } from "@oren/extensions";

let value = 0;

const extension: OrenExtension = {
  manifest: {
    id: "test-counter",
    version: "1.0.0",
    protocolVersion: 1,
    eventSources: [],
    capabilities: [
      {
        extensionId: "test-counter",
        name: "test.read",
        description: "Read the counter",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "number" },
        permissionRequirements: [],
        traits: ["read_only", "replay_safe"],
        cancellable: true,
        timeoutMs: 1_000,
      },
      {
        extensionId: "test-counter",
        name: "test.increment",
        description: "Increment the counter",
        inputSchema: {
          type: "object",
          properties: { by: { type: "number" } },
          required: ["by"],
          additionalProperties: false,
        },
        outputSchema: { type: "number" },
        permissionRequirements: ["test.write"],
        traits: ["external_side_effect"],
        cancellable: false,
        timeoutMs: 1_000,
      },
    ],
  },
  async activate() {},
  async deactivate() {},
  async invoke(invocation) {
    if (invocation.capability === "test.read") {
      return { status: "completed", output: value, receipt: { observed: true } };
    }
    const by = Number(invocation.arguments.by);
    value += by;
    return {
      status: "completed",
      output: value,
      receipt: { effectId: invocation.effectId, value },
    };
  },
};

export default extension;
