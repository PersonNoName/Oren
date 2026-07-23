import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor, CapabilityInvocation, CapabilityResult } from "@oren/kernel";
import { CapabilityBroker, ExtensionRegistry, type OrenExtension } from "../src/index.js";
import testCounter from "../../../extensions/test-counter/src/index.js";

function capability(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    extensionId: "test-extension",
    name: "test.read",
    description: "Read test data",
    inputSchema: { type: "object" },
    outputSchema: { type: "number" },
    permissionRequirements: [],
    traits: ["read_only", "replay_safe"],
    cancellable: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function extension(
  capabilities: readonly CapabilityDescriptor[],
  invoke: (invocation: CapabilityInvocation) => Promise<CapabilityResult> = async () => ({
    status: "completed",
    output: 0,
    receipt: {},
  }),
): OrenExtension {
  return {
    manifest: {
      id: "test-extension",
      version: "1.0.0",
      protocolVersion: 1,
      capabilities,
      eventSources: [],
    },
    async activate() {},
    async deactivate() {},
    async invoke(invocation) {
      return invoke(invocation);
    },
  };
}

function input(capabilityName = "test.read") {
  return {
    orenId: "oren-1",
    correlationId: "corr-1",
    capability: capabilityName,
    arguments: {},
    grantIds: [],
    stateVersion: 1,
    effectId: "effect-1",
  };
}

describe("CapabilityBroker", () => {
  it("executes an immediate read in-process", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => true,
    );

    const result = await broker.invoke({ ...input("test.read"), correlationId: "corr-read", effectId: "effect-read" });

    expect(result).toEqual({ kind: "completed", output: 0 });
    expect(effects).toEqual([]);
  });

  it("persists a side effect without executing it inline", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => true,
    );

    const result = await broker.invoke({
      ...input("test.increment"),
      arguments: { by: 1 },
      grantIds: ["grant-1"],
    });

    expect(result).toEqual({ kind: "waiting_for_effect", effectId: "effect-1" });
    expect(effects).toEqual(["effect-1"]);
  });

  it("rejects a protected capability before persisting an effect", async () => {
    const registry = new ExtensionRegistry();
    registry.register(testCounter);
    const effects: string[] = [];
    const broker = new CapabilityBroker(
      registry,
      (effect) => {
        effects.push(effect.effectId);
        return true;
      },
      () => false,
    );

    const result = await broker.invoke({ ...input("test.increment"), arguments: { by: 1 } });

    expect(result).toEqual({ kind: "rejected", reason: "missing_or_expired_grant" });
    expect(effects).toEqual([]);
  });

  it("authorizes a protected immediate capability before invoking it", async () => {
    let invocations = 0;
    const registry = new ExtensionRegistry();
    registry.register(extension([capability({ permissionRequirements: ["test.read"] })], async () => {
      invocations += 1;
      return { status: "completed", output: 0, receipt: {} };
    }));
    const broker = new CapabilityBroker(registry, () => true, () => false);

    const result = await broker.invoke(input());

    expect(result).toEqual({ kind: "rejected", reason: "missing_or_expired_grant" });
    expect(invocations).toBe(0);
  });

  it("does not invoke a persistent extension even when effect persistence succeeds", async () => {
    let invocations = 0;
    const registry = new ExtensionRegistry();
    registry.register(extension([capability({ name: "test.write", traits: ["external_side_effect"] })], async () => {
      invocations += 1;
      return { status: "completed", output: 1, receipt: {} };
    }));
    const broker = new CapabilityBroker(registry, () => true, () => true);

    const result = await broker.invoke(input("test.write"));

    expect(result).toEqual({ kind: "waiting_for_effect", effectId: "effect-1" });
    expect(invocations).toBe(0);
  });

  it.each([
    { status: "failed" as const, result: { status: "failed" as const, code: "offline", message: "offline" } },
    { status: "uncertain" as const, result: { status: "uncertain" as const, message: "unknown" } },
  ])("rejects an immediate $status result", async ({ result }) => {
    const registry = new ExtensionRegistry();
    registry.register(extension([capability()], async () => result));
    const broker = new CapabilityBroker(registry, () => true, () => true);

    await expect(broker.invoke(input())).resolves.toEqual({ kind: "rejected", reason: result.message });
  });

  it("uses an injected clock to construct an immediate deadline", async () => {
    let seenDeadline = "";
    const registry = new ExtensionRegistry();
    registry.register(extension([capability({ timeoutMs: 500 })], async (invocation) => {
      seenDeadline = invocation.deadline;
      return { status: "completed", output: 0, receipt: {} };
    }));
    const broker = new CapabilityBroker(registry, () => true, () => true, () => 1_700_000_000_000);

    await broker.invoke(input());

    expect(seenDeadline).toBe("2023-11-14T22:13:20.500Z");
  });
});

