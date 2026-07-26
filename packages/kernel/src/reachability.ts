import type { LifeState } from "./state.js";

export type QuietHours = {
  readonly start: string;
  readonly end: string;
  readonly timezone: "UTC";
};

export type ReachabilityPolicy = {
  readonly quietHours: QuietHours | null;
  readonly maxProactivePerDay: number;
  readonly deferWhenQuiet: true;
  readonly proactiveDayKey: string | null;
  readonly proactiveCountToday: number;
};

export type DeliveryCause = "quiet_hours" | "frequency_cap";

export type ReachabilityDecision =
  | { readonly action: "deliver" }
  | { readonly action: "defer"; readonly cause: DeliveryCause; readonly deferUntil: string };

export type ReachabilityPolicyInput = Omit<
  ReachabilityPolicy,
  "proactiveDayKey" | "proactiveCountToday"
>;

export const DEFAULT_QUIET_HOURS: QuietHours = {
  start: "22:00",
  end: "08:00",
  timezone: "UTC",
};

export const DEFAULT_REACHABILITY: ReachabilityPolicy = {
  quietHours: DEFAULT_QUIET_HOURS,
  maxProactivePerDay: 3,
  deferWhenQuiet: true,
  proactiveDayKey: null,
  proactiveCountToday: 0,
};

export function reachabilityOf(state: LifeState): ReachabilityPolicy {
  return state.reachability ?? DEFAULT_REACHABILITY;
}

function parseHhMm(hhmm: string): { hours: number; minutes: number } | undefined {
  const parts = hhmm.split(":");
  if (parts.length !== 2) return undefined;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (
    !Number.isFinite(hours)
    || !Number.isFinite(minutes)
    || hours < 0
    || hours > 23
    || minutes < 0
    || minutes > 59
  ) {
    return undefined;
  }
  return { hours, minutes };
}

function parseMinutes(hhmm: string): number {
  const parsed = parseHhMm(hhmm);
  if (!parsed) {
    throw new Error(`Invalid HH:MM time: ${hhmm}`);
  }
  return parsed.hours * 60 + parsed.minutes;
}

function utcMinutes(nowIso: string): number {
  const date = new Date(nowIso);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isInQuietHours(quietHours: QuietHours, nowIso: string): boolean {
  const minutes = utcMinutes(nowIso);
  const start = parseMinutes(quietHours.start);
  const end = parseMinutes(quietHours.end);
  if (start > end) {
    return minutes >= start || minutes < end;
  }
  return minutes >= start && minutes < end;
}

export function utcDayKey(nowIso: string): string {
  const date = new Date(nowIso);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextUtcMidnight(nowIso: string): string {
  const date = new Date(nowIso);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

export function nextDeliverAt(
  policy: ReachabilityPolicy,
  nowIso: string,
  cause: DeliveryCause,
): string {
  if (cause === "frequency_cap") {
    return nextUtcMidnight(nowIso);
  }
  if (!policy.quietHours) {
    return nextUtcMidnight(nowIso);
  }
  const minutes = utcMinutes(nowIso);
  const start = parseMinutes(policy.quietHours.start);
  const end = parseMinutes(policy.quietHours.end);
  const endTime = parseHhMm(policy.quietHours.end);
  if (!endTime) {
    return nextUtcMidnight(nowIso);
  }
  const date = new Date(nowIso);
  date.setUTCSeconds(0, 0);
  if (start > end) {
    if (minutes >= start) {
      date.setUTCDate(date.getUTCDate() + 1);
    }
  }
  date.setUTCHours(endTime.hours, endTime.minutes, 0, 0);
  return date.toISOString();
}

export function evaluateReachability(
  policy: ReachabilityPolicy,
  nowIso: string,
  proactive: boolean,
): ReachabilityDecision {
  if (!proactive) {
    return { action: "deliver" };
  }
  const dayKey = utcDayKey(nowIso);
  if (
    policy.proactiveDayKey === dayKey
    && policy.proactiveCountToday >= policy.maxProactivePerDay
  ) {
    return {
      action: "defer",
      cause: "frequency_cap",
      deferUntil: nextDeliverAt(policy, nowIso, "frequency_cap"),
    };
  }
  if (
    policy.quietHours !== null
    && policy.deferWhenQuiet
    && isInQuietHours(policy.quietHours, nowIso)
  ) {
    return {
      action: "defer",
      cause: "quiet_hours",
      deferUntil: nextDeliverAt(policy, nowIso, "quiet_hours"),
    };
  }
  return { action: "deliver" };
}
