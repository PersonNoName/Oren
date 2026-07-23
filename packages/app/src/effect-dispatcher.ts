import { types as utilTypes } from "node:util";
import {
  canonicalizeJson,
  type CapabilityInvocation,
  type CapabilityResult,
  type CoreEvent,
  type Effect,
  type JsonObject,
  type JsonValue,
} from "@oren/kernel";

export interface ClaimedEffect {
  readonly effectId: string;
  readonly orenId: string;
  readonly capability: string;
  readonly effect: Effect;
  readonly attempts: number;
}

type TerminalEffectEvent =
  | Extract<CoreEvent, { type: "EffectCompleted" }>
  | Extract<CoreEvent, { type: "EffectFailed" }>
  | Extract<CoreEvent, { type: "EffectUncertain" }>;

export interface EffectRepository {
  claimOutbox(worker: string, limit: number): ClaimedEffect[];
  finishEffect(
    effectId: string,
    orenId: string,
    correlationId: string,
    payload: TerminalEffectEvent,
  ): void;
}

interface EffectExtension {
  invoke(invocation: CapabilityInvocation, signal: AbortSignal): Promise<CapabilityResult>;
  query?(effectId: string, signal: AbortSignal): Promise<CapabilityResult>;
}

export interface EffectRegistry {
  resolve(name: string): {
    readonly descriptor: { readonly timeoutMs: number };
    readonly extension: EffectExtension;
  };
}

export interface EffectDispatcherOptions {
  readonly now?: () => number;
  readonly claimLimit?: number;
}

export interface EffectDispatchResult {
  readonly effectId: string;
  readonly status: CapabilityResult["status"] | "invalid_result" | "persistence_failed";
}

const UNKNOWN_EXTENSION_ERROR = "Unknown extension error";
const isNativeError = utilTypes.isNativeError;
const timeoutErrors = new WeakSet<object>();

class EffectTimeoutError extends Error {
  public constructor(
    public readonly operation: "dispatch" | "reconciliation",
    public readonly timeoutMs: number,
  ) {
    super(`Effect ${operation} timed out after ${timeoutMs}ms; outcome is unknown`);
    timeoutErrors.add(this);
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    (typeof error !== "object" || error === null)
    && typeof error !== "function"
  ) {
    return UNKNOWN_EXTENSION_ERROR;
  }
  if (!isNativeError(error)) return UNKNOWN_EXTENSION_ERROR;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && typeof descriptor.value === "string"
      ? descriptor.value
      : UNKNOWN_EXTENSION_ERROR;
  } catch {
    return UNKNOWN_EXTENSION_ERROR;
  }
}

function isEffectTimeoutError(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null)
    || typeof error === "function"
  ) && timeoutErrors.has(error);
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalizeCapabilityResult(value: unknown): CapabilityResult | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const result = canonical.value;
  if (result.status === "completed") {
    return hasExactKeys(result, ["status", "output", "receipt"])
      && isRecord(result.receipt)
      ? result as CapabilityResult
      : undefined;
  }
  if (result.status === "failed") {
    return hasExactKeys(result, ["status", "code", "message"])
      && typeof result.code === "string"
      && typeof result.message === "string"
      ? result as CapabilityResult
      : undefined;
  }
  if (result.status === "uncertain") {
    return hasExactKeys(result, ["status", "message"])
      && typeof result.message === "string"
      ? result as CapabilityResult
      : undefined;
  }
  return undefined;
}

export class EffectDispatcher {
  private readonly now: () => number;
  private readonly claimLimit: number;

  public constructor(
    private readonly repository: EffectRepository,
    private readonly registry: EffectRegistry,
    private readonly workerId: string,
    options: EffectDispatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.claimLimit = options.claimLimit ?? 8;
  }