describe("ExtensionRegistry", () => {
  it("rejects a manifest whose capability claims another extension", () => {
    const registry = new ExtensionRegistry();
    const invalid = {
      ...testCounter,
      manifest: {
        ...testCounter.manifest,
        id: "invalid",
        capabilities: testCounter.manifest.capabilities.map((item) => ({
          ...item,
          extensionId: "someone-else",
        })),
      },
    };

    expect(() => registry.register(invalid)).toThrow("wrong extensionId");
  });

  it("does not retain capabilities when another capability invalidates a manifest", () => {
    const registry = new ExtensionRegistry();
    const invalid = extension([
      capability({ name: "test.valid" }),
      capability({ name: "test.invalid", extensionId: "someone-else" }),
    ]);

    expect(() => registry.register(invalid)).toThrow("wrong extensionId");
    expect(() => registry.resolve("test.valid")).toThrow("Unknown capability: test.valid");
  });

  it("rejects duplicate capability names within one manifest without retaining either", () => {
    const registry = new ExtensionRegistry();
    const duplicate = extension([
      capability({ name: "test.duplicate" }),
      capability({ name: "test.duplicate" }),
    ]);

    expect(() => registry.register(duplicate)).toThrow("Duplicate capability: test.duplicate");
    expect(() => registry.resolve("test.duplicate")).toThrow("Unknown capability: test.duplicate");
  });

  it("atomically rejects a manifest that registers the reserved oren_commit capability", () => {
    const registry = new ExtensionRegistry();
    const invalid = extension([
      capability({ name: "test.valid" }),
      capability({ name: "oren_commit" }),
    ]);

    expect(() => registry.register(invalid)).toThrow(
      "Capability name is reserved: oren_commit",
    );
    expect(() => registry.resolve("test.valid")).toThrow(
      "Unknown capability: test.valid",
    );

    registry.register(extension([capability({ name: "test.recovered" })]));
    expect(registry.resolve("test.recovered").descriptor.name).toBe(
      "test.recovered",
    );
  });

  it("validates every descriptor before registering any of its siblings", () => {
    const registry = new ExtensionRegistry();
    const invalid = extension([
      capability({ name: "test.valid" }),
      capability({
        name: "test.invalid",
        outputSchema: null as unknown as CapabilityDescriptor["outputSchema"],
      }),
    ]);

    expect(() => registry.register(invalid)).toThrow("invalid output schema");
    expect(() => registry.resolve("test.valid")).toThrow("Unknown capability: test.valid");
  });

  it("rejects duplicate event sources before registering capabilities", () => {
    const registry = new ExtensionRegistry();
    const candidate = extension([capability()]);
    const invalid = {
      ...candidate,
      manifest: { ...candidate.manifest, eventSources: ["test.events", "test.events"] },
    };

    expect(() => registry.register(invalid)).toThrow("Duplicate event source: test.events");
    expect(() => registry.resolve("test.read")).toThrow("Unknown capability: test.read");
  });

  it("snapshots descriptors so manifest mutation cannot change routing", async () => {
    const descriptor = capability() as {
      -readonly [key in keyof CapabilityDescriptor]: CapabilityDescriptor[key];
    };
    const registered = extension([descriptor]);
    const registry = new ExtensionRegistry();
    registry.register(registered);
    descriptor.traits = ["external_side_effect"];

    const broker = new CapabilityBroker(registry, () => true, () => true);

    await expect(broker.invoke(input())).resolves.toEqual({ kind: "completed", output: 0 });
  });
});
