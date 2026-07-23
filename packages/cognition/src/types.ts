import type {
  CapabilityDescriptor,
  JsonObject,
  JsonValue,
  Proposal,
  TriggerKind,
} from "@oren/kernel";

export interface LifeFrame {
  readonly orenId: string;
  readonly correlationId: string;
  readonly stateVersion: number;
  readonly identity: {
    readonly ethosVersion: number;
    readonly disposition: string;
  };
  readonly attention: {
    readonly focus: string | null;
    readonly threadIds: readonly string[];
  };
  readonly relationship: {
    readonly primaryPersonId: string;
    readonly contextRef: string | null;
  };
  readonly trigger: {
    readonly kind: TriggerKind;
    readonly summary: string;
  };
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly maxSteps: number;
}

export type CapabilityInvocationOutcome =
  | { readonly kind: "completed"; readonly output: JsonValue }
  | { readonly kind: "waiting_for_effect"; readonly effectId: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface CognitionCapabilityPort {
  invoke(input: {
    readonly orenId: string;
    readonly descriptor: CapabilityDescriptor;
    readonly arguments: JsonObject;
    readonly stateVersion: number;
    readonly correlationId: string;
  }): Promise<CapabilityInvocationOutcome>;
}

export type CognitionOutcome =
  | {
    readonly kind: "completed";
    readonly proposals: readonly Proposal[];
    readonly usage: { readonly totalTokens: number };
  }
  | {
    readonly kind: "waiting_for_effect";
    readonly effectId: string;
    readonly usage: { readonly totalTokens: number };
  }
  | {
    readonly kind: "failed";
    readonly message: string;
    readonly usage: { readonly totalTokens: number };
  }
  | { readonly kind: "aborted"; readonly usage: { readonly totalTokens: number } };

export interface CognitionPort {
  run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome>;
}
