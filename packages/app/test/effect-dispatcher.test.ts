import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilityInvocation, CapabilityResult, JsonObject } from "@oren/kernel";
import { EffectDispatcher } from "../src/index.js";

interface ClaimedEffect {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: {
    readonly effectId: string;
    readonly orenId: string;
    readonly correlationId: string;
    readonly capability: string;
    readonly arguments: JsonObject;
    readonly grantIds: readonly string[];
    readonly stateVersion: number;
  };
  readonly attempts: number;
}

type TerminalPayload =
  | { readonly type: "EffectCompleted"; readonly effectId: string; readonly receipt: JsonObject }
  | { readonly type: "EffectFailed"; readonly effectId: string; readonly code: string; readonly message: string }
  | { readonly type: "EffectUncertain"; readonly effectId: string; readonly message: string };

function claimedEffect(
  effectId: string,
  attempts = 1,
  capability = "test.increment",
): ClaimedEffect {
  return {
    effectId,
    orenId: "oren-1",
    capability,
    effect: {
      effectId,
      orenId: "oren-1",
      correlationId: `corr:${effectId}`,
      capability,
      arguments: { by: 1 },
      grantIds: ["grant-1"],
      stateVersion: 1,
    },
    attempts,
  };
}

function repositoryFor(rows: readonly ClaimedEffect[]) {
  const terminalPayloads: TerminalPayload[] = [];
  return {
    terminalPayloads,
    repository: {
      claimOutbox: () => [...rows],
      finishEffect: (
        _effectId: string,
        _orenId: string,
        _correlationId: string,
        payload: TerminalPayload,
      ) => {
        terminalPayloads.push(payload);
      },
    },
  };
}

