import { describe, expect, it, vi } from "vitest";
import type { CapabilityDescriptor, Proposal } from "@oren/kernel";
import { PiCognitionAdapter, toLlmToolName } from "../src/index.js";
import {
  assistantMessage,
  createCommitStream,
  createFrame,
  createMockModel,
  createSequenceStream,
  failedAssistantMessage,
} from "./fixtures.js";

const immediateDescriptor: CapabilityDescriptor = {
  extensionId: "test-memory",
  name: "memory.lookup",
  description: "Look up a memory",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  outputSchema: { type: "object" },
  permissionRequirements: [],
  traits: ["read_only", "replay_safe"],
  cancellable: true,
  timeoutMs: 1000,
};

const persistentDescriptor: CapabilityDescriptor = {
  ...immediateDescriptor,
  extensionId: "test-calendar",
  name: "calendar.create",
  description: "Create a calendar event",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  traits: ["external_side_effect"],
};

const noAction: Proposal = { type: "NoAction", reason: "done" };

describe("PiCognitionAdapter", () => {
  it("accepts proposals only through oren_commit", async () => {
    let observedTimestamp: number | undefined;
    const commitStream = createCommitStream([{
      type: "AdvanceThread",
      threadId: "thread-1",
      summary: "Pi is the inner cognition engine",
    }]);
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: (model, context, options) => {
        observedTimestamp = context.messages[0]?.timestamp;
        void model;
        void options;
        return commitStream();
      },
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: "completed",
      proposals: [{ type: "AdvanceThread", threadId: "thread-1" }],
    });
    expect(observedTimestamp).toBe(1_700_000_000_000);
  });

  it("continues after an immediate capability and can then commit", async () => {
    const invoke = vi.fn(async () => ({
      kind: "completed",
      output: { answer: "remembered" },
    } as const));
    const streamFn = createSequenceStream([
      assistantMessage([{
        type: "toolCall",
        id: "lookup-1",
        name: toLlmToolName(immediateDescriptor.name),
        arguments: { query: "hello" },
      }]),
      assistantMessage([{
        type: "toolCall",
        id: "commit-1",
        name: "oren_commit",
        arguments: { proposals: [noAction] },
      }]),
    ]);
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn,
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [immediateDescriptor] }),
      { invoke },
      new AbortController().signal,
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: "completed", proposals: [noAction] });
  });

  it("fails when Pi returns prose without a commit tool call", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{ type: "text", text: "I am done." }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toEqual({
      kind: "failed",
      message: "Pi ended without oren_commit",
      usage: { totalTokens: 2 },
    });
  });

  it("blocks a capability after a commit in the same tool-call batch", async () => {
    const invoke = vi.fn(async () => ({
      kind: "completed",
      output: { answer: "must not execute" },
    } as const));
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([
          {
            type: "toolCall",
            id: "commit-1",
            name: "oren_commit",
            arguments: { proposals: [noAction] },
          },
          {
            type: "toolCall",
            id: "lookup-1",
            name: toLlmToolName(immediateDescriptor.name),
            arguments: { query: "must not execute" },
          },
        ]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [immediateDescriptor] }),
      { invoke },
      new AbortController().signal,
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "completed", proposals: [noAction] });
  });

  it("stops the episode when a persistent capability is waiting for its effect", async () => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "create-1",
          name: toLlmToolName(persistentDescriptor.name),
          arguments: { title: "Meet" },
        }]),
      ], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [persistentDescriptor] }),
      { invoke: async () => ({ kind: "waiting_for_effect", effectId: "effect-1" }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(1);
    expect(result).toEqual({
      kind: "waiting_for_effect",
      effectId: "effect-1",
      usage: { totalTokens: 2 },
    });
  });

  it("gives waiting effects precedence over a commit in the same turn", async () => {
    const invoke = vi.fn(async () => ({
      kind: "waiting_for_effect",
      effectId: "effect-1",
    } as const));
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([
          {
            type: "toolCall",
            id: "create-1",
            name: toLlmToolName(persistentDescriptor.name),
            arguments: { title: "Meet" },
          },
          {
            type: "toolCall",
            id: "create-2",
            name: toLlmToolName(persistentDescriptor.name),
            arguments: { title: "Must not execute" },
          },
          {
            type: "toolCall",
            id: "commit-1",
            name: "oren_commit",
            arguments: { proposals: [noAction] },
          },
        ]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [persistentDescriptor] }),
      { invoke },
      new AbortController().signal,
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(result.kind).toBe("waiting_for_effect");
  });

  it("honors an already-aborted signal without starting a stream", async () => {
    let streamCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      controller.signal,
    );

    expect(streamCalls).toBe(0);
    expect(result).toEqual({ kind: "aborted", usage: { totalTokens: 0 } });
  });

  it.each(["resolve", "reject"] as const)(
    "settles an aborted capability before a second stream and ignores its late %s",
    async (lateSettlement) => {
      let markInvocationStarted: (() => void) | undefined;
      const invocationStarted = new Promise<void>((resolve) => {
        markInvocationStarted = resolve;
      });
      let resolveCapability: ((outcome: {
        readonly kind: "waiting_for_effect";
        readonly effectId: string;
      }) => void) | undefined;
      let rejectCapability: ((error: unknown) => void) | undefined;
      const capabilityOutcome = new Promise<{
        readonly kind: "waiting_for_effect";
        readonly effectId: string;
      }>((resolve, reject) => {
        resolveCapability = resolve;
        rejectCapability = reject;
      });
      const controller = new AbortController();
      let observedSignal: AbortSignal | undefined;
      let streamCalls = 0;
      const firstStream = createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "lookup-1",
          name: toLlmToolName(immediateDescriptor.name),
          arguments: { query: "hang" },
        }]),
      ]);
      const adapter = new PiCognitionAdapter({
        model: createMockModel(),
        streamFn: () => {
          streamCalls += 1;
          return streamCalls === 1
            ? firstStream()
            : new Promise<never>(() => undefined);
        },
        messageTimestamp: () => 1_700_000_000_000,
      });
      const run = adapter.run(
        createFrame({ capabilities: [immediateDescriptor] }),
        {
          invoke: async (_input, signal) => {
            observedSignal = signal;
            markInvocationStarted?.();
            return capabilityOutcome;
          },
        },
        controller.signal,
      );

      await invocationStarted;
      controller.abort(new Error("stop"));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        run,
        new Promise<"timed_out">((resolve) => {
          timeout = setTimeout(() => resolve("timed_out"), 1_000);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);

      expect(observedSignal).toBe(controller.signal);
      expect({ settled, streamCalls }).toEqual({
        settled: { kind: "aborted", usage: { totalTokens: 2 } },
        streamCalls: 1,
      });

      const unhandledRejections: unknown[] = [];
      const recordUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", recordUnhandledRejection);
      try {
        if (lateSettlement === "resolve") {
          resolveCapability?.({
            kind: "waiting_for_effect",
            effectId: "late-effect",
          });
        } else {
          rejectCapability?.(new Error("late capability failure"));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(settled).toEqual({ kind: "aborted", usage: { totalTokens: 2 } });
        expect(streamCalls).toBe(1);
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", recordUnhandledRejection);
      }
    },
  );

  it("maps Pi's aborted terminal message and its usage to an aborted outcome", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        failedAssistantMessage("aborted", "request aborted", 3),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toEqual({ kind: "aborted", usage: { totalTokens: 3 } });
  });

  it("contains Pi's terminal model error as a failed outcome", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        failedAssistantMessage("error", "model unavailable", 4),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame(),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toEqual({
      kind: "failed",
      message: "model unavailable",
      usage: { totalTokens: 4 },
    });
  });

  it("fails after maxSteps tool turns when Pi never commits", async () => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "lookup-1",
          name: toLlmToolName(immediateDescriptor.name),
          arguments: { query: "one" },
        }]),
        assistantMessage([{
          type: "toolCall",
          id: "lookup-2",
          name: toLlmToolName(immediateDescriptor.name),
          arguments: { query: "two" },
        }]),
      ], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [immediateDescriptor], maxSteps: 2 }),
      { invoke: async () => ({ kind: "completed", output: null }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(2);
    expect(result).toEqual({
      kind: "failed",
      message: "Pi ended without oren_commit",
      usage: { totalTokens: 4 },
    });
  });

  it("does not start a model turn when maxSteps is zero", async () => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ maxSteps: 0 }),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(0);
    expect(result).toEqual({
      kind: "failed",
      message: "Pi ended without oren_commit",
      usage: { totalTokens: 0 },
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["fractional", 1.5],
    ["negative", -1],
  ])("rejects a %s maxSteps budget before starting Pi", async (_label, maxSteps) => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ maxSteps }),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(0);
    expect(result).toEqual({
      kind: "failed",
      message: "Invalid maxSteps: expected a finite nonnegative integer",
      usage: { totalTokens: 0 },
    });
  });

  it("accumulates assistant usage across turns", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "lookup-1",
          name: toLlmToolName(immediateDescriptor.name),
          arguments: { query: "hello" },
        }], 5),
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: { proposals: [noAction] },
        }], 7),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ capabilities: [immediateDescriptor] }),
      { invoke: async () => ({ kind: "completed", output: null }) },
      new AbortController().signal,
    );

    expect(result.usage.totalTokens).toBe(12);
  });

  it("contains malformed commit input instead of accepting proposals", async () => {
    const malformed = {
      proposals: Array.from({ length: 17 }, () => noAction),
    };
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: malformed,
        }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ maxSteps: 1 }),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result.kind).toBe("failed");
    expect(result).not.toMatchObject({ kind: "completed" });
  });

  it("rejects proposal fields outside the typed commit schema", async () => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: {
            proposals: [{ ...noAction, stateMutation: { disposition: "reckless" } }],
          },
        }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ maxSteps: 1 }),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result.kind).toBe("failed");
  });

  it.each([
    {
      label: "NoAction number reason",
      proposal: { type: "NoAction", reason: 42 },
    },
    {
      label: "AdvanceThread non-string fields",
      proposal: { type: "AdvanceThread", threadId: 7, summary: true },
    },
    {
      label: "ScheduleWake numeric fields",
      proposal: {
        type: "ScheduleWake",
        scheduleId: 0,
        at: 0,
        purpose: 0,
      },
    },
  ])("strictly rejects raw $label instead of accepting Pi-coerced strings", async ({ proposal }) => {
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: { proposals: [proposal] },
        }]),
      ]),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({ maxSteps: 1 }),
      { invoke: async () => ({ kind: "rejected", reason: "unused" }) },
      new AbortController().signal,
    );

    expect(result).toEqual({
      kind: "failed",
      message: "Pi ended without oren_commit",
      usage: { totalTokens: 2 },
    });
  });

  it("rejects a capability named oren_commit before starting the Pi loop", async () => {
    const invoke = vi.fn(async () => ({
      kind: "completed",
      output: null,
    } as const));
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([
        assistantMessage([{
          type: "toolCall",
          id: "commit-1",
          name: "oren_commit",
          arguments: { proposals: [noAction] },
        }]),
      ], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({
        capabilities: [{ ...immediateDescriptor, name: "oren_commit" }],
      }),
      { invoke },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "failed",
      message: "Capability name is reserved: oren_commit",
      usage: { totalTokens: 0 },
    });
  });

  it("rejects capabilities whose sanitized LLM names collide", async () => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({
        capabilities: [
          { ...immediateDescriptor, name: "foo.bar" },
          { ...immediateDescriptor, name: "foo_bar" },
        ],
      }),
      { invoke: async () => ({ kind: "completed", output: null }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(0);
    expect(result).toEqual({
      kind: "failed",
      message: 'Capability LLM tool names collide after sanitization: "foo.bar" and "foo_bar" both map to "foo_bar"',
      usage: { totalTokens: 0 },
    });
  });

  it("rejects a capability whose sanitized name collides with oren_commit", async () => {
    let streamCalls = 0;
    const adapter = new PiCognitionAdapter({
      model: createMockModel(),
      streamFn: createSequenceStream([], () => streamCalls++),
      messageTimestamp: () => 1_700_000_000_000,
    });

    const result = await adapter.run(
      createFrame({
        capabilities: [{ ...immediateDescriptor, name: "oren.commit" }],
      }),
      { invoke: async () => ({ kind: "completed", output: null }) },
      new AbortController().signal,
    );

    expect(streamCalls).toBe(0);
    expect(result).toEqual({
      kind: "failed",
      message: "Capability LLM tool name collides with reserved oren_commit: oren.commit",
      usage: { totalTokens: 0 },
    });
  });
});
