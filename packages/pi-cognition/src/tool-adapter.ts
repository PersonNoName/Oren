import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CognitionCapabilityPort, LifeFrame } from "@oren/cognition";
import type { CapabilityDescriptor, JsonObject } from "@oren/kernel";
import type { TSchema } from "typebox";

export function toPiTool(
  descriptor: CapabilityDescriptor,
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
): AgentTool {
  return {
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
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
              text: `External effect queued; execution is pending receipt ${outcome.effectId}.`,
            }],
            details: outcome,
            terminate: true,
          };
        case "rejected":
          return {
            content: [{ type: "text", text: `Capability rejected: ${outcome.reason}` }],
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
