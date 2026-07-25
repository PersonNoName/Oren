import type { LifeFrame } from "@oren/cognition";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  EventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { Proposal } from "@oren/kernel";

const DEFAULT_USAGE: AssistantMessage["usage"] = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  public constructor(message: AssistantMessage) {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error(`Unexpected terminal fake event: ${event.type}`);
      },
    );
    queueMicrotask(() => {
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        this.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        this.push({ type: "done", reason: message.stopReason, message });
      }
    });
  }
}

export function createMockModel(): Model<"openai-responses"> {
  return {
    id: "mock",
    name: "mock",
    api: "openai-responses",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

export function assistantMessage(
  content: AssistantMessage["content"],
  totalTokens = 2,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "mock",
    model: "mock",
    usage: { ...DEFAULT_USAGE, totalTokens },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1_700_000_000_000,
  };
}

export function failedAssistantMessage(
  stopReason: "aborted" | "error",
  errorMessage: string,
  totalTokens = 2,
): AssistantMessage {
  return {
    ...assistantMessage([], totalTokens),
    stopReason,
    errorMessage,
  };
}

export function createSequenceStream(
  messages: readonly AssistantMessage[],
  onCall?: () => void,
) {
  let index = 0;
  return () => {
    onCall?.();
    const message = messages[index++];
    if (!message) throw new Error("Fake Pi stream exhausted");
    return new MockAssistantStream(message);
  };
}

export function createCommitStream(
  proposals: readonly Proposal[],
  totalTokens = 2,
) {
  return createSequenceStream([
    assistantMessage([{
      type: "toolCall",
      id: "commit-1",
      name: "oren_commit",
      arguments: { proposals },
    }], totalTokens),
  ]);
}

export function createFrame(
  overrides: Partial<LifeFrame> = {},
): LifeFrame {
  return {
    orenId: "oren-1",
    correlationId: "corr-1",
    stateVersion: 1,
    identity: { ethosVersion: 1, disposition: "attentive" },
    attention: { focus: null, threadIds: [] },
    relationship: { primaryPersonId: "person-1", contextRef: null },
    trigger: { kind: "foreground_user", summary: "hello" },
    memoryPins: [],
    capabilities: [],
    maxSteps: 8,
    ...overrides,
  };
}
