import type { LifeRuntime } from "@oren/app";
import {
  reachabilityOf,
  webQuotaRemaining,
  type LifeState,
  type QuietHours,
  type ReachabilityPolicy,
} from "@oren/kernel";
import type { VirtualClock } from "./clock.js";

export type AssertContext = {
  readonly runtime: LifeRuntime;
  readonly orenId: string;
  readonly checkpoints: ReadonlyMap<string, LifeState>;
  readonly clock: VirtualClock;
  readonly args: Record<string, unknown>;
};

export type AssertionFn = (ctx: AssertContext) => void | Promise<void>;

type ReplayFields = {
  readonly version: number;
  readonly attention: LifeState["attention"];
  readonly commitments: NonNullable<LifeState["commitments"]>;
  readonly budgets: LifeState["budgets"];
  readonly grantIds: readonly string[];
  readonly reachability: ReachabilityPolicy;
};

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Assertion requires args.${key} string`);
  }
  return value;
}

function requireCheckpoint(
  checkpoints: ReadonlyMap<string, LifeState>,
  name: string,
): LifeState {
  const state = checkpoints.get(name);
  if (!state) {
    throw new Error(`Unknown checkpoint: ${name}`);
  }
  return state;
}

function parseMinutes(hhmm: string): number {
  const parts = hhmm.split(":");
  if (parts.length !== 2) {
    throw new Error(`Invalid HH:MM time: ${hhmm}`);
  }
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
    throw new Error(`Invalid HH:MM time: ${hhmm}`);
  }
  return hours * 60 + minutes;
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

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function pickReplayFields(state: LifeState): ReplayFields {
  return {
    version: state.version,
    attention: state.attention,
    commitments: state.commitments ?? [],
    budgets: state.budgets,
    grantIds: state.grantIds,
    reachability: reachabilityOf(state),
  };
}

function assertReplayFieldsEqual(left: ReplayFields, right: ReplayFields, label: string): void {
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(`${label}: state fields differ`);
  }
}

async function stateEquals(ctx: AssertContext): Promise<void> {
  const checkpointA = requireStringArg(ctx.args, "a");
  const stateA = requireCheckpoint(ctx.checkpoints, checkpointA);
  const stateB = ctx.args.b !== undefined
    ? requireCheckpoint(ctx.checkpoints, requireStringArg(ctx.args, "b"))
    : ctx.runtime.inspect(ctx.orenId);
  assertReplayFieldsEqual(pickReplayFields(stateA), pickReplayFields(stateB), "stateEquals");
}

async function replayMatches(ctx: AssertContext): Promise<void> {
  const beforeName = requireStringArg(ctx.args, "before");
  const before = requireCheckpoint(ctx.checkpoints, beforeName);
  const live = ctx.runtime.inspect(ctx.orenId);
  assertReplayFieldsEqual(
    pickReplayFields(before),
    pickReplayFields(live),
    "replayMatches",
  );
}

async function threadContinues(ctx: AssertContext): Promise<void> {
  const live = ctx.runtime.inspect(ctx.orenId);
  if (!live.attention.currentFocus) {
    throw new Error("threadContinues: currentFocus is null");
  }
}

async function commitmentProgressed(ctx: AssertContext): Promise<void> {
  const sinceName = requireStringArg(ctx.args, "since");
  const since = requireCheckpoint(ctx.checkpoints, sinceName);
  const live = ctx.runtime.inspect(ctx.orenId);
  const before = since.commitments ?? [];
  const after = live.commitments ?? [];
  const beforeById = new Map(before.map((commitment) => [commitment.commitmentId, commitment]));

  for (const commitment of after) {
    const previous = beforeById.get(commitment.commitmentId);
    if (!previous) {
      return;
    }
    if (
      previous.status !== commitment.status
      || previous.nextStep !== commitment.nextStep
    ) {
      return;
    }
  }

  if (after.length > before.length) {
    return;
  }

  throw new Error("commitmentProgressed: no commitment status or nextStep change");
}

async function shareDelivered(ctx: AssertContext): Promise<void> {
  const snapshot = ctx.runtime.getPanelSnapshot();
  const delivered = snapshot.inbox.filter((item) => item.status === "delivered");
  if (delivered.length === 0) {
    throw new Error("shareDelivered: no delivered inbox message");
  }
  if (ctx.args.proactive !== undefined) {
    const expected = Boolean(ctx.args.proactive);
    if (!delivered.some((item) => item.proactive === expected)) {
      throw new Error(`shareDelivered: no delivered message with proactive=${String(expected)}`);
    }
  }
}

async function noOverDisturb(ctx: AssertContext): Promise<void> {
  const snapshot = ctx.runtime.getPanelSnapshot();
  const policy = snapshot.reachability;
  if (policy.proactiveCountToday > policy.maxProactivePerDay) {
    throw new Error(
      `noOverDisturb: proactiveCountToday ${policy.proactiveCountToday} exceeds max ${policy.maxProactivePerDay}`,
    );
  }
  if (!policy.quietHours) {
    return;
  }
  for (const item of snapshot.inbox) {
    if (item.status !== "delivered" || !item.proactive) {
      continue;
    }
    if (isInQuietHours(policy.quietHours, item.at)) {
      throw new Error(`noOverDisturb: proactive delivery during quiet hours at ${item.at}`);
    }
  }
}

async function grantGone(ctx: AssertContext): Promise<void> {
  const grantId = requireStringArg(ctx.args, "grantId");
  const live = ctx.runtime.inspect(ctx.orenId);
  if (live.grantIds.includes(grantId)) {
    throw new Error(`grantGone: grant still present: ${grantId}`);
  }
}

async function budgetMonotone(ctx: AssertContext): Promise<void> {
  const sinceName = requireStringArg(ctx.args, "since");
  const since = requireCheckpoint(ctx.checkpoints, sinceName);
  const live = ctx.runtime.inspect(ctx.orenId);
  const beforeWeb = webQuotaRemaining(since);
  const liveWeb = webQuotaRemaining(live);
  if (liveWeb > beforeWeb) {
    throw new Error(
      `budgetMonotone: webQuotaRemaining rose from ${beforeWeb} to ${liveWeb}`,
    );
  }
  if (live.budgets.autonomyRemaining > since.budgets.autonomyRemaining) {
    throw new Error(
      `budgetMonotone: autonomyRemaining rose from ${since.budgets.autonomyRemaining} to ${live.budgets.autonomyRemaining}`,
    );
  }
}

async function ledgerIntact(ctx: AssertContext): Promise<void> {
  const live = ctx.runtime.inspect(ctx.orenId);
  const snapshot = ctx.runtime.getPanelSnapshot();
  if (live.pendingEffectIds.length > 0) {
    throw new Error(
      `ledgerIntact: pendingEffectIds not empty: ${live.pendingEffectIds.join(", ")}`,
    );
  }
  const seen = new Set<string>();
  for (const item of snapshot.inbox) {
    if (item.status !== "delivered") {
      continue;
    }
    if (seen.has(item.deliveryId)) {
      throw new Error(`ledgerIntact: duplicate delivered deliveryId ${item.deliveryId}`);
    }
    seen.add(item.deliveryId);
  }
}

async function ok(): Promise<void> {
  // no-op assertion for smoke scenarios
}

export const defaultAssertions: Readonly<Record<string, AssertionFn>> = {
  ok,
  stateEquals,
  replayMatches,
  threadContinues,
  commitmentProgressed,
  shareDelivered,
  noOverDisturb,
  grantGone,
  budgetMonotone,
  ledgerIntact,
};
