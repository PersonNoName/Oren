import { randomUUID } from "node:crypto";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  actOnIntent,
  lastProactiveSayAt,
  summarizeDialogueForPlan,
} from "../agenda/act.js";
import { promoteDueIntents } from "../agenda/deferred.js";
import { agendaConfig, canPlanSay, decideAgendaTick } from "../agenda/schedule.js";
import { buildCorpusIndex } from "../corpus/index.js";
import { collectChunkReadCounts, planReading } from "../corpus/retrieve.js";
import { readDialogueTail } from "../dialogue/store.js";
import { selectLlm } from "../llm/select.js";
import type { LlmCompleter } from "../llm/types.js";
import { corpusDir } from "../paths.js";
import { loadRelation } from "../relation/cognition.js";
import {
  LifeStore,
  LockError,
  NotInitializedError,
  SchemaMismatchError,
} from "../store/life-store.js";
import type { ExitCode, Mode, StreamEvent, TickPatch } from "../types.js";
import { reviseWill } from "../will/revise.js";
import { loadWill, saveWillAndAgenda } from "../will/store.js";
import { chooseMode } from "./choose-mode.js";
import { buildContemplatePatch } from "./contemplate.js";
import { integrate } from "./integrate.js";
import { buildOrganizePatch, planOrganize } from "./organize.js";
import { perceive } from "./perceive.js";

export interface TickResult {
  exitCode: ExitCode;
  tickId: string;
  mode: Mode;
  message: string;
}

