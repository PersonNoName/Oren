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
import { CommitSchema } from "./proposal-schema.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { toPiTool } from "./tool-adapter.js";

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
    if (frame.maxSteps <= 0) {
      return {
        kind: "failed",
        message: "Pi ended without oren_commit",
        usage: { totalTokens },
      };
    }

    const commitTool: AgentTool<typeof CommitSchema> = {
      name: "oren_commit",
      label: "Commit episode",
      description: "Submit up to 16 typed proposals and finish this cognitive episode.",
      parameters: CommitSchema,
      executionMode: "sequential",
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
      toPiTool(descriptor, frame, {
        async invoke(input) {
          const outcome = await capabilityPort.invoke(input);
          if (outcome.kind === "waiting_for_effect") {
            waitingEffectId = outcome.effectId;
          }
          return outcome;
        },
      })
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
          beforeToolCall: async () =>
            waitingEffectId !== null || committed !== null
              ? { block: true, reason: "Episode already terminated." }
              : undefined,
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
      message: assistantFailure ?? "Pi ended without oren_commit",
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
