import type { Commitment, CommitmentStatus } from "@oren/kernel";
import type { LifeState } from "@oren/kernel";
import type { ReachabilityPolicy } from "@oren/kernel";

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
  readonly attention: LifeState["attention"];
  readonly commitments: readonly Commitment[];
  readonly budgets: LifeState["budgets"];
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

export type PanelHandlers = {
  getSnapshot: () => PanelSnapshot | Promise<PanelSnapshot>;
  postMessage: (text: string) => Promise<void>;
  updateReachability: (policy: ReachabilityPolicy, reason: string) => Promise<void>;
  revokeGrant: (grantId: string, reason: string) => Promise<void>;
  updateCommitment: (
    commitmentId: string,
    body: {
      status: CommitmentStatus;
      nextStep?: string;
      reason: string;
    },
  ) => Promise<void>;
};

export type PanelServer = {
  readonly url: string;
  close(): Promise<void>;
};

export type PanelServerOptions = {
  readonly port?: number;
  readonly host?: string;
};