export async function runTick(opts: {
  home: string;
  /** Legacy modes + plan. "act" is accepted via forceAgenda. */
  forceMode?: Mode | "act";
  llm: LlmCompleter;
  now?: () => Date;
  rng?: () => number;
}): Promise<TickResult> {
  const nowFn = opts.now ?? (() => new Date());
  const rng = opts.rng ?? Math.random;
  const store = new LifeStore(opts.home);
  const tickId = `tick_${randomUUID().slice(0, 12)}`;
  let lockAcquired = false;

  try {
    await store.acquireLock();
    lockAcquired = true;
  } catch (err) {
    if (err instanceof LockError) {
      return { exitCode: 2, tickId, mode: "idle", message: err.message };
    }
    throw err;
  }

  try {
    let state;
    try {
      state = await store.load();
    } catch (err) {
      if (err instanceof NotInitializedError || err instanceof SchemaMismatchError) {
        return {
          exitCode: 3,
          tickId,
          mode: "idle",
          message: err.message,
        };
      }
      throw err;
    }

    const now = nowFn();
    const nowIso = now.toISOString();
    const cDir = corpusDir(opts.home, state.config);
    const index = await buildCorpusIndex(cDir);
    await store.saveCorpusIndex(index);

    const streamTail = await store.readStreamTail(500);
    const perception = perceive({ state, index, streamTail, now });
    let will = await loadWill(store, nowIso);
    let agenda = will.session;
    const agCfg = agendaConfig(state.config);

    const force = opts.forceMode;
    const legacyForce =
      force === "idle" || force === "organize" || force === "contemplate";
    const agendaEnabled = agCfg.enabled && !legacyForce;

    let mode: Mode = "idle";
    let reason = "init";
    let patch: TickPatch;
    let readingPlan = null as ReturnType<typeof planReading> | null;
    let rawModel: string | null = null;
    let artifact: unknown = null;
    let agendaDirty = false;

    const baseEvents: StreamEvent[] = [
      {
        ts: nowIso,
        tick_id: tickId,
        type: "tick_started",
        payload: { gap_ms: perception.gap_ms },
      },
    ];

    if (agendaEnabled) {
      // Calendar: promote due deferred cares into queue tail before deciding.
      const promoted = promoteDueIntents(agenda, now, agCfg.max_intents);
      if (promoted.promoted.length > 0) {
        agenda = promoted.agenda;
        agendaDirty = true;
        baseEvents.push({
          ts: nowIso,
          tick_id: tickId,
          type: "mode_chosen",
          payload: {
            mode: "plan",
            reason: "promote_due_intents",
            promoted: promoted.promoted.map((p) => ({
              id: p.id,
              title: p.title,
            })),
          },
        });
      }

      const decision = decideAgendaTick({
        agenda,
        config: state.config,
        now,
        lastUserContactAt: state.affect.absence.last_user_contact_at,
        force:
          force === "plan" || force === "act"
            ? force
            : force === "idle"
              ? "idle"
              : undefined,
      });

      if (decision.action === "idle_user_present") {
        mode = "idle";
        reason = decision.reason;
        patch = {
          mode: "idle",
          reason,
          stream_events: [
            {
              type: "presence_blank",
              payload: {
                gap_ms: perception.gap_ms,
                note: "user_present_pause_agenda",
              },
            },
          ],
        };
      } else if (decision.action === "plan") {
        mode = "plan";
        reason = decision.reason;
        const planLlm = selectLlm(state.config.model, "plan");
        const unreadPaths = listUnreadPaths(index, state.threads);
        const relation = await loadRelation(store);
        const dialogueTail = await readDialogueTail(store, 16);
        const lastSay = lastProactiveSayAt(dialogueTail, agenda);
        const allowSay = canPlanSay({
          config: state.config,
          now,
          lastProactiveSayAt: lastSay,
        });
        try {
          const revised = await reviseWill({
            will,
            state,
            index,
            llm: planLlm,
            now: nowIso,
            relation,
            unreadPaths,
            canSeek: false,
            canSay: allowSay,
            dialogueSummary: summarizeDialogueForPlan(dialogueTail),
            lastProactiveSayAt: lastSay,
          });
          will = revised.will;
          agenda = will.session;
          agendaDirty = true;
          rawModel = revised.raw;
          artifact = {
            planning_note: agenda.planning_note,
            queue: agenda.queue.map((id) => agenda.intents[id]),
          };
          patch = {
            mode: "plan",
            reason: `plan:${reason}`,
            stream_events: [
              {
                type: "thought_written",
                payload: {
                  kind: "planning_note",
                  monologue_preview: (agenda.planning_note ?? "").slice(0, 240),
                  intent_count: agenda.queue.length,
                  can_say: allowSay,
                },
              },
              {
                type: "will_revised",
                payload: {
                  reason,
                  focus: will.focus,
                  queue_len: will.session.queue.length,
                },
              },
            ],
          };
        } catch (err) {
          reason = `plan_failed:${err instanceof Error ? err.message : String(err)}`;
          mode = "idle";
          patch = {
            mode: "idle",
            reason,
            stream_events: [
              {
                type: "tick_failed",
                payload: { phase: "plan", message: reason },
              },
            ],
          };
        }
      } else if (decision.action === "act") {
        const actLlm =
          decision.intent.kind === "organize"
            ? selectLlm(state.config.model, "organize")
            : decision.intent.kind === "say"
              ? selectLlm(state.config.model, "say")
              : decision.intent.kind === "read" || decision.intent.kind === "think"
                ? selectLlm(state.config.model, "tick")
                : opts.llm;
        // Prefer live for read/think/say act when key present (override fake tick for substance)
        const livePrefer =
          decision.intent.kind === "read" ||
          decision.intent.kind === "think" ||
          decision.intent.kind === "say"
            ? selectLlm(
                state.config.model,
                decision.intent.kind === "say" ? "say" : "plan",
              )
            : actLlm;
        const dialogueTail = await readDialogueTail(store, 16);
        const relation = await loadRelation(store);
        const acted = await actOnIntent({
          intent: decision.intent,
          agenda,
          state,
          index,
          llm: livePrefer,
          organizeLlm: selectLlm(state.config.model, "organize"),
          tickId,
          now: nowIso,
          dialogueTail,
          relation,
          store,
        });
        mode = acted.mode;
        reason = decision.reason;
        patch = acted.patch;
        readingPlan = acted.readingPlan;
        rawModel = acted.rawModel;
        artifact = acted.artifact;
        agenda = acted.agenda;
        agendaDirty = true;
      } else {
        mode = "idle";
        reason = decision.reason;
        patch = {
          mode: "idle",
          reason,
          stream_events: [
            {
              type: "presence_blank",
              payload: { gap_ms: perception.gap_ms, note: "agenda_idle" },
            },
          ],
        };
      }
    } else {
      // Legacy path (force idle/organize/contemplate or agenda disabled)
      const chosen = chooseMode({
        force:
          force === "idle" || force === "organize" || force === "contemplate"
            ? force
            : undefined,
        recentModes: perception.recentModes,
        config: state.config,
        hasReadableCorpus: perception.hasReadableCorpus,
        activeThreadCount: perception.activeThreadCount,
        rng,
      });
      mode = chosen.mode;
      reason = chosen.reason;

      if (mode === "contemplate") {
        readingPlan = planReading({
          index,
          taste: state.taste,
          threads: state.threads,
          config: state.config,
          contemplateOrdinal: perception.contemplateOrdinal,
        });
        if (
          readingPlan.kind === "think" &&
          readingPlan.items.length === 0 &&
          !readingPlan.thread_id &&
          Object.keys(state.threads).length === 0 &&
          index.docs.length === 0
        ) {
          mode = "idle";
          reason = "degraded_empty_corpus";
          baseEvents.push({
            ts: nowIso,
            tick_id: tickId,
            type: "warn_empty_corpus",
            payload: {},
          });
        } else if (readingPlan.kind === "think") {
          reason = `${reason}+${readingPlan.intent}`;
        }
      }

      if (mode === "idle") {
        patch = {
          mode: "idle",
          reason,
          stream_events: [
            {
              type: "presence_blank",
              payload: { gap_ms: perception.gap_ms, note: "idle" },
            },
          ],
        };
      } else if (mode === "organize") {
        if (state.config.organize.use_llm) {
          const organizeLlm = selectLlm(state.config.model, "organize");
          const dialogueTail = await readDialogueTail(store, 10);
          const relation = await loadRelation(store);
          const built = await buildOrganizePatch({
            state,
            llm: organizeLlm,
            tickId,
            now: nowIso,
            dialogueTail,
            relation,
          });
          patch = built.patch;
          rawModel = built.raw;
          artifact = built.artifact;
        } else {
          const org = planOrganize({
            threads: state.threads,
            config: state.config,
            now: nowIso,
          });
          patch = {
            mode: "organize",
            reason: org.reason || reason,
            thread_ops: org.thread_ops,
            stream_events: org.thread_ops.map((op) => ({
              type: "thread_updated",
              payload: { op },
            })),
          };
        }
      } else {
        const built = await buildContemplatePatch({
          state,
          plan: readingPlan!,
          llm: opts.llm,
          tickId,
          now: nowIso,
        });
        patch = built.patch;
        rawModel = built.raw;
        artifact = built.artifact;
      }
    }

    baseEvents.push({
      ts: nowIso,
      tick_id: tickId,
      type: "mode_chosen",
      payload: { mode, reason, agenda_enabled: agendaEnabled },
    });

    const integrated = integrate(state, patch, nowIso);
    const nextMeta = {
      ...integrated.state.meta,
      last_tick_at: nowIso,
      tick_count: integrated.state.meta.tick_count + 1,
    };

    const streamEvents: StreamEvent[] = [
      ...baseEvents,
      ...patch.stream_events.map((e) => ({
        ts: nowIso,
        tick_id: tickId,
        type: e.type,
        payload: e.payload,
      })),
      {
        ts: nowIso,
        tick_id: tickId,
        type: "tick_finished",
        payload: { mode, reason: patch.reason },
      },
    ];

    const tickSnapshot = {
      tick_id: tickId,
      at: nowIso,
      mode,
      reason: patch.reason,
      gap_ms: perception.gap_ms,
      reading_plan: readingPlan,
      raw_model_text: rawModel,
      parsed_artifact: artifact,
      applied_patch: {
        ...patch,
        applied: integrated.applied,
      },
    };

    await store.persistSuccess({
      meta: nextMeta,
      taste: integrated.state.taste,
      affect: integrated.state.affect,
      threads: integrated.state.threads,
      threadIdsTouched: integrated.threadIdsTouched,
      streamEvents,
      tickSnapshot,
      tickId,
    });

    if (agendaDirty) {
      will = {
        ...will,
        session: agenda,
        updated_at: nowIso,
      };
      await saveWillAndAgenda(store, will);
    }

    return {
      exitCode: 0,
      tickId,
      mode,
      message: `tick=${tickId} mode=${mode} gap_ms=${perception.gap_ms} status=ok`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await store.appendStream([
        {
          ts: new Date().toISOString(),
          tick_id: tickId,
          type: "tick_failed",
          payload: { message },
        },
      ]);
    } catch {
      // ignore secondary failure
    }
    return { exitCode: 1, tickId, mode: "idle", message };
  } finally {
    if (lockAcquired) {
      await store.releaseLock();
    }
  }
}

function listUnreadPaths(
  index: Awaited<ReturnType<typeof buildCorpusIndex>>,
  threads: import("../types.js").LifeState["threads"],
): string[] {
  const counts = collectChunkReadCounts(threads);
  const unread = new Set<string>();
  for (const d of index.docs) {
    const anyUnread = d.chunks.some((c) => (counts.get(c.chunk_id) ?? 0) === 0);
    if (anyUnread || d.chunks.length === 0) unread.add(d.path);
  }
  return [...unread];
}

/** Hash all files under corpus for DoD D8 helpers */
export async function hashCorpusTree(corpusRoot: string): Promise<string> {
  const hashes: string[] = [];
  async function walk(dir: string) {
    let ents;
    try {
      ents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) {
        const buf = await fs.readFile(abs);
        hashes.push(
          `${path.relative(corpusRoot, abs)}:${createHash("sha256").update(buf).digest("hex")}`,
        );
      }
    }
  }
  await walk(corpusRoot);
  hashes.sort();
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}
