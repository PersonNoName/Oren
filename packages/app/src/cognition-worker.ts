import { types as utilTypes } from "node:util";
import type {
  CognitionCapabilityPort,
  CognitionPort,
  Conductor,
  CreateFrameInput,
} from "@oren/cognition";
import {
  canonicalizeJson,
  canonicalizeProposal,
  type CognitionJob,
  type EpisodeInterruptionReason,
  type Guard,
  type JsonObject,
  type LifeActor,
  type Proposal,
} from "@oren/kernel";
import type { CognitionOutcome } from "@oren/cognition";

const INTERRUPTION_REASONS = new Set<unknown>([
  "foreground_user",
  "shutdown",
  "trigger_priority",
  "cognition_abort",
]);

function interruptionReason(signal: AbortSignal): EpisodeInterruptionReason {
  return INTERRUPTION_REASONS.has(signal.reason)
    ? signal.reason as EpisodeInterruptionReason
    : "cognition_abort";
}

function errorMessage(error: unknown): string {
  return utilTypes.isNativeError(error) ? error.message : "Unknown cognition error";
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasValidUsage(value: unknown): value is { readonly totalTokens: number } {
  return isRecord(value)
    && exactKeys(value, ["totalTokens"])
    && typeof value.totalTokens === "number"
    && Number.isSafeInteger(value.totalTokens)
    && value.totalTokens >= 0;
}

function canonicalizeCognitionOutcome(value: unknown): CognitionOutcome | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const outcome = canonical.value;
  if (!hasValidUsage(outcome.usage)) return undefined;
  switch (outcome.kind) {
    case "completed": {
      if (!exactKeys(outcome, ["kind", "proposals", "usage"]) || !Array.isArray(outcome.proposals)) {
        return undefined;
      }
      const proposals = outcome.proposals.map(canonicalizeProposal);
      return proposals.every((proposal) => proposal !== undefined)
        ? {
            kind: "completed",
            proposals: proposals as NonNullable<typeof proposals[number]>[],
            usage: outcome.usage,
          }
        : undefined;
    }
    case "waiting_for_effect":
      return exactKeys(outcome, ["kind", "effectId", "usage"])
        && typeof outcome.effectId === "string"
        ? { kind: "waiting_for_effect", effectId: outcome.effectId, usage: outcome.usage }
        : undefined;
    case "failed":
      return exactKeys(outcome, ["kind", "message", "usage"])
        && typeof outcome.message === "string"
        ? { kind: "failed", message: outcome.message, usage: outcome.usage }
        : undefined;
    case "aborted":
      return exactKeys(outcome, ["kind", "usage"])
        ? { kind: "aborted", usage: outcome.usage }
        : undefined;
    default:
      return undefined;
  }
}

function canonicalizeGuardDecision(value: unknown):
  | { readonly allowed: true; readonly autonomyCost: number }
  | { readonly allowed: false; readonly reason: string }
  | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok || !isRecord(canonical.value)) return undefined;
  const decision = canonical.value;
  if (
    decision.allowed === true
    && exactKeys(decision, ["allowed", "autonomyCost"])
    && typeof decision.autonomyCost === "number"
    && Number.isSafeInteger(decision.autonomyCost)
    && decision.autonomyCost >= 0
  ) {
    return { allowed: true, autonomyCost: decision.autonomyCost };
  }
  return decision.allowed === false
    && exactKeys(decision, ["allowed", "reason"])
    && typeof decision.reason === "string"
    ? { allowed: false, reason: decision.reason }
    : undefined;
}

export class CognitionWorker {
  public constructor(
    private readonly cognition: CognitionPort,
    private readonly conductor: Conductor,
    private readonly actor: LifeActor,
    private readonly guard: Guard,
    private readonly loadFrameInput: (
      job: CognitionJob,
    ) => CreateFrameInput | Promise<CreateFrameInput>,
    private readonly capabilityPort: CognitionCapabilityPort,
    private readonly onCognitionAccepted?: (
      job: CognitionJob,
      proposals: readonly Proposal[],
    ) => Promise<void>,
  ) {}