function registryFor(extension: {
  invoke(invocation: CapabilityInvocation, signal: AbortSignal): Promise<CapabilityResult>;
  query?(effectId: string, signal: AbortSignal): Promise<CapabilityResult>;
}, timeoutMs = 1_000) {
  return {
    resolve: () => ({
      descriptor: { timeoutMs },
      extension,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EffectDispatcher", () => {
  it("marks a dispatched non-queryable effect uncertain instead of sending it twice", async () => {
    let invocations = 0;
    const { repository, terminalPayloads } = repositoryFor([claimedEffect("effect-1", 2)]);
    const registry = registryFor({
      invoke: async () => {
        invocations += 1;
        throw new Error("must not resend");
      },
    });

    const results = await new EffectDispatcher(repository, registry, "worker-1").runOnce();

    expect(invocations).toBe(0);
    expect(results).toEqual([{ effectId: "effect-1", status: "uncertain" }]);
    expect(terminalPayloads).toEqual([{
      type: "EffectUncertain",
      effectId: "effect-1",
      message: "Previous dispatch outcome cannot be queried without risking a duplicate effect",
    }]);
  });

  it.each([
    {
      result: { status: "completed", output: { value: 2 }, receipt: { transactionId: "tx-1" } } as const,
      payload: {
        type: "EffectCompleted",
        effectId: "effect-1",
        receipt: { transactionId: "tx-1" },
      },
      status: "completed",
    },
    {
      result: { status: "failed", code: "DECLINED", message: "declined by provider" } as const,
      payload: {
        type: "EffectFailed",
        effectId: "effect-1",
        code: "DECLINED",
        message: "declined by provider",
      },
      status: "failed",
    },
    {
      result: { status: "uncertain", message: "provider cannot determine outcome" } as const,
      payload: {
        type: "EffectUncertain",
        effectId: "effect-1",
        message: "provider cannot determine outcome",
      },
      status: "uncertain",
    },
  ])("maps a reconciled $status result exactly", async ({ result, payload, status }) => {
    let invocations = 0;
    const queries: string[] = [];
    const { repository, terminalPayloads } = repositoryFor([claimedEffect("effect-1", 2)]);
    const registry = registryFor({
      invoke: async () => {
        invocations += 1;
        return result;
      },
      query: async (effectId) => {
        queries.push(effectId);
        return result;
      },
    });

    const results = await new EffectDispatcher(repository, registry, "worker-1").runOnce();

    expect(invocations).toBe(0);
    expect(queries).toEqual(["effect-1"]);
    expect(results).toEqual([{ effectId: "effect-1", status }]);
    expect(terminalPayloads).toEqual([payload]);
  });

  it("invokes a first attempt with an injected deadline and preserves its receipt", async () => {
    const invocations: CapabilityInvocation[] = [];
    const { repository, terminalPayloads } = repositoryFor([claimedEffect("effect-1")]);
    const registry = registryFor({
      invoke: async (invocation) => {
        invocations.push(invocation);
        return {
          status: "completed",
          output: { value: 2 },
          receipt: { provider: "counter", sequence: 7 },
        };
      },
    }, 2_500);

    const results = await new EffectDispatcher(repository, registry, "worker-1", {
      now: () => Date.parse("2026-07-23T00:00:00.000Z"),
    }).runOnce();

    expect(invocations).toEqual([{
      effectId: "effect-1",
      orenId: "oren-1",
      capability: "test.increment",
      arguments: { by: 1 },
      grantIds: ["grant-1"],
      stateVersion: 1,
      deadline: "2026-07-23T00:00:02.500Z",
    }]);
    expect(results).toEqual([{ effectId: "effect-1", status: "completed" }]);
    expect(terminalPayloads).toEqual([{
      type: "EffectCompleted",
      effectId: "effect-1",
      receipt: { provider: "counter", sequence: 7 },
    }]);
  });

  it.each([
    { attempts: 1, operation: "dispatch", lateSettlement: "resolve" },
    { attempts: 2, operation: "reconciliation", lateSettlement: "reject" },
  ])("settles a hanging $operation even when the extension ignores AbortSignal", async ({
    attempts,
    operation,
    lateSettlement,
  }) => {
    vi.useFakeTimers();
    let settleLate!: (result: CapabilityResult) => void;
    let rejectLate!: (error: Error) => void;
    const hanging = new Promise<CapabilityResult>((resolve, reject) => {
      settleLate = resolve;
      rejectLate = reject;
    });
    const { repository, terminalPayloads } = repositoryFor([claimedEffect("effect-1", attempts)]);
    const registry = registryFor({
      invoke: async () => hanging,
      query: async () => hanging,
    }, 50);
    const run = new EffectDispatcher(repository, registry, "worker-1").runOnce();

    await vi.advanceTimersByTimeAsync(50);

    await expect(run).resolves.toEqual([{ effectId: "effect-1", status: "uncertain" }]);
    expect(terminalPayloads).toEqual([{
      type: "EffectUncertain",
      effectId: "effect-1",
      message: `Effect ${operation} timed out after 50ms; outcome is unknown`,
    }]);

    if (lateSettlement === "resolve") {
      settleLate({ status: "completed", output: null, receipt: { tooLate: true } });
    } else {
      rejectLate(new Error("late provider rejection"));
    }
    await Promise.resolve();
    expect(terminalPayloads).toHaveLength(1);
  });

  it("continues processing later rows after registry and extension failures", async () => {
    const { repository, terminalPayloads } = repositoryFor([
      claimedEffect("effect-resolve", 1, "test.missing"),
      claimedEffect("effect-invoke", 1, "test.throws"),
      claimedEffect("effect-complete", 1, "test.increment"),
    ]);
    const registry = {
      resolve: (capability: string) => {
        if (capability === "test.missing") throw new Error("extension is inactive");
        return {
          descriptor: { timeoutMs: 1_000 },
          extension: {
            invoke: async (): Promise<CapabilityResult> => {
              if (capability === "test.throws") throw new Error("provider unavailable");
              return { status: "completed", output: 2, receipt: { sequence: 8 } };
            },
          },
        };
      },
    };

    const results = await new EffectDispatcher(repository, registry, "worker-1").runOnce();

    expect(results).toEqual([
      { effectId: "effect-resolve", status: "uncertain" },
      { effectId: "effect-invoke", status: "uncertain" },
      { effectId: "effect-complete", status: "completed" },
    ]);
    expect(terminalPayloads.map((payload) => payload.type)).toEqual([
      "EffectUncertain",
      "EffectUncertain",
      "EffectCompleted",
    ]);
    expect(terminalPayloads[0]).toMatchObject({ message: "Extension resolution failed: extension is inactive" });
    expect(terminalPayloads[1]).toMatchObject({ message: "Effect dispatch failed before its outcome was known: provider unavailable" });
  });

  it("does not turn a finishEffect persistence failure into extension uncertainty", async () => {
    const rows = [claimedEffect("effect-persist"), claimedEffect("effect-later")];
    const finishCalls: string[] = [];
    const repository = {
      claimOutbox: () => rows,
      finishEffect: (effectId: string) => {
        finishCalls.push(effectId);
        if (effectId === "effect-persist") throw new Error("disk full");
      },
    };
    const registry = registryFor({
      invoke: async () => ({ status: "completed", output: 2, receipt: { committed: true } }),
    });

    const results = await new EffectDispatcher(repository, registry, "worker-1").runOnce();

    expect(finishCalls).toEqual(["effect-persist", "effect-later"]);
    expect(results).toEqual([
      { effectId: "effect-persist", status: "persistence_failed" },
      { effectId: "effect-later", status: "completed" },
    ]);
  });
});
