export type CommitmentStatus = "active" | "paused" | "done";

export type Commitment = {
  readonly commitmentId: string;
  readonly goal: string;
  readonly status: CommitmentStatus;
  readonly nextStep: string;
  readonly mayAdvanceAutonomously: boolean;
};

export type QuietHours = {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
};

export type ReachabilityPolicy = {
  readonly quietHours: QuietHours | null;
  readonly maxProactivePerDay: number;
  readonly deferWhenQuiet: true;
  readonly proactiveDayKey: string | null;
  readonly proactiveCountToday: number;
};

export type PanelSnapshot = {
  readonly inbox: ReadonlyArray<{
    deliveryId: string;
    text: string;
    reason: string;
    status: "delivered" | "deferred" | "failed";
    proactive?: boolean;
    deferUntil?: string;
    at: string;
  }>;
  readonly attention: {
    readonly activeThreadIds: readonly string[];
    readonly currentFocus: string | null;
    readonly unresolvedQuestions: readonly string[];
  };
  readonly commitments: readonly Commitment[];
  readonly budgets: {
    readonly autonomyRemaining: number;
    readonly interactionMaxSteps: number;
    readonly commitmentRemaining: Readonly<Record<string, number>>;
    readonly webQuotaRemaining?: number;
  };
  readonly grants: ReadonlyArray<{
    grantId: string;
    capabilityPattern: string;
    revoked: boolean;
  }>;
  readonly schedules: ReadonlyArray<{
    scheduleId: string;
    dueAt: string;
    purpose: string;
  }>;
  readonly actionLedger: ReadonlyArray<{ at: string; summary: string }>;
  readonly publicDiary: ReadonlyArray<{ at: string; text: string }>;
  readonly reachability: ReachabilityPolicy;
};
