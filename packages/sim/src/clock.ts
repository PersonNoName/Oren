import { canonicalizeInstant } from "@oren/kernel";

const DEFAULT_ORIGIN = "2026-01-01T00:00:00.000Z";

function parseInstant(iso: string): number {
  const canonical = canonicalizeInstant(iso);
  if (canonical === undefined) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid instant: ${iso}`);
    }
    return ms;
  }
  return Date.parse(canonical);
}

export class VirtualClock {
  private currentMs: number;

  public constructor(startIso: string = DEFAULT_ORIGIN) {
    this.currentMs = parseInstant(startIso);
  }

  public now(): string {
    return new Date(this.currentMs).toISOString();
  }

  public advanceTo(iso: string): void {
    const targetMs = parseInstant(iso);
    if (targetMs < this.currentMs) {
      throw new Error("Cannot rewind virtual clock: time must advance monotonically");
    }
    this.currentMs = targetMs;
  }

  public advanceBy(ms: number): void {
    if (ms < 0) {
      throw new Error("Cannot advance virtual clock by a negative duration");
    }
    this.currentMs += ms;
  }
}
