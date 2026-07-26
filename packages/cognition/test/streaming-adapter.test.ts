import { describe, expect, it } from "vitest";
import type { CognitionEvent, LifeFrame } from "../src/index.js";
import {
  ScriptedStreamingCognitionAdapter,
  type CognitionHandlers,
} from "../src/index.js";

const frame: LifeFrame = {
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
};

const unusedHandlers: CognitionHandlers = {
  async invokeCapability() {
    return { kind: "rejected", reason: "unused" };
  },
  async submitCommit({ commitId }) {
    return { kind: "accepted", commitId, stateVersion: 1 };
  },
};

describe("ScriptedStreamingCognitionAdapter", () => {
  it("preserves speech and completion event order", async () => {
    const adapter = new ScriptedStreamingCognitionAdapter(async function* () {
      yield { type: "speech.started", utteranceId: "utterance-1" };
      yield { type: "speech.delta", utteranceId: "utterance-1", text: "你" };
      yield { type: "speech.delta", utteranceId: "utterance-1", text: "好" };
      yield { type: "speech.completed", utteranceId: "utterance-1" };
      yield {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 3 },
      };
    });

    const events: CognitionEvent[] = [];
    for await (const event of adapter.stream(
      frame,
      unusedHandlers,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "speech.started", utteranceId: "utterance-1" },
      { type: "speech.delta", utteranceId: "utterance-1", text: "你" },
      { type: "speech.delta", utteranceId: "utterance-1", text: "好" },
      { type: "speech.completed", utteranceId: "utterance-1" },
      {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 3 },
      },
    ]);
  });

  it("emits an aborted terminal event without calling a pre-aborted script", async () => {
    let scriptCalled = false;
    const adapter = new ScriptedStreamingCognitionAdapter(async function* () {
      scriptCalled = true;
      yield {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 1 },
      };
    });
    const controller = new AbortController();
    controller.abort("shutdown");

    const events: CognitionEvent[] = [];
    for await (const event of adapter.stream(frame, unusedHandlers, controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([{
      type: "episode.aborted",
      usage: { totalTokens: 0 },
    }]);
    expect(scriptCalled).toBe(false);
  });
});