  public async runOnce(): Promise<EffectDispatchResult[]> {
    const claimed = this.repository.claimOutbox(this.workerId, this.claimLimit);
    const results: EffectDispatchResult[] = [];
    for (const row of claimed) {
      results.push(await this.processClaimedEffect(row));
    }
    return results;
  }

  private async processClaimedEffect(row: ClaimedEffect): Promise<EffectDispatchResult> {
    let resolved: ReturnType<EffectRegistry["resolve"]>;
    try {
      resolved = this.registry.resolve(row.capability);
    } catch (error) {
      if (row.attempts === 1) {
        return this.persist(row, {
          type: "EffectFailed",
          effectId: row.effectId,
          code: "EXTENSION_RESOLUTION_FAILED",
          message: `Extension resolution failed before dispatch: ${errorMessage(error)}`,
        }, "failed");
      }
      return this.persist(row, {
        type: "EffectUncertain",
        effectId: row.effectId,
        message: `Extension resolution failed while reconciling a previous dispatch: ${errorMessage(error)}`,
      }, "uncertain");
    }

    const { descriptor, extension } = resolved;
    let rawResult: unknown;
    try {
      if (row.attempts > 1) {
        if (!extension.query) {
          return this.persist(row, {
            type: "EffectUncertain",
            effectId: row.effectId,
            message: "Previous dispatch outcome cannot be queried without risking a duplicate effect",
          }, "uncertain");
        }
        rawResult = await this.runWithTimeout(
          "reconciliation",
          descriptor.timeoutMs,
          (signal) => extension.query!(row.effectId, signal),
        );
      } else {
        const invocation: CapabilityInvocation = {
          effectId: row.effect.effectId,
          orenId: row.orenId,
          capability: row.effect.capability,
          arguments: row.effect.arguments,
          grantIds: row.effect.grantIds,
          stateVersion: row.effect.stateVersion,
          deadline: new Date(this.now() + descriptor.timeoutMs).toISOString(),
        };
        rawResult = await this.runWithTimeout(
          "dispatch",
          descriptor.timeoutMs,
          (signal) => extension.invoke(invocation, signal),
        );
      }
    } catch (error) {
      const message = isEffectTimeoutError(error)
        ? errorMessage(error)
        : `Effect ${row.attempts > 1 ? "reconciliation" : "dispatch"} failed before its outcome was known: ${errorMessage(error)}`;
      return this.persist(row, {
        type: "EffectUncertain",
        effectId: row.effectId,
        message,
      }, "uncertain");
    }

    const result = canonicalizeCapabilityResult(rawResult);
    if (result === undefined) {
      return { effectId: row.effectId, status: "invalid_result" };
    }
    if (result.status === "completed") {
      return this.persist(row, {
        type: "EffectCompleted",
        effectId: row.effectId,
        receipt: result.receipt,
      }, "completed");
    }
    if (result.status === "failed") {
      return this.persist(row, {
        type: "EffectFailed",
        effectId: row.effectId,
        code: result.code,
        message: result.message,
      }, "failed");
    }
    return this.persist(row, {
      type: "EffectUncertain",
      effectId: row.effectId,
      message: result.message,
    }, "uncertain");
  }

  private async runWithTimeout(
    operation: "dispatch" | "reconciliation",
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<CapabilityResult>,
  ): Promise<CapabilityResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new EffectTimeoutError(operation, timeoutMs));
        controller.abort();
      }, timeoutMs);
    });
    const extensionResult = Promise.resolve().then(() => run(controller.signal));
    try {
      return await Promise.race([extensionResult, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private persist(
    row: ClaimedEffect,
    payload: TerminalEffectEvent,
    status: CapabilityResult["status"],
  ): EffectDispatchResult {
    try {
      this.repository.finishEffect(
        row.effectId,
        row.orenId,
        row.effect.correlationId,
        payload,
      );
      return { effectId: row.effectId, status };
    } catch {
      return { effectId: row.effectId, status: "persistence_failed" };
    }
  }
}
