import type { CapabilityDescriptor, LifeState, TriggerKind } from "@oren/kernel";
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
    capabilities: input.capabilities.slice(),
    maxSteps: input.maxSteps,
  };
}
