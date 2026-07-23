import type { TriggerKind } from "./protocol.js";
import type { LifeState } from "./state.js";

export interface Grant {
  readonly grantId: string;
  readonly capabilityPattern: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export type GuardDecision =
  | { readonly allowed: true; readonly autonomyCost: number }
  | { readonly allowed: false; readonly reason: string };

function matches(pattern: string, capability: string): boolean {
  return pattern.endsWith("*")
    ? capability.startsWith(pattern.slice(0, -1))
    : pattern === capability;
}

export class Guard {
  public evaluateCognition(
    state: LifeState,
    trigger: TriggerKind,
    requestedSteps: number,
  ): GuardDecision {
    if (requestedSteps > state.budgets.interactionMaxSteps) {
      return { allowed: false, reason: "episode_step_limit" };
    }
    if (trigger === "foreground_user" || trigger === "effect_result") {
      return { allowed: true, autonomyCost: 0 };
    }
    if (state.budgets.autonomyRemaining < requestedSteps) {
      return { allowed: false, reason: "autonomy_budget_exhausted" };
    }
    return { allowed: true, autonomyCost: requestedSteps };
  }

  public evaluateCapability(input: {
    readonly capability: string;
    readonly grants: readonly Grant[];
    readonly now: string;
  }): GuardDecision {
    const grant = input.grants.find((candidate) =>
      !candidate.revoked
      && candidate.expiresAt > input.now
      && matches(candidate.capabilityPattern, input.capability));
    return grant
      ? { allowed: true, autonomyCost: 0 }
      : { allowed: false, reason: "missing_or_expired_grant" };
  }
}
