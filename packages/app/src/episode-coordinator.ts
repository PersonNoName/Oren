import type {
  CognitionCapabilityPort,
  CognitionEvent,
  CognitionHandlers,
  Conductor,
  CreateFrameInput,
  StreamingCognitionPort,
} from "@oren/cognition";
import type { ForegroundSpeechPort } from "@oren/channel";
import type {
  CognitionJob,
  EpisodeInterruptionReason,
  Guard,
  LifeActor,
  Proposal,
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
  return error instanceof Error ? error.message : String(error);
}

export class EpisodeCoordinator {
  public constructor(
    private readonly cognition: StreamingCognitionPort,
    private readonly conductor: Conductor,
    private readonly actor: LifeActor,
    private readonly guard: Guard,
    private readonly loadFrameInput: (
      job: CognitionJob,
    ) => CreateFrameInput | Promise<CreateFrameInput>,
    private readonly capabilityPort: CognitionCapabilityPort,
    private readonly speech: ForegroundSpeechPort,
    private readonly onCommitAccepted?: (
      job: CognitionJob,
      proposals: readonly Proposal[],
    ) => Promise<void>,
  ) {}

  public async run(job: CognitionJob, signal: AbortSignal): Promise<void> {
    let activeJob = job;
    let activeUtterance:
      | { readonly id: string; text: string }
      | undefined;
    let producedForegroundOutput = false;
    let acceptedCommit = false;
    let terminalSeen = false;

    const writeExit = (exit:
      | { readonly kind: "failed"; readonly message: string }
      | { readonly kind: "aborted"; readonly reason: EpisodeInterruptionReason }) => {
      try {
        this.actor.recordCognitionExit(activeJob, exit);
      } catch {
        // A failed durable store is already the terminal boundary for this run.
      }
    };

    const updateVersion = (stateVersion: number | undefined): boolean => {
      if (stateVersion === undefined) return false;
      activeJob = { ...activeJob, baseStateVersion: stateVersion };
      return true;
    };

    const closeInterruptedSpeech = async (): Promise<void> => {
      if (!activeUtterance || activeJob.triggerKind !== "foreground_user") return;
      const utterance = activeUtterance;
      activeUtterance = undefined;
      if (utterance.text.length === 0) return;
      await this.speech.completeSpeech({
        messageId: utterance.id,
        status: "interrupted",
      });
      const result = this.actor.recordAssistantMessage(activeJob, {
        messageId: utterance.id,
        text: utterance.text,
        status: "interrupted",
      });
      updateVersion(result.stateVersion);
      producedForegroundOutput = true;
    };

    try {
      if (signal.aborted) {
        writeExit({ kind: "aborted", reason: interruptionReason(signal) });
        return;
      }
      let frameInput = await this.loadFrameInput(activeJob);
      const existingReservation =
        frameInput.state.autonomyReservations?.[activeJob.episodeId];
      const autonomyAlreadyReserved = existingReservation !== undefined
        && frameInput.state.orenId === activeJob.orenId
        && existingReservation.correlationId === activeJob.correlationId
        && existingReservation.amount === frameInput.maxSteps
        && frameInput.state.version === existingReservation.baseStateVersion + 1
        && (
          activeJob.baseStateVersion === existingReservation.baseStateVersion
          || activeJob.baseStateVersion === frameInput.state.version
        );
      if (
        frameInput.state.orenId !== activeJob.orenId
        || (
          frameInput.state.version !== activeJob.baseStateVersion
          && !autonomyAlreadyReserved
        )
      ) {
        this.actor.recordCognitionDenied(activeJob, "stale_state_version");
        return;
      }
      if (autonomyAlreadyReserved) {
        activeJob = { ...activeJob, baseStateVersion: frameInput.state.version };
      }
      const decision = this.guard.evaluateCognition(
        frameInput.state,
        activeJob.triggerKind,
        frameInput.maxSteps,
        autonomyAlreadyReserved,
      );
      if (!decision.allowed) {
        this.actor.recordCognitionDenied(activeJob, decision.reason);
        return;
      }
      if (decision.autonomyCost > 0) {
        const consumed = this.actor.consumeAutonomy(activeJob, decision.autonomyCost);
        if (!consumed.accepted) {
          this.actor.recordCognitionDenied(activeJob, consumed.reason);
          return;
        }
        activeJob = consumed.job;
        frameInput = await this.loadFrameInput(activeJob);
      }
      if (signal.aborted) {
        writeExit({ kind: "aborted", reason: interruptionReason(signal) });
        return;
      }

      const handlers: CognitionHandlers = {
        invokeCapability: async (input, childSignal) => {
          const outcome = await this.capabilityPort.invoke({
            ...input,
            stateVersion: activeJob.baseStateVersion,
          }, childSignal);
          const refreshed = await this.loadFrameInput(activeJob);
          if (
            refreshed.state.orenId === activeJob.orenId
            && refreshed.state.version >= activeJob.baseStateVersion
          ) {
            activeJob = {
              ...activeJob,
              baseStateVersion: refreshed.state.version,
            };
          }
          return outcome;
        },
        submitCommit: async ({ commitId, proposals }) => {
          const result = this.actor.acceptCognitionCommit(
            activeJob,
            commitId,
            proposals,
          );
          if (!result.accepted || !updateVersion(result.stateVersion)) {
            const reason = result.reason ?? "commit_rejected";
            const rejected = this.actor.recordCognitionCommitRejected(
              activeJob,
              commitId,
              reason,
            );
            updateVersion(rejected.stateVersion);
            return { kind: "rejected", commitId, reason };
          }
          acceptedCommit = true;
          await this.onCommitAccepted?.(activeJob, proposals);
          const refreshed = await this.loadFrameInput(activeJob);
          if (
            refreshed.state.orenId === activeJob.orenId
            && refreshed.state.version >= activeJob.baseStateVersion
          ) {
            activeJob = {
              ...activeJob,
              baseStateVersion: refreshed.state.version,
            };
          }
          return {
            kind: "accepted",
            commitId,
            stateVersion: activeJob.baseStateVersion,
          };
        },
      };

      const frame = this.conductor.createFrame(frameInput);
      for await (const event of this.cognition.stream(frame, handlers, signal)) {
        if (terminalSeen) throw new Error("Cognition event received after terminal event");
        switch (event.type) {
          case "speech.started":
            if (activeUtterance) throw new Error("Overlapping cognition utterances");
            activeUtterance = { id: event.utteranceId, text: "" };
            if (activeJob.triggerKind === "foreground_user") {
              await this.speech.startSpeech({
                episodeId: activeJob.episodeId,
                messageId: event.utteranceId,
              });
            }
            break;
          case "speech.delta":
            if (!activeUtterance || activeUtterance.id !== event.utteranceId) {
              throw new Error("Speech delta does not match an active utterance");
            }
            activeUtterance.text += event.text;
            if (activeJob.triggerKind === "foreground_user") {
              await this.speech.appendSpeech({
                messageId: event.utteranceId,
                text: event.text,
              });
            }
            break;
          case "speech.completed": {
            if (!activeUtterance || activeUtterance.id !== event.utteranceId) {
              throw new Error("Speech completion does not match an active utterance");
            }
            const utterance = activeUtterance;
            activeUtterance = undefined;
            if (
              activeJob.triggerKind === "foreground_user"
              && utterance.text.length > 0
            ) {
              await this.speech.completeSpeech({
                messageId: utterance.id,
                status: "complete",
              });
              const recorded = this.actor.recordAssistantMessage(activeJob, {
                messageId: utterance.id,
                text: utterance.text,
                status: "complete",
              });
              if (!recorded.accepted || !updateVersion(recorded.stateVersion)) {
                throw new Error(
                  `Assistant message rejected: ${recorded.reason ?? "unknown_reason"}`,
                );
              }
              producedForegroundOutput = true;
            }
            break;
          }
          case "tool.started":
          case "tool.completed":
          case "commit.requested":
          case "commit.resolved":
            break;
          case "episode.completed": {
            terminalSeen = true;
            if (activeUtterance) {
              throw new Error("Cognition completed with an open utterance");
            }
            if (
              activeJob.triggerKind === "foreground_user"
              && !producedForegroundOutput
              && !acceptedCommit
            ) {
              throw new Error("Foreground cognition produced no output");
            }
            const completed = this.actor.completeCognition(
              activeJob,
              event.reason,
              event.usage,
            );
            if (!completed.accepted) {
              throw new Error(
                `Cognition completion rejected: ${completed.reason ?? "unknown_reason"}`,
              );
            }
            updateVersion(completed.stateVersion);
            break;
          }
          case "episode.failed":
            terminalSeen = true;
            await closeInterruptedSpeech();
            writeExit({ kind: "failed", message: event.message });
            break;
          case "episode.aborted":
            terminalSeen = true;
            await closeInterruptedSpeech();
            writeExit({ kind: "aborted", reason: interruptionReason(signal) });
            break;
        }
      }
      if (!terminalSeen) throw new Error("Cognition stream ended without a terminal event");
    } catch (error) {
      await closeInterruptedSpeech().catch(() => undefined);
      if (signal.aborted) {
        writeExit({ kind: "aborted", reason: interruptionReason(signal) });
      } else {
        writeExit({ kind: "failed", message: errorMessage(error) });
      }
    }
  }
}
