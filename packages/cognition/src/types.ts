import type {
  CapabilityDescriptor,
  JsonObject,
  JsonValue,
  MemoryKind,
  Proposal,
  TriggerKind,
} from "@oren/kernel";

export interface MemoryPin {
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly confidence: number | null;
  readonly occurredAt: string;
}

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
  readonly memoryPins: readonly MemoryPin[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly maxSteps: number;
}

export type CapabilityInvocationOutcome =
  | { readonly kind: "completed"; readonly output: JsonValue }
  | { readonly kind: "waiting_for_effect"; readonly effectId: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface CognitionCapabilityInput {
  readonly orenId: string;
  readonly descriptor: CapabilityDescriptor;
  readonly arguments: JsonObject;
  readonly stateVersion: number;
  readonly correlationId: string;
}

export interface CognitionCapabilityPort {
  invoke(
    input: CognitionCapabilityInput,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationOutcome>;
}

export interface CognitionUsage {
  readonly totalTokens: number;
}

export type CognitionFinishReason =
  | "stop"
  | "max_steps"
  | "waiting_for_effect";

export type CommitReceipt =
  | {
      readonly kind: "accepted";
      readonly commitId: string;
      readonly stateVersion: number;
    }
  | {
      readonly kind: "rejected";
      readonly commitId: string;
      readonly reason: string;
    };

export type CognitionEvent =
  | { readonly type: "speech.started"; readonly utteranceId: string }
  | {
      readonly type: "speech.delta";
      readonly utteranceId: string;
      readonly text: string;
    }
  | { readonly type: "speech.completed"; readonly utteranceId: string }
  | {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "commit.requested";
      readonly commitId: string;
      readonly proposals: readonly Proposal[];
    }
  | {
      readonly type: "commit.resolved";
      readonly receipt: CommitReceipt;
    }
  | {
      readonly type: "episode.completed";
      readonly reason: CognitionFinishReason;
      readonly effectId?: string;
      readonly usage: CognitionUsage;
    }
  | {
      readonly type: "episode.failed";
      readonly message: string;
      readonly usage: CognitionUsage;
    }
  | {
      readonly type: "episode.aborted";
      readonly usage: CognitionUsage;
    };

export interface CognitionHandlers {
  invokeCapability(
    input: Omit<CognitionCapabilityInput, "stateVersion">,
    signal: AbortSignal,
  ): Promise<CapabilityInvocationOutcome>;
  submitCommit(
    input: {
      readonly commitId: string;
      readonly proposals: readonly Proposal[];
    },
    signal: AbortSignal,
  ): Promise<CommitReceipt>;
}

export interface StreamingCognitionPort {
  stream(
    frame: LifeFrame,
    handlers: CognitionHandlers,
    signal: AbortSignal,
  ): AsyncIterable<CognitionEvent>;
}

/** @deprecated Use StreamingCognitionPort and CognitionEvent. */
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
    readonly usage: CognitionUsage;
  }
  | { readonly kind: "aborted"; readonly usage: CognitionUsage };

/** @deprecated Use StreamingCognitionPort. */
export interface CognitionPort {
  run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome>;
}
