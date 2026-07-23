import {
  isImmediateCapability,
  type CapabilityDescriptor,
  type Effect,
  type JsonObject,
} from "@oren/kernel";
import type { CapabilityInvocationOutcome } from "@oren/cognition";
import type { ExtensionRegistry } from "./registry.js";

export interface BrokerInput {
  readonly orenId: string;
  readonly correlationId: string;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly string[];
  readonly stateVersion: number;
  readonly effectId: string;
}

export class CapabilityBroker {
  public constructor(
    private readonly registry: ExtensionRegistry,
    private readonly persistEffect: (effect: Effect) => boolean,
    private readonly authorize: (input: BrokerInput, descriptor: CapabilityDescriptor) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  public async invoke(input: BrokerInput): Promise<CapabilityInvocationOutcome> {
    const { descriptor, extension } = this.registry.resolve(input.capability);
    if (descriptor.permissionRequirements.length > 0 && !this.authorize(input, descriptor)) {
      return { kind: "rejected", reason: "missing_or_expired_grant" };
    }
    if (!isImmediateCapability(descriptor)) {
      const effect: Effect = {
        effectId: input.effectId,
        orenId: input.orenId,
        correlationId: input.correlationId,
        capability: input.capability,
        arguments: input.arguments,
        grantIds: input.grantIds,
        stateVersion: input.stateVersion,
      };
      return this.persistEffect(effect)
        ? { kind: "waiting_for_effect", effectId: effect.effectId }
        : { kind: "rejected", reason: "stale_state_version" };
    }

    const result = await extension.invoke({
      effectId: input.effectId,
      orenId: input.orenId,
      capability: input.capability,
      arguments: input.arguments,
      grantIds: input.grantIds,
      stateVersion: input.stateVersion,
      deadline: new Date(this.now() + descriptor.timeoutMs).toISOString(),
    }, new AbortController().signal);
    return result.status === "completed"
      ? { kind: "completed", output: result.output }
      : { kind: "rejected", reason: result.message };
  }
}
