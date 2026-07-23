import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type {
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { CommitSchema } from "./proposal-schema.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { toPiTool } from "./tool-adapter.js";

const COMMIT_TOOL_NAME = "oren_commit";

export interface PiCognitionAdapterOptions {
  readonly model: Model<any>;
  readonly streamFn: StreamFn;
  readonly messageTimestamp?: () => number;
}

export class PiCognitionAdapter implements CognitionPort {
  public constructor(private readonly options: PiCognitionAdapterOptions) {}

  public async run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome> {
    let committed: readonly Proposal[] | null = null;
    let waitingEffectId: string | null = null;
    let assistantFailure: string | null = null;
    let assistantAborted = false;
    let totalTokens = 0;
    let turns = 0;

    if (signal.aborted) {
      return { kind: "aborted", usage: { totalTokens } };
    }
    if (!Number.isFinite(frame.maxSteps)
      || !Number.isInteger(frame.maxSteps)
      || frame.maxSteps < 0) {
      return {
        kind: "failed",
        message: "Invalid maxSteps: expected a finite nonnegative integer",
        usage: { totalTokens },
      };
    }
    if (frame.capabilities.some(({ name }) => name === COMMIT_TOOL_NAME)) {
      return {
        kind: "failed",
        message: `Capability name is reserved: ${COMMIT_TOOL_NAME}`,
        usage: { totalTokens },
      };
    }
    if (frame.maxSteps === 0) {
      return {
        kind: "failed",
        message: `Pi ended without ${COMMIT_TOOL_NAME}`,
        usage: { totalTokens },
      };
    }

    const commitTool: AgentTool<typeof CommitSchema> = {
      name: COMMIT_TOOL_NAME,
      label: "Commit episode",
      description: "Submit up to 16 typed proposals and finish this cognitive episode.",
      parameters: CommitSchema,
      executionMode: "sequential",
      prepareArguments(args: unknown) {
        if (!Check(CommitSchema, args)) {
          throw new Error(
            "Raw oren_commit arguments do not match the commit schema.",
          );
        }
        return args;
      },
      async execute(_toolCallId, params: Static<typeof CommitSchema>) {
        committed = params.proposals as readonly Proposal[];
        return {
          content: [{ type: "text", text: "Episode proposals accepted." }],
          details: { committed: true },
          terminate: true,
        };
      },
    };

    const capabilityTools = frame.capabilities.map((descriptor) =>
      toPiTool(descriptor, frame, capabilityPort)
    );
    const context: AgentContext = {
      systemPrompt: systemPrompt(frame),
      messages: [],
      tools: [...capabilityTools, commitTool],
    };

    try {
      await runAgentLoop(
        [{
          role: "user",
          content: userPrompt(frame),
          timestamp: (this.options.messageTimestamp ?? Date.now)(),
        }],
        context,
        {
          model: this.options.model,
          convertToLlm: (messages) => messages.filter(
            (message): message is Message =>
              message.role === "user"
              || message.role === "assistant"
              || message.role === "toolResult",
          ),
          toolExecution: "sequential",
          beforeToolCall: async () => {
            if (waitingEffectId !== null || committed !== null) {
              return { block: true, reason: "Episode already terminated." };
            }
            return undefined;
          },
          afterToolCall: async ({ result }, hookSignal) => {
            if (hookSignal?.aborted) {
              return undefined;
            }
            const effectId = waitingEffectFromDetails(result.details);
            if (effectId !== null) {
              waitingEffectId = effectId;
            }
            return undefined;
          },
          shouldStopAfterTurn: () => {
            turns += 1;
            return waitingEffectId !== null
              || committed !== null
              || turns >= frame.maxSteps;
          },
        },
        (event) => {
          observeAgentEvent(event);
        },
        signal,
        this.options.streamFn,
      );
    } catch (error) {
      if (signal.aborted) {
        return { kind: "aborted", usage: { totalTokens } };
      }
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
        usage: { totalTokens },
      };
    }

    if (signal.aborted || assistantAborted) {
      return { kind: "aborted", usage: { totalTokens } };
    }
    if (waitingEffectId !== null) {
      return {
        kind: "waiting_for_effect",
        effectId: waitingEffectId,
        usage: { totalTokens },
      };
    }
    if (committed !== null) {
      return { kind: "completed", proposals: committed, usage: { totalTokens } };
    }
    return {
      kind: "failed",
      message: assistantFailure ?? `Pi ended without ${COMMIT_TOOL_NAME}`,
      usage: { totalTokens },
    };

    function observeAgentEvent(event: AgentEvent): void {
      if (event.type !== "message_end" || event.message.role !== "assistant") {
        return;
      }
      totalTokens += event.message.usage.totalTokens;
      if (event.message.stopReason === "aborted") {
        assistantAborted = true;
      } else if (event.message.stopReason === "error") {
        assistantFailure = event.message.errorMessage ?? "Pi model stream failed";
      }
    }
  }
}

function waitingEffectFromDetails(details: unknown): string | null {
  if (typeof details !== "object" || details === null) {
    return null;
  }
  const candidate = details as { kind?: unknown; effectId?: unknown };
  return candidate.kind === "waiting_for_effect"
    && typeof candidate.effectId === "string"
    ? candidate.effectId
    : null;
}
