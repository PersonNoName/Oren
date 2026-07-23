import type { OrenId, PersonId } from "./ids.js";

export interface LifeState {
  readonly orenId: OrenId;
  readonly version: number;
  readonly identity: {
    readonly ethosVersion: number;
    readonly currentDisposition: string;
  };
  readonly attention: {
    readonly activeThreadIds: readonly string[];
    readonly currentFocus: string | null;
    readonly unresolvedQuestions: readonly string[];
  };
  readonly relationship: {
    readonly primaryPersonId: PersonId;
    readonly currentContextRef: string | null;
  };
  readonly grantIds: readonly string[];
  readonly pendingEffectIds: readonly string[];
  readonly schedules: readonly string[];
  readonly budgets: {
    readonly autonomyRemaining: number;
    readonly interactionMaxSteps: number;
    readonly commitmentRemaining: Readonly<Record<string, number>>;
  };
  readonly chronicleCursor: number;
}

export function createInitialLifeState(orenId: OrenId, personId: PersonId): LifeState {
  return {
    orenId,
    version: 0,
    identity: { ethosVersion: 1, currentDisposition: "attentive" },
    attention: { activeThreadIds: [], currentFocus: null, unresolvedQuestions: [] },
    relationship: { primaryPersonId: personId, currentContextRef: null },
    grantIds: [],
    pendingEffectIds: [],
    schedules: [],
    budgets: { autonomyRemaining: 0, interactionMaxSteps: 8, commitmentRemaining: {} },
    chronicleCursor: 0,
  };
}
