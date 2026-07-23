import { describe, expect, it } from "vitest";
import { createInitialLifeState, Guard, type Grant } from "../src/index.js";

const grant: Grant = {
  grantId: "grant-1",
  capabilityPattern: "test.*",
  expiresAt: "2026-08-01T00:00:00.000Z",
  revoked: false,
};

describe("Guard", () => {
  it("does not charge the autonomy budget for foreground cognition", () => {
    const state = createInitialLifeState("oren-1", "person-1");

    const decision = new Guard().evaluateCognition(state, "foreground_user", 3);

    expect(decision).toEqual({ allowed: true, autonomyCost: 0 });
  });

  it("does not charge the autonomy budget for effect-result cognition", () => {
    const state = createInitialLifeState("oren-1", "person-1");

    const decision = new Guard().evaluateCognition(state, "effect_result", 3);

    expect(decision).toEqual({ allowed: true, autonomyCost: 0 });
  });

  it("rejects background cognition when the remaining autonomy budget is insufficient", () => {
    const state = {
      ...createInitialLifeState("oren-1", "person-1"),
      budgets: {
        autonomyRemaining: 2,
        interactionMaxSteps: 8,
        commitmentRemaining: {},
      },
    };

    const decision = new Guard().evaluateCognition(state, "scheduled_wake", 3);

    expect(decision).toEqual({ allowed: false, reason: "autonomy_budget_exhausted" });
  });

  it("rejects cognition that exceeds the interaction step cap", () => {
    const state = createInitialLifeState("oren-1", "person-1");

    const decision = new Guard().evaluateCognition(state, "foreground_user", 9);

    expect(decision).toEqual({ allowed: false, reason: "episode_step_limit" });
  });

  it("requires a live grant for a persistent capability", () => {
    const decision = new Guard().evaluateCapability({
      capability: "test.increment",
      grants: [grant],
      now: "2026-07-23T00:00:00.000Z",
    });

    expect(decision).toEqual({ allowed: true, autonomyCost: 0 });
  });

  it("matches an exact capability pattern without matching other capabilities", () => {
    const decision = new Guard().evaluateCapability({
      capability: "test.decrement",
      grants: [{ ...grant, capabilityPattern: "test.increment" }],
      now: "2026-07-23T00:00:00.000Z",
    });

    expect(decision).toEqual({ allowed: false, reason: "missing_or_expired_grant" });
  });

  it.each([
    { name: "expired", value: { expiresAt: "2026-07-23T00:00:00.000Z" } },
    { name: "revoked", value: { revoked: true } },
  ])("rejects a $name grant", ({ value }) => {
    const decision = new Guard().evaluateCapability({
      capability: "test.increment",
      grants: [{ ...grant, ...value }],
      now: "2026-07-23T00:00:00.000Z",
    });

    expect(decision).toEqual({ allowed: false, reason: "missing_or_expired_grant" });
  });
});
