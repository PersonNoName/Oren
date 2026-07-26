import type { CognitionJob, EpisodeInterruptionReason } from "@oren/kernel";

const TRIGGER_PRIORITY = {
  foreground_user: 5,
  effect_result: 4,
  commitment_due: 3,
  scheduled_wake: 2,
  health_check: 1,
} as const;

interface PendingEpisode {
  readonly job: CognitionJob;
  readonly sequence: number;
  readonly started: () => void;
}

interface ActiveEpisode {
  readonly job: CognitionJob;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

interface OrenEpisodes {
  active: ActiveEpisode | undefined;
  readonly pending: PendingEpisode[];
  readonly idleWaiters: Array<() => void>;
  stopped: boolean;
}

export class EpisodeScheduler {
  private readonly episodes = new Map<string, OrenEpisodes>();
  private sequence = 0;
  private readonly closeEpisode: (
    job: CognitionJob,
    signal: AbortSignal,
  ) => Promise<void>;

  public constructor(
    private readonly runEpisode: (job: CognitionJob, signal: AbortSignal) => Promise<void>,
    closeEpisode?: (job: CognitionJob, signal: AbortSignal) => Promise<void>,
  ) {
    this.closeEpisode = closeEpisode ?? runEpisode;
  }

  public start(job: CognitionJob): Promise<void> {
    const state = this.getState(job.orenId);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    state.pending.push({ job, sequence: this.sequence++, started });
    state.pending.sort((left, right) =>
      TRIGGER_PRIORITY[right.job.triggerKind] - TRIGGER_PRIORITY[left.job.triggerKind]
      || left.sequence - right.sequence);

    if (
      state.active
      && TRIGGER_PRIORITY[job.triggerKind] > TRIGGER_PRIORITY[state.active.job.triggerKind]
      && !state.active.controller.signal.aborted
    ) {
      const reason: EpisodeInterruptionReason = job.triggerKind === "foreground_user"
        ? "foreground_user"
        : "trigger_priority";
      state.active.controller.abort(reason);
    }
    this.pump(job.orenId, state);
    return startedPromise;
  }

  public waitForIdle(orenId: string): Promise<void> {
    const state = this.episodes.get(orenId);
    if (!state || (!state.active && state.pending.length === 0)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      state.idleWaiters.push(resolve);
    });
  }

  public interrupt(orenId: string, reason: EpisodeInterruptionReason): Promise<void> {
    const state = this.episodes.get(orenId);
    if (reason === "shutdown") {
      const shutdownState = state ?? this.getState(orenId);
      shutdownState.stopped = true;
      shutdownState.active?.controller.abort(reason);
      this.pump(orenId, shutdownState);
      return this.waitForIdle(orenId);
    }
    if (!state?.active) return Promise.resolve();
    state.active.controller.abort(reason);
    return state.active.settled;
  }

  public resume(orenId: string): void {
    const state = this.episodes.get(orenId);
    if (!state) return;
    state.stopped = false;
    this.pump(orenId, state);
  }

  private getState(orenId: string): OrenEpisodes {
    const existing = this.episodes.get(orenId);
    if (existing) return existing;
    const created: OrenEpisodes = {
      active: undefined,
      pending: [],
      idleWaiters: [],
      stopped: false,
    };
    this.episodes.set(orenId, created);
    return created;
  }

  private pump(orenId: string, state: OrenEpisodes): void {
    if (state.active) return;
    const next = state.pending.shift();
    if (!next) {
      if (!state.stopped) this.episodes.delete(orenId);
      for (const resolve of state.idleWaiters.splice(0)) resolve();
      return;
    }

    const controller = new AbortController();
    if (state.stopped) controller.abort("shutdown");
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveEpisode = {
      job: next.job,
      controller,
      settled,
    };
    state.active = active;

    let run: Promise<void>;
    try {
      run = state.stopped
        ? this.closeEpisode(next.job, controller.signal)
        : this.runEpisode(next.job, controller.signal);
    } catch (error) {
      run = Promise.reject(error);
    }
    void Promise.resolve(run)
      .catch(() => undefined)
      .finally(() => {
        if (state.active === active) state.active = undefined;
        this.pump(orenId, state);
        resolveSettled();
      });
    next.started();
  }
}
