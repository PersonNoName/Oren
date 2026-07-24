export interface DueSchedule {
  readonly scheduleId: string;
  readonly orenId: string;
  readonly purpose: string;
}

export interface ScheduleRepository {
  claimDue(now: string, limit: number): DueSchedule[];
  deliverWake(schedule: DueSchedule, now: string): boolean | void;
}

export interface SchedulerOptions {
  readonly now?: () => string;
  readonly claimLimit?: number;
}

export class Scheduler {
  private readonly now: () => string;
  private readonly claimLimit: number;

  public constructor(
    private readonly repository: ScheduleRepository,
    options: SchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.claimLimit = options.claimLimit ?? 32;
  }

  public runOnce(now = this.now()): number {
    const due = this.repository.claimDue(now, this.claimLimit);
    let delivered = 0;
    for (const schedule of due) {
      if (this.repository.deliverWake(schedule, now) !== false) delivered += 1;
    }
    return delivered;
  }
}
