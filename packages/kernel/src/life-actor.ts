import type {
  CommitmentStatus,
  Effect,
  EpisodeInterruptionReason,
  EventEnvelope,
  ObservationKind,
  Proposal,
} from "./protocol.js";
import type {
  DeliveryCause,
  ReachabilityPolicyInput,
} from "./reachability.js";
import type {
  ClaimedInboxItem,
  CognitionJob,
  DeliverWakeOutcome,
  LifeRepositoryPort,
} from "./ports.js";
import { reachabilityOf } from "./reachability.js";
import { hasValidLifeStateBudgets } from "./runtime-validation.js";

export class LifeActor {
  public constructor(
    private readonly repository: LifeRepositoryPort,
    private readonly nextId: () => string,
    private readonly now: () => string,
  ) {}

  public handleInbox(input: ClaimedInboxItem): CognitionJob | undefined {
    const before = this.repository.loadState(input.orenId);
    const episodeId = this.nextId();
    let triggerKind: CognitionJob["triggerKind"];
    switch (input.event.type) {
      case "WakeDue":
        triggerKind = "scheduled_wake";
        break;
      case "EffectCompleted":
      case "EffectFailed":
      case "EffectUncertain":
        triggerKind = "effect_result";
        break;
      default:
        throw new Error("Unsupported inbox event");
    }
    const baseStateVersion = before.version + 2;
    const accepted = this.envelope(input.orenId, input.correlationId, input.event);
    const requested = this.envelope(input.orenId, input.correlationId, {
      type: "CognitionRequested",
      episodeId,
      baseStateVersion,
      triggerKind,
    });
    const committed = this.repository.commitInbox(
      input.inboxId,
      input.orenId,
      input.leaseOwner,
      input.leaseToken,
      [accepted, requested],
    );
    if (!committed) return undefined;
    return {
      orenId: input.orenId,
      episodeId,
      baseStateVersion,
      triggerKind,
      correlationId: input.correlationId,
    };
  }

  public handleUserMessage(orenId: string, personId: string, text: string): CognitionJob {
    const before = this.repository.loadState(orenId);
    const episodeId = this.nextId();
    const correlationId = this.nextId();
    const baseStateVersion = before.version + 2;
    const received = this.envelope(orenId, correlationId, {
      type: "UserMessageReceived",
      personId,
      text,
    });
    const requested = this.envelope(orenId, correlationId, {
      type: "CognitionRequested",
      episodeId,
      baseStateVersion,
      triggerKind: "foreground_user",
    });

    this.repository.commit(orenId, [received, requested]);

    return {
      orenId,
      episodeId,
      baseStateVersion,
      triggerKind: "foreground_user",
      correlationId,
    };
  }

