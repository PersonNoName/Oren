import { types as utilTypes } from "node:util";
import type {
  CognitionCapabilityPort,
  CognitionPort,
  Conductor,
  CreateFrameInput,
} from "@oren/cognition";
import type {
  CognitionJob,
  EpisodeInterruptionReason,
  Guard,
  LifeActor,
} from "@oren/kernel";

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

export class CognitionWorker {
  public constructor(
    private readonly cognition: CognitionPort,
    private readonly conductor: Conductor,
    private readonly actor: LifeActor,
    private readonly guard: Guard,
    private readonly loadFrameInput: (job: CognitionJob) => CreateFrameInput,
    private readonly capabilityPort: CognitionCapabilityPort,
  ) {}

  public async run(job: CognitionJob, signal: AbortSignal): Promise<void> {
    let activeJob = job;
    if (signal.aborted) {
      this.actor.recordCognitionExit(activeJob, {
        kind: "aborted",
        reason: interruptionReason(signal),
      });
      return;
    }
    const initialInput = this.loadFrameInput(activeJob);
    if (
      initialInput.state.orenId !== activeJob.orenId
      || initialInput.state.version !== activeJob.baseStateVersion
    ) {
      this.actor.recordCognitionDenied(activeJob, "stale_state_version");
      return;
    }
    const decision = this.guard.evaluateCognition(
      initialInput.state,
      activeJob.triggerKind,
      initialInput.maxSteps,
    );
    if (!decision.allowed) {
      this.actor.recordCognitionDenied(activeJob, decision.reason);
      return;
    }

    let frameInput = initialInput;
    if (decision.autonomyCost > 0) {
      const consumed = this.actor.consumeAutonomy(activeJob, decision.autonomyCost);
      if (!consumed.accepted) {
        this.actor.recordCognitionDenied(activeJob, consumed.reason);
        return;
      }
      activeJob = consumed.job;
      frameInput = this.loadFrameInput(activeJob);
      if (
        frameInput.state.orenId !== activeJob.orenId
        || frameInput.state.version !== activeJob.baseStateVersion
      ) {
        this.actor.recordCognitionDenied(activeJob, "stale_state_version");
        return;
      }
    }

    try {
      const frame = this.conductor.createFrame(frameInput);
      const outcome = await this.cognition.run(frame, this.capabilityPort, signal);
      if (signal.aborted) {
        this.actor.recordCognitionExit(activeJob, {
          kind: "aborted",
          reason: interruptionReason(signal),
        });
        return;
      }
      switch (outcome.kind) {
        case "completed": {
          const accepted = this.actor.acceptCognition(activeJob, outcome.proposals);
          if (!accepted.accepted) {
            this.actor.recordCognitionExit(activeJob, {
              kind: "failed",
              message: `Cognition result rejected: ${accepted.reason ?? "unknown_reason"}`,
            });
          }
          return;
        }
        case "waiting_for_effect":
          this.actor.recordCognitionWaiting(activeJob, outcome.effectId);
          return;
        case "failed":
          this.actor.recordCognitionExit(activeJob, {
            kind: "failed",
            message: outcome.message,
          });
          return;
        case "aborted":
          this.actor.recordCognitionExit(activeJob, {
            kind: "aborted",
            reason: interruptionReason(signal),
          });
          return;
      }
    } catch (error) {
      if (signal.aborted) {
        this.actor.recordCognitionExit(activeJob, {
          kind: "aborted",
          reason: interruptionReason(signal),
        });
        return;
      }
      this.actor.recordCognitionExit(activeJob, {
        kind: "failed",
        message: errorMessage(error),
      });
    }
  }
}
