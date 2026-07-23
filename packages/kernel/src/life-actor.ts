import type { Effect, EventEnvelope, Proposal } from "./protocol.js";
import type { CognitionJob, LifeRepositoryPort } from "./ports.js";

export class LifeActor {
  public constructor(
    private readonly repository: LifeRepositoryPort,
    private readonly nextId: () => string,
    private readonly now: () => string,
  ) {}

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
        case "NoAction":
        case "ExpressToUser":
          return [];
      }
    });

    this.repository.commit(job.orenId, [completed, ...accepted]);
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
      | { readonly kind: "aborted"; readonly reason: "foreground_user" | "shutdown" },
  ): void {
    const payload: EventEnvelope["payload"] = exit.kind === "failed"
      ? { type: "CognitionFailed", episodeId: job.episodeId, message: exit.message }
      : { type: "EpisodeInterrupted", episodeId: job.episodeId, reason: exit.reason };
    this.repository.commit(job.orenId, [
      this.envelope(job.orenId, job.correlationId, payload),
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
