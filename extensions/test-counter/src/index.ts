import type { OrenExtension } from "@oren/extensions";

export function createTestCounterExtension(): OrenExtension {
  let value = 0;
  return {
    manifest: {
      id: "test-counter",
      version: "1.0.0",
      protocolVersion: 1,
      eventSources: [],
      capabilities: [
        {
          extensionId: "test-counter",
          name: "test.read",
          description: "即时读取计数器当前值",
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
          description: "持久地将计数器加一；调用后本轮结束，需等回执",
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
}

const extension: OrenExtension = createTestCounterExtension();

export default extension;