  public async run(job: CognitionJob, signal: AbortSignal): Promise<void> {
    let activeJob = job;
    const attempt = (write: () => void): void => {
      try {
        write();
      } catch {
        // The workflow remains total even when durable storage is unavailable.
        // The attempted write is the strongest guarantee possible at this boundary.
      }
    };
    const abort = (): void => attempt(() => this.actor.recordCognitionExit(activeJob, {
      kind: "aborted",
      reason: interruptionReason(signal),
    }));
    const fail = (message: string): void => attempt(() => this.actor.recordCognitionExit(
      activeJob,
      { kind: "failed", message },
    ));
    const deny = (reason: string): void => attempt(() =>
      this.actor.recordCognitionDenied(activeJob, reason));
    try {
      if (signal.aborted) {
        abort();
        return;
      }
      const initialInput = await this.loadFrameInput(activeJob);
      if (signal.aborted) {
        abort();
        return;
      }
      const existingReservation = initialInput.state.autonomyReservations?.[activeJob.episodeId];
      const autonomyAlreadyReserved = existingReservation !== undefined
        && initialInput.state.orenId === activeJob.orenId
        && existingReservation.correlationId === activeJob.correlationId
        && existingReservation.amount === initialInput.maxSteps
        && initialInput.state.version === existingReservation.baseStateVersion + 1
        && (
          activeJob.baseStateVersion === existingReservation.baseStateVersion
          || activeJob.baseStateVersion === initialInput.state.version
        );
      if (
        initialInput.state.orenId !== activeJob.orenId
        || (
          initialInput.state.version !== activeJob.baseStateVersion
          && !autonomyAlreadyReserved
        )
      ) {
        deny("stale_state_version");
        return;
      }
      if (existingReservation !== undefined && !autonomyAlreadyReserved) {
        deny("autonomy_already_reserved");
        return;
      }
      if (autonomyAlreadyReserved) {
        activeJob = { ...activeJob, baseStateVersion: initialInput.state.version };
      }
      const rawDecision = this.guard.evaluateCognition(
        initialInput.state,
        activeJob.triggerKind,
        initialInput.maxSteps,
        autonomyAlreadyReserved,
      );
      const decision = canonicalizeGuardDecision(rawDecision);
      if (!decision) {
        fail("Malformed guard decision");
        return;
      }
      if (signal.aborted) {
        abort();
        return;
      }
      if (!decision.allowed) {
        deny(decision.reason);
        return;
      }

      let frameInput = initialInput;
      if (decision.autonomyCost > 0) {
        if (signal.aborted) {
          abort();
          return;
        }
        const consumed = this.actor.consumeAutonomy(activeJob, decision.autonomyCost);
        if (!consumed.accepted) {
          deny(consumed.reason);
          return;
        }
        activeJob = consumed.job;
        if (signal.aborted) {
          abort();
          return;
        }
        frameInput = await this.loadFrameInput(activeJob);
        if (signal.aborted) {
          abort();
          return;
        }
        if (
          frameInput.state.orenId !== activeJob.orenId
          || frameInput.state.version !== activeJob.baseStateVersion
        ) {
          deny("stale_state_version");
          return;
        }
      }

      if (signal.aborted) {
        abort();
        return;
      }
      const frame = this.conductor.createFrame(frameInput);
      if (signal.aborted) {
        abort();
        return;
      }
      const rawOutcome = await this.cognition.run(frame, this.capabilityPort, signal);
      if (signal.aborted) {
        abort();
        return;
      }
      const outcome = canonicalizeCognitionOutcome(rawOutcome);
      if (!outcome) {
        fail("Malformed cognition outcome");
        return;
      }
      switch (outcome.kind) {
        case "completed": {
          const accepted = this.actor.acceptCognition(activeJob, outcome.proposals);
          if (!accepted.accepted) {
            fail(`Cognition result rejected: ${accepted.reason ?? "unknown_reason"}`);
            return;
          }
          if (this.onCognitionAccepted) {
            try {
              // Delivery is best-effort after accept; proposals stay committed.
              await this.onCognitionAccepted(activeJob, outcome.proposals);
            } catch (error) {
              fail(`Delivery orchestration failed: ${errorMessage(error)}`);
            }
          }
          return;
        }
        case "waiting_for_effect":
          attempt(() => this.actor.recordCognitionWaiting(activeJob, outcome.effectId));
          return;
        case "failed":
          fail(outcome.message);
          return;
        case "aborted":
          abort();
          return;
      }
    } catch (error) {
      if (signal.aborted) {
        abort();
        return;
      }
      fail(errorMessage(error));
    }
  }
}