  public acceptCognition(
    job: CognitionJob,
    proposals: readonly Proposal[],
  ): { readonly accepted: boolean; readonly reason?: string } {
    const current = this.repository.loadState(job.orenId);
    if (
      !Number.isSafeInteger(job.baseStateVersion)
      || job.baseStateVersion < 0
      || !hasValidLifeStateBudgets(current)
    ) {
      return { accepted: false, reason: "invalid_state_or_job" };
    }
    if (current.version !== job.baseStateVersion) {
      return { accepted: false, reason: "stale_state_version" };
    }

    const completed = this.envelope(job.orenId, job.correlationId, {
      type: "CognitionCompleted",
      episodeId: job.episodeId,
      baseStateVersion: job.baseStateVersion,
      proposals,
    });
    const accepted = proposals.flatMap((proposal): EventEnvelope[] => {
      switch (proposal.type) {
        case "AdvanceThread":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "ThreadAdvanced",
            threadId: proposal.threadId,
            summary: proposal.summary,
          })];
        case "UpdateDisposition":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "DispositionUpdated",
            disposition: proposal.disposition,
            reason: proposal.reason,
          })];
        case "ScheduleWake":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "WakeScheduled",
            scheduleId: proposal.scheduleId,
            at: proposal.at,
            purpose: proposal.purpose,
          })];
        case "Remember":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "MemoryRemembered",
            memoryId: this.nextId(),
            kind: proposal.kind,
            text: proposal.text,
            ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
            ...(proposal.reviewCondition !== undefined
              ? { reviewCondition: proposal.reviewCondition }
              : {}),
            ...(proposal.threadId !== undefined ? { threadId: proposal.threadId } : {}),
          })];
        case "ReviseBelief":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "BeliefRevised",
            memoryId: proposal.memoryId,
            confidence: proposal.confidence,
            reason: proposal.reason,
            ...(proposal.revisedText !== undefined
              ? { revisedText: proposal.revisedText }
              : {}),
          })];
        case "Forget":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "MemoryForgotten",
            memoryId: proposal.memoryId,
            reason: proposal.reason,
          })];
        case "UpsertCommitment":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "CommitmentUpserted",
            commitmentId: proposal.commitmentId ?? this.nextId(),
            goal: proposal.goal,
            status: proposal.status,
            nextStep: proposal.nextStep,
            mayAdvanceAutonomously: proposal.mayAdvanceAutonomously,
          })];
        case "UpdateCommitmentStatus":
          return [this.envelope(job.orenId, job.correlationId, {
            type: "CommitmentStatusChanged",
            commitmentId: proposal.commitmentId,
            status: proposal.status,
            reason: proposal.reason,
            ...(proposal.nextStep !== undefined ? { nextStep: proposal.nextStep } : {}),
          })];
        case "NoAction":
        case "ExpressToUser":
          return [];
      }
    });

    this.repository.commit(job.orenId, [completed, ...accepted]);
    return { accepted: true };
  }

  public consumeAutonomy(
    job: CognitionJob,
    amount: number,
  ):
    | { readonly accepted: true; readonly job: CognitionJob }
    | { readonly accepted: false; readonly reason: string } {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { accepted: false, reason: "invalid_autonomy_cost" };
    }
    if (job.triggerKind === "foreground_user" || job.triggerKind === "effect_result") {
      return { accepted: false, reason: "non_autonomous_trigger" };
    }
    const current = this.repository.loadState(job.orenId);
    if (
      !Number.isSafeInteger(job.baseStateVersion)
      || job.baseStateVersion < 0
      || !hasValidLifeStateBudgets(current)
    ) {
      return { accepted: false, reason: "invalid_state_or_job" };
    }
    const reservation = current.autonomyReservations?.[job.episodeId];
    if (reservation !== undefined) {
      if (
        reservation.amount === amount
        && reservation.correlationId === job.correlationId
        && current.version === reservation.baseStateVersion + 1
        && (
          job.baseStateVersion === reservation.baseStateVersion
          || job.baseStateVersion === current.version
        )
      ) {
        return {
          accepted: true,
          job: { ...job, baseStateVersion: current.version },
        };
      }
      return { accepted: false, reason: "autonomy_already_reserved" };
    }
    if (current.version !== job.baseStateVersion) {
      return { accepted: false, reason: "stale_state_version" };
    }
    if (current.budgets.autonomyRemaining < amount) {
      return { accepted: false, reason: "autonomy_budget_exhausted" };
    }
    const consumed = this.envelope(job.orenId, job.correlationId, {
      type: "AutonomyConsumed",
      episodeId: job.episodeId,
      baseStateVersion: job.baseStateVersion,
      amount,
    });
    if (!this.repository.commitIfVersion(job.orenId, job.baseStateVersion, [consumed])) {
      return { accepted: false, reason: "stale_state_version" };
    }
    return {
      accepted: true,
      job: { ...job, baseStateVersion: job.baseStateVersion + 1 },
    };
  }

  public recordCognitionDenied(job: CognitionJob, reason: string): void {
    this.repository.commit(job.orenId, [
      this.envelope(job.orenId, job.correlationId, {
        type: "CognitionDenied",
        episodeId: job.episodeId,
        reason,
      }),
    ]);
  }

  public recordCognitionWaiting(job: CognitionJob, effectId: string): void {
    this.repository.commit(job.orenId, [
      this.envelope(job.orenId, job.correlationId, {
        type: "CognitionWaitingForEffect",
        episodeId: job.episodeId,
        effectId,
      }),
    ]);
  }

  public recordObservation(
    orenId: string,
    correlationId: string,
    input: {
      readonly kind: ObservationKind;
      readonly sourceUrl: string;
      readonly title?: string;
      readonly excerpt: string;
      readonly retrievedAt: string;
      readonly query?: string;
      readonly confidence: number;
    },
  ): { readonly accepted: true } | { readonly accepted: false; readonly reason: string } {
    const current = this.repository.loadState(orenId);
    if ((current.budgets.webQuotaRemaining ?? 0) < 1) {
      return { accepted: false, reason: "web_quota_exhausted" };
    }
    const payload = {
      type: "ObservationRecorded" as const,
      observationId: this.nextId(),
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      excerpt: input.excerpt,
      retrievedAt: input.retrievedAt,
      confidence: input.confidence,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
    };
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, payload),
    ]);
    return { accepted: true };
  }

  public requestEffect(
    orenId: string,
    correlationId: string,
    effect: Effect,
  ): { readonly accepted: boolean; readonly reason?: string } {
    const current = this.repository.loadState(orenId);
    if (current.version !== effect.stateVersion) {
      return { accepted: false, reason: "stale_state_version" };
    }

    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, { type: "EffectRequested", effect }),
    ]);
    return { accepted: true };
  }

  public recordCognitionExit(
    job: CognitionJob,
    exit:
      | { readonly kind: "failed"; readonly message: string }
      | { readonly kind: "aborted"; readonly reason: EpisodeInterruptionReason },
  ): void {
    const payload: EventEnvelope["payload"] = exit.kind === "failed"
      ? { type: "CognitionFailed", episodeId: job.episodeId, message: exit.message }
      : { type: "EpisodeInterrupted", episodeId: job.episodeId, reason: exit.reason };
    this.repository.commit(job.orenId, [
      this.envelope(job.orenId, job.correlationId, payload),
    ]);
  }

  public updateCommitmentStatus(
    orenId: string,
    correlationId: string,
    input: {
      readonly commitmentId: string;
      readonly status: CommitmentStatus;
      readonly nextStep?: string;
      readonly reason: string;
    },
  ): void {
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "CommitmentStatusChanged",
        commitmentId: input.commitmentId,
        status: input.status,
        reason: input.reason,
        ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
      }),
    ]);
  }

  public updateReachabilityPolicy(
    orenId: string,
    correlationId: string,
    policyInput: ReachabilityPolicyInput,
    reason: string,
  ): void {
    const current = this.repository.loadState(orenId);
    const existing = reachabilityOf(current);
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "ReachabilityPolicyUpdated",
        policy: {
          ...policyInput,
          proactiveDayKey: existing.proactiveDayKey,
          proactiveCountToday: existing.proactiveCountToday,
        },
        reason,
      }),
    ]);
  }

  public recordMessageDelivered(
    orenId: string,
    correlationId: string,
    input: {
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly channel: "panel";
      readonly proactive: boolean;
    },
  ): void {
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "MessageDelivered",
        ...input,
      }),
    ]);
  }

  public recordMessageDeferred(
    orenId: string,
    correlationId: string,
    input: {
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly deferUntil: string;
      readonly cause: DeliveryCause;
    },
  ): void {
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "MessageDeferred",
        ...input,
      }),
      this.envelope(orenId, correlationId, {
        type: "WakeScheduled",
        scheduleId: input.deliveryId,
        at: input.deferUntil,
        purpose: `deliver:${input.deliveryId}`,
      }),
    ]);
  }

  public recordMessageDeliveryFailed(
    orenId: string,
    correlationId: string,
    input: {
      readonly deliveryId: string;
      readonly text: string;
      readonly reason: string;
      readonly code: string;
    },
  ): void {
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "MessageDeliveryFailed",
        ...input,
      }),
    ]);
  }

  public handleDeliverWake(
    input: ClaimedInboxItem,
    outcome: DeliverWakeOutcome,
  ): boolean {
    if (input.event.type !== "WakeDue") {
      throw new Error("handleDeliverWake requires a WakeDue inbox event");
    }
    const match = /^deliver:(.+)$/.exec(input.event.purpose);
    if (!match) {
      throw new Error("handleDeliverWake requires a deliver: purpose");
    }
    const accepted = this.envelope(input.orenId, input.correlationId, input.event);
    const resultEvents: EventEnvelope[] = [accepted];
    if (outcome.kind === "delivered") {
      resultEvents.push(this.envelope(input.orenId, input.correlationId, {
        type: "MessageDelivered",
        deliveryId: outcome.deliveryId,
        text: outcome.text,
        reason: outcome.reason,
        channel: "panel",
        proactive: true,
      }));
    } else if (outcome.kind === "failed") {
      resultEvents.push(this.envelope(input.orenId, input.correlationId, {
        type: "MessageDeliveryFailed",
        deliveryId: outcome.deliveryId,
        text: outcome.text,
        reason: outcome.reason,
        code: outcome.code,
      }));
    }
    return this.repository.commitDeliverInbox(
      input.inboxId,
      input.orenId,
      input.leaseOwner,
      input.leaseToken,
      resultEvents,
    );
  }

  public revokeGrant(
    orenId: string,
    correlationId: string,
    grantId: string,
    reason: string,
  ): void {
    this.repository.commit(orenId, [
      this.envelope(orenId, correlationId, {
        type: "GrantRevoked",
        grantId,
        reason,
      }),
    ]);
  }

  private envelope(
    orenId: string,
    correlationId: string,
    payload: EventEnvelope["payload"],
  ): EventEnvelope {
    const timestamp = this.now();
    return {
      eventId: this.nextId(),
      orenId,
      schemaVersion: 1,
      occurredAt: timestamp,
      recordedAt: timestamp,
      source: "life-actor",
      causationId: null,
      correlationId,
      payload,
    };
  }
}
