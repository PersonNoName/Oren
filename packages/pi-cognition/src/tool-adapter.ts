import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  CognitionCapabilityPort,
  CognitionHandlers,
  LifeFrame,
} from "@oren/cognition";
import {
  isImmediateCapability,
  type CapabilityDescriptor,
  type JsonObject,
} from "@oren/kernel";
import type { TSchema } from "typebox";

/** Map internal capability names to LLM tool names (`^[a-zA-Z0-9_-]+$`). */
export function toLlmToolName(capabilityName: string): string {
  return capabilityName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function describeCapabilityForLlm(descriptor: CapabilityDescriptor): string {
  const llmName = toLlmToolName(descriptor.name);
  const mode = isImmediateCapability(descriptor)
    ? "即时能力：当轮返回结果，可继续思考。"
    : "持久能力：调用后本轮思考结束，需等回执后在新的 effect_result 醒来中继续；不要在未见完成回执时重复调用。";
  return `${descriptor.description}（工具名 ${llmName}；内部名 ${descriptor.name}）。${mode}`;
}

export function toPiTool(
  descriptor: CapabilityDescriptor,
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
): AgentTool {
  const llmName = toLlmToolName(descriptor.name);
  return {
    name: llmName,
    label: llmName,
    description: describeCapabilityForLlm(descriptor),
    parameters: descriptor.inputSchema as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }

      const invocationSignal = signal ?? new AbortController().signal;
      const outcome = await raceWithAbort(
        capabilityPort.invoke({
          orenId: frame.orenId,
          descriptor,
          arguments: params as JsonObject,
          stateVersion: frame.stateVersion,
          correlationId: frame.correlationId,
        }, invocationSignal),
        invocationSignal,
      );

      switch (outcome.kind) {
        case "completed":
          return {
            content: [{ type: "text", text: JSON.stringify(outcome.output) }],
            details: outcome,
          };
        case "waiting_for_effect":
          return {
            content: [{
              type: "text",
              text: `持久效应已排队，等待回执 ${outcome.effectId}；本轮思考结束，请勿重复调用同一持久能力。`,
            }],
            details: outcome,
            terminate: true,
          };
        case "rejected":
          return {
            content: [{ type: "text", text: `能力被拒绝：${outcome.reason}` }],
            details: outcome,
          };
      }
    },
  };
}

export function toStreamingPiTool(
  descriptor: CapabilityDescriptor,
  frame: LifeFrame,
  handlers: CognitionHandlers,
): AgentTool {
  const llmName = toLlmToolName(descriptor.name);
  return {
    name: llmName,
    label: llmName,
    description: describeCapabilityForLlm(descriptor),
    parameters: descriptor.inputSchema as TSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }

      const invocationSignal = signal ?? new AbortController().signal;
      const outcome = await raceWithAbort(
        handlers.invokeCapability({
          orenId: frame.orenId,
          descriptor,
          arguments: params as JsonObject,
          correlationId: frame.correlationId,
        }, invocationSignal),
        invocationSignal,
      );

      switch (outcome.kind) {
        case "completed":
          return {
            content: [{ type: "text", text: JSON.stringify(outcome.output) }],
            details: outcome,
          };
        case "waiting_for_effect":
          return {
            content: [{
              type: "text",
              text: `持久效应已排队，等待回执 ${outcome.effectId}；本轮思考结束，请勿重复调用同一持久能力。`,
            }],
            details: outcome,
            terminate: true,
          };
        case "rejected":
          return {
            content: [{ type: "text", text: `能力被拒绝：${outcome.reason}` }],
            details: outcome,
          };
      }
    },
  };
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Capability invocation aborted");
}
