import type { Agenda, Config, Intent } from "../types.js";
import { nextActionableIntent, pendingIntentIds } from "./store.js";

export type AgendaDecision =
  | { action: "idle_user_present"; reason: string }
  | { action: "plan"; reason: string }
  | { action: "act"; intent: Intent; reason: string }
  | { action: "idle_nothing"; reason: string };

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
 * Product lock:
 * 1) short session plan 3–7
 * 2) user present → pause plan/act
 * 3) new ideas only queue-tail (handled in act)
 * 4) seek visible but blocked (act skips / marks)
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

  const pending = pendingIntentIds(input.agenda);
  const actionable = nextActionableIntent(input.agenda);
  const needReplan =
    pending.length === 0 ||
    input.agenda.actions_since_plan >= ag.replan_after_actions ||
    input.agenda.status !== "open";

  if (needReplan && pending.length === 0) {
    return { action: "plan", reason: "empty_or_stale_agenda" };
  }
  if (input.agenda.actions_since_plan >= ag.replan_after_actions) {
    return { action: "plan", reason: "replan_after_actions" };
  }
  if (actionable) {
    return { action: "act", intent: actionable, reason: "next_pending_intent" };
  }
  // only blocked seeks left
  if (pending.length > 0) {
    return { action: "plan", reason: "only_blocked_intents" };
  }
  return { action: "plan", reason: "fallback_plan" };
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
