import type { Agenda, Config, Intent } from "../types.js";
import { nextActionableIntent, pendingIntentIds } from "./store.js";

export type AgendaDecision =
  | { action: "idle_user_present"; reason: string }
  | { action: "plan"; reason: string }
  | { action: "act"; intent: Intent; reason: string }
  | { action: "idle_nothing"; reason: string }
  /** No LLM: recently planned, nothing actionable yet — avoid replan thrash. */
  | { action: "idle_light"; reason: string };

export function agendaConfig(config: Config) {
  return (
    config.agenda ?? {
      enabled: true,
      user_present_ms: 2 * 60 * 1000,
      min_intents: 3,
      max_intents: 7,
      replan_after_actions: 3,
      allow_seek_in_plan: true,
      max_care_checkins: 2,
      allow_say_in_plan: true,
      say_cooldown_ms: 4 * 60 * 60 * 1000,
      /** Min gap between unsupervised replans when nothing was acted (ms). */
      min_replan_gap_ms: 20 * 60 * 1000,
    }
  );
}

/** True if a proactive say may be planned/acted (cooldown + config). */
export function canPlanSay(input: {
  config: Config;
  now: Date;
  lastProactiveSayAt: string | null;
}): boolean {
  const ag = agendaConfig(input.config);
  if (ag.allow_say_in_plan === false) return false;
  const cool = ag.say_cooldown_ms ?? 4 * 60 * 60 * 1000;
  if (!input.lastProactiveSayAt) return true;
  const t = Date.parse(input.lastProactiveSayAt);
  if (!Number.isFinite(t)) return true;
  return input.now.getTime() - t >= cool;
}

/**
 * Product lock (curiosity + thrift of attention, not of agency):
 * 1) short session plan 3–7
 * 2) user present → pause plan/act
 * 3) **act before replan** whenever something is actionable
 * 4) avoid replan thrash right after a fresh plan (idle_light, zero LLM)
 * 5) seek visible but blocked (act skips / marks)
 */
export function decideAgendaTick(input: {
  agenda: Agenda;
  config: Config;
  now: Date;
  lastUserContactAt: string | null;
  force?: "plan" | "act" | "idle" | "organize" | "contemplate";
}): AgendaDecision {
  const ag = agendaConfig(input.config);

  if (input.force === "plan") {
    return { action: "plan", reason: "force:plan" };
  }
  if (input.force === "act") {
    const intent = nextActionableIntent(input.agenda);
    if (intent) return { action: "act", intent, reason: "force:act" };
    return { action: "plan", reason: "force:act_empty_queue" };
  }
  // legacy force modes bypass agenda decision (engine handles)
  if (
    input.force === "idle" ||
    input.force === "organize" ||
    input.force === "contemplate"
  ) {
    return { action: "idle_nothing", reason: `legacy_force:${input.force}` };
  }

  if (!ag.enabled) {
    return { action: "idle_nothing", reason: "agenda_disabled" };
  }

  if (isUserPresent(input.lastUserContactAt, input.now, ag.user_present_ms)) {
    return {
      action: "idle_user_present",
      reason: "user_present_pause_plan_act",
    };
  }

  // P1: always finish actionable work before opening another planning meeting
  const actionable = nextActionableIntent(input.agenda);
  if (actionable) {
    return {
      action: "act",
      intent: actionable,
      reason: "next_pending_intent",
    };
  }

  const pending = pendingIntentIds(input.agenda);
  const gap = ag.min_replan_gap_ms ?? 20 * 60 * 1000;
  const plannedAt = Date.parse(input.agenda.created_at);
  const sincePlan = Number.isFinite(plannedAt)
    ? input.now.getTime() - plannedAt
    : Number.POSITIVE_INFINITY;
  const withinGap = sincePlan >= 0 && sincePlan < gap;
  const hasPlanned = Boolean(input.agenda.planning_note?.trim());
  const actedThisPlan = input.agenda.actions_since_plan > 0;

  // Fresh plan, nothing acted, nothing left to do (blocked-only or empty) → sit quietly
  if (withinGap && hasPlanned && !actedThisPlan) {
    return {
      action: "idle_light",
      reason: pending.length
        ? "replan_gap_no_actionable"
        : "replan_gap_fresh_plan",
    };
  }

  // After real work, or gap elapsed → plan again (agency intact; thrash reduced)
  if (pending.length === 0) {
    return { action: "plan", reason: "empty_or_stale_agenda" };
  }
  // only blocked seeks / non-actionable left
  return { action: "plan", reason: "only_blocked_intents" };
}

export function isUserPresent(
  lastUserContactAt: string | null,
  now: Date,
  windowMs: number,
): boolean {
  if (!lastUserContactAt) return false;
  const t = Date.parse(lastUserContactAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < windowMs;
}
