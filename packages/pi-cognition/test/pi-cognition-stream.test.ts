import { describe, expect, it } from "vitest";
import type {
  CognitionEvent,
  CognitionHandlers,
} from "@oren/cognition";
import type { CapabilityDescriptor, Proposal } from "@oren/kernel";
import { PiCognitionAdapter, toLlmToolName } from "../src/index.js";
import {
  assistantMessage,
  createFrame,
  createMockModel,
  createSequenceStream,
  createTextDeltaStream,
} from "./fixtures.js";

const unusedHandlers: CognitionHandlers = {
  async invokeCapability() {
    return { kind: "rejected", reason: "unused" };
  },
  async submitCommit({ commitId }) {
    return { kind: "accepted", commitId, stateVersion: 1 };
  },
};

const persistentDescriptor: CapabilityDescriptor = {
  extensionId: "test-calendar",
  name: "calendar.create",
  description: "Create a calendar event",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  outputSchema: { type: "object" },
  permissionRequirements: [],
  traits: ["external_side_effect"],
  cancellable: true,
  timeoutMs: 1000,
};

async function collect(events: AsyncIterable<CognitionEvent>): Promise<CognitionEvent[]> {
  const collected: CognitionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("PiCognitionAdapter streaming contract", () => {
  it("delivers a prose-only foreground response without requiring a commit", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{ type: "text", text: "自然地回应。" }], 4),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const events = await collect(adapter.stream(
      createFrame(),
      unusedHandlers,
      new AbortController().signal,
    ));

    expect(events).toEqual([
      {
        type: "speech.started",
        utteranceId: "1700000000000:1",
      },
      {
        type: "speech.delta",
        utteranceId: "1700000000000:1",
        text: "自然地回应。",
      },
      {
        type: "speech.completed",
        utteranceId: "1700000000000:1",
      },
      {
        type: "episode.completed",
        reason: "stop",
        usage: { totalTokens: 4 },
      },
    ]);
  });

  it("emits provider text deltas before the assistant message completes", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createTextDeltaStream(["你", "好"], 3),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const events = await collect(adapter.stream(
      createFrame(),
      unusedHandlers,
      new AbortController().signal,
    ));

    expect(events.slice(0, 4)).toEqual([
      {
        type: "speech.started",
        utteranceId: "1700000000000:1",
      },
      {
        type: "speech.delta",
        utteranceId: "1700000000000:1",
        text: "你",
      },
      {
        type: "speech.delta",
        utteranceId: "1700000000000:1",
        text: "好",
      },
      {
        type: "speech.completed",
        utteranceId: "1700000000000:1",
      },
    ]);
  });

  it("returns an accepted commit receipt to Pi and continues to natural speech", async () => {
    const proposal: Proposal = {
      type: "Remember",
      text: "用户更喜欢自然对话",
      kind: "user_statement",
    };
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: { proposals: [proposal] },
        }]),
        assistantMessage([{ type: "text", text: "我记住了。" }]),
      ], () => streamCalls += 1),
      messageTimestamp: () => 1_700_000_000_000,
    });
    const handlers: CognitionHandlers = {
      ...unusedHandlers,
      async submitCommit({ commitId, proposals }) {
        expect(proposals).toEqual([proposal]);
        return { kind: "accepted", commitId, stateVersion: 2 };
      },
    };

    const events = await collect(adapter.stream(
      createFrame(),
      handlers,
      new AbortController().signal,
    ));

    expect(streamCalls).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      {
        type: "commit.requested",
        commitId: "commit-1",
        proposals: [proposal],
      },
      {
        type: "commit.resolved",
        receipt: {
          kind: "accepted",
          commitId: "commit-1",
          stateVersion: 2,
        },
      },
      {
        type: "speech.delta",
        utteranceId: "1700000000000:2",
        text: "我记住了。",
      },
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "episode.completed",
      reason: "stop",
    });
  });

  it("returns a rejected commit receipt to Pi and still allows a natural reply", async () => {
    const proposal: Proposal = {
      type: "Remember",
      text: "an invalid memory",
      kind: "oren_judgment",
    };
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-rejected",
          name: "oren_commit",
          arguments: { proposals: [proposal] },
        }]),
        assistantMessage([{ type: "text", text: "那我先不记。" }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });
    const handlers: CognitionHandlers = {
      ...unusedHandlers,
      async submitCommit({ commitId }) {
        return {
          kind: "rejected",
          commitId,
          reason: "stale state version",
        };
      },
    };

    const events = await collect(adapter.stream(
      createFrame(),
      handlers,
      new AbortController().signal,
    ));

    expect(events).toEqual(expect.arrayContaining([
      {
        type: "commit.resolved",
        receipt: {
          kind: "rejected",
          commitId: "commit-rejected",
          reason: "stale state version",
        },
      },
      {
        type: "speech.delta",
        utteranceId: "1700000000000:2",
        text: "那我先不记。",
      },
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "episode.completed",
      reason: "stop",
    });
  });

  it("ends with waiting_for_effect when a persistent capability is queued", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "create-1",
          name: toLlmToolName(persistentDescriptor.name),
          arguments: { title: "Meet" },
        }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });
    const handlers: CognitionHandlers = {
      ...unusedHandlers,
      async invokeCapability() {
        return { kind: "waiting_for_effect", effectId: "effect-1" };
      },
    };

    const events = await collect(adapter.stream(
      createFrame({ capabilities: [persistentDescriptor] }),
      handlers,
      new AbortController().signal,
    ));

    expect(events.at(-1)).toEqual({
      type: "episode.completed",
      reason: "waiting_for_effect",
      effectId: "effect-1",
      usage: { totalTokens: 2 },
    });
    expect(events.some(({ type }) => type.startsWith("speech."))).toBe(false);
  });
});
