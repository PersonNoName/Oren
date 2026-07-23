import type {
  CapabilityDescriptor,
  JsonObject,
  JsonValue,
  LifeState,
  TriggerKind,
} from "@oren/kernel";
import type { LifeFrame } from "./types.js";

export interface CreateFrameInput {
  readonly state: LifeState;
  readonly correlationId: string;
  readonly trigger: { readonly kind: TriggerKind; readonly summary: string };
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly maxSteps: number;
}

export function createLifeFrame(input: CreateFrameInput): LifeFrame {
  return {
    orenId: input.state.orenId,
    correlationId: input.correlationId,
    stateVersion: input.state.version,
    identity: {
      ethosVersion: input.state.identity.ethosVersion,
      disposition: input.state.identity.currentDisposition,
    },
    attention: {
      focus: input.state.attention.currentFocus,
      threadIds: input.state.attention.activeThreadIds.slice(0, 16),
    },
    relationship: {
      primaryPersonId: input.state.relationship.primaryPersonId,
      contextRef: input.state.relationship.currentContextRef,
    },
    trigger: {
      kind: input.trigger.kind,
      summary: input.trigger.summary,
    },
    capabilities: input.capabilities.map(snapshotCapabilityDescriptor),
    maxSteps: input.maxSteps,
  };
}

function snapshotCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
): CapabilityDescriptor {
  return {
    extensionId: descriptor.extensionId,
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: snapshotJsonObject(descriptor.inputSchema),
    outputSchema: snapshotJsonObject(descriptor.outputSchema),
    permissionRequirements: [...descriptor.permissionRequirements],
    traits: [...descriptor.traits],
    cancellable: descriptor.cancellable,
    timeoutMs: descriptor.timeoutMs,
  };
}

function snapshotJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      snapshotJsonValue(nestedValue),
    ]),
  );
}

function snapshotJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(snapshotJsonValue);
  }

  return value !== null && typeof value === "object"
    ? snapshotJsonObject(value)
    : value;
}
