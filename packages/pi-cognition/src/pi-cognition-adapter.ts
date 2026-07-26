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
  CognitionEvent,
  CognitionHandlers,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
  StreamingCognitionPort,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { CommitSchema } from "./proposal-schema.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import {
  toLlmToolName,
  toPiTool,
  toStreamingPiTool,
} from "./tool-adapter.js";

const COMMIT_TOOL_NAME = "oren_commit";

export interface PiCognitionAdapterOptions {
  readonly model: Model<any>;
  readonly streamFn: StreamFn;
  readonly messageTimestamp?: () => number;
}

export class PiCognitionAdapter implements CognitionPort, StreamingCognitionPort {
  public constructor(private readonly options: PiCognitionAdapterOptions) {}

  public stream(
    frame: LifeFrame,
    handlers: CognitionHandlers,
    signal: AbortSignal,
  ): AsyncIterable<CognitionEvent> {
    const queue = new AsyncEventQueue<CognitionEvent>();
    void this.runStreamingEpisode(frame, handlers, signal, queue)
      .catch((error: unknown) => {
        queue.push({
          type: "episode.failed",
          message: error instanceof Error ? error.message : String(error),
          usage: { totalTokens: 0 },
        });
      })
      .finally(() => queue.end());
    return queue;
  }

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
    const llmNameCollision = findLlmToolNameCollision(frame.capabilities);
    if (llmNameCollision !== null) {
      return {
        kind: "failed",
        message: llmNameCollision,
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
      label: "提交本轮提议",
      description: "提交最多 16 条类型化提议并结束本轮认知。",
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
            return signal.aborted
              || waitingEffectId !== null
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

  private async runStreamingEpisode(
    frame: LifeFrame,
    handlers: CognitionHandlers,
    signal: AbortSignal,
    queue: AsyncEventQueue<CognitionEvent>,
  ): Promise<void> {
    let waitingEffectId: string | null = null;
    let assistantFailure: string | null = null;
    let assistantAborted = false;
    let totalTokens = 0;
    let turns = 0;
    let utteranceSequence = 0;
    let utteranceId: string | null = null;
    let utteranceStarted = false;
    let emittedText = "";
    const messageTimestamp = this.options.messageTimestamp ?? Date.now;

    if (signal.aborted) {
      queue.push({ type: "episode.aborted", usage: { totalTokens } });
      return;
    }
    const validationFailure = validateFrame(frame);
    if (validationFailure !== null) {
      queue.push({
        type: "episode.failed",
        message: validationFailure,
        usage: { totalTokens },
      });
      return;
    }
    if (frame.maxSteps === 0) {
      queue.push({
        type: "episode.failed",
        message: "Pi maxSteps exhausted before the episode started",
        usage: { totalTokens },
      });
      return;
    }

    const commitTool: AgentTool<typeof CommitSchema> = {
      name: COMMIT_TOOL_NAME,
      label: "提交持久变化或行动意图",
      description: "可选地提交最多 16 条类型化提议；提交后可以继续自然表达。",
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
      async execute(toolCallId, params: Static<typeof CommitSchema>, toolSignal) {
        const proposals = params.proposals as readonly Proposal[];
        queue.push({
          type: "commit.requested",
          commitId: toolCallId,
          proposals,
        });
        const receipt = await handlers.submitCommit(
          { commitId: toolCallId, proposals },
          toolSignal ?? signal,
        );
        queue.push({ type: "commit.resolved", receipt });
        return {
          content: [{
            type: "text",
            text: receipt.kind === "accepted"
              ? `Commit ${toolCallId} accepted.`
              : `Commit ${toolCallId} rejected: ${receipt.reason}`,
          }],
          details: receipt,
          terminate: false,
        };
      },
    };

    const context: AgentContext = {
      systemPrompt: systemPrompt(frame),
      messages: [],
      tools: [
        ...frame.capabilities.map((descriptor) =>
          toStreamingPiTool(descriptor, frame, handlers)
        ),
        commitTool,
      ],
    };

    try {
      await runAgentLoop(
        [{
          role: "user",
          content: userPrompt(frame),
          timestamp: messageTimestamp(),
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
          afterToolCall: async ({ result }, hookSignal) => {
            if (hookSignal?.aborted) return undefined;
            const effectId = waitingEffectFromDetails(result.details);
            if (effectId !== null) waitingEffectId = effectId;
            return undefined;
          },
          shouldStopAfterTurn: () => {
            turns += 1;
            return signal.aborted
              || waitingEffectId !== null
              || turns >= frame.maxSteps;
          },
        },
        observeAgentEvent,
        signal,
        this.options.streamFn,
      );
    } catch (error) {
      if (signal.aborted) {
        queue.push({ type: "episode.aborted", usage: { totalTokens } });
        return;
      }
      queue.push({
        type: "episode.failed",
        message: error instanceof Error ? error.message : String(error),
        usage: { totalTokens },
      });
      return;
    }

    if (signal.aborted || assistantAborted) {
      queue.push({ type: "episode.aborted", usage: { totalTokens } });
      return;
    }
    if (assistantFailure !== null) {
      queue.push({
        type: "episode.failed",
        message: assistantFailure,
        usage: { totalTokens },
      });
      return;
    }
    if (waitingEffectId !== null) {
      queue.push({
        type: "episode.completed",
        reason: "waiting_for_effect",
        effectId: waitingEffectId,
        usage: { totalTokens },
      });
      return;
    }
    queue.push({
      type: "episode.completed",
      reason: turns >= frame.maxSteps ? "max_steps" : "stop",
      usage: { totalTokens },
    });

    function observeAgentEvent(event: AgentEvent): void {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") {
            utteranceSequence += 1;
            utteranceId = `${messageTimestamp()}:${utteranceSequence}`;
            utteranceStarted = false;
            emittedText = "";
          }
          return;
        case "message_update":
          if (
            event.message.role === "assistant"
            && event.assistantMessageEvent.type === "text_delta"
            && event.assistantMessageEvent.delta.length > 0
          ) {
            emitSpeechDelta(event.assistantMessageEvent.delta);
          }
          return;
        case "message_end":
          if (event.message.role !== "assistant") return;
          totalTokens += event.message.usage.totalTokens;
          if (event.message.stopReason === "aborted") {
            assistantAborted = true;
          } else if (event.message.stopReason === "error") {
            assistantFailure = event.message.errorMessage ?? "Pi model stream failed";
          }
          const finalText = event.message.content
            .filter((part): part is Extract<typeof part, { type: "text" }> =>
              part.type === "text")
            .map(({ text }) => text)
            .join("");
          if (finalText.startsWith(emittedText)) {
            emitSpeechDelta(finalText.slice(emittedText.length));
          } else if (emittedText.length === 0) {
            emitSpeechDelta(finalText);
          }
          if (utteranceStarted && utteranceId !== null) {
            queue.push({ type: "speech.completed", utteranceId });
          }
          utteranceId = null;
          utteranceStarted = false;
          emittedText = "";
          return;
        case "tool_execution_start":
          queue.push({
            type: "tool.started",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          return;
        case "tool_execution_end":
          queue.push({
            type: "tool.completed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
          });
          return;
        default:
          return;
      }
    }

    function emitSpeechDelta(text: string): void {
      if (text.length === 0 || utteranceId === null) return;
      if (!utteranceStarted) {
        queue.push({ type: "speech.started", utteranceId });
        utteranceStarted = true;
      }
      queue.push({ type: "speech.delta", utteranceId, text });
      emittedText += text;
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

function findLlmToolNameCollision(
  capabilities: LifeFrame["capabilities"],
): string | null {
  const seen = new Map<string, string>();
  for (const { name } of capabilities) {
    const llmName = toLlmToolName(name);
    if (llmName === COMMIT_TOOL_NAME) {
      return `Capability LLM tool name collides with reserved ${COMMIT_TOOL_NAME}: ${name}`;
    }
    const prior = seen.get(llmName);
    if (prior !== undefined) {
      return `Capability LLM tool names collide after sanitization: "${prior}" and "${name}" both map to "${llmName}"`;
    }
    seen.set(llmName, name);
  }
  return null;
}

function validateFrame(frame: LifeFrame): string | null {
  if (
    !Number.isFinite(frame.maxSteps)
    || !Number.isInteger(frame.maxSteps)
    || frame.maxSteps < 0
  ) {
    return "Invalid maxSteps: expected a finite nonnegative integer";
  }
  if (frame.capabilities.some(({ name }) => name === COMMIT_TOOL_NAME)) {
    return `Capability name is reserved: ${COMMIT_TOOL_NAME}`;
  }
  return findLlmToolNameCollision(frame.capabilities);
}
