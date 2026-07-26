import { DEFAULT_REACHABILITY } from "@oren/kernel";
import type { PanelSnapshot } from "./types.js";

export function minimalSnapshot(): PanelSnapshot {
  return {
    inbox: [],
    attention: {
      activeThreadIds: [],
      currentFocus: null,
      unresolvedQuestions: [],
    },
    commitments: [],
    budgets: {
      autonomyRemaining: 0,
      interactionMaxSteps: 8,
      commitmentRemaining: {},
      webQuotaRemaining: 8,
    },
    grants: [],
    schedules: [],
    actionLedger: [],
    publicDiary: [],
    reachability: { ...DEFAULT_REACHABILITY },
  };
}
