import { randomUUID } from "node:crypto";
import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { buildCorpusIndex } from "../corpus/index.js";
import { planReading } from "../corpus/retrieve.js";
import type { LlmCompleter } from "../llm/types.js";
import { corpusDir } from "../paths.js";
import {
  LifeStore,
  LockError,
  NotInitializedError,
  SchemaMismatchError,
} from "../store/life-store.js";
import type { ExitCode, Mode, StreamEvent, TickPatch } from "../types.js";
import { chooseMode } from "./choose-mode.js";
import { buildContemplatePatch } from "./contemplate.js";
import { integrate } from "./integrate.js";
import { planOrganize } from "./organize.js";
import { perceive } from "./perceive.js";

export interface TickResult {
  exitCode: ExitCode;
  tickId: string;
  mode: Mode;
  message: string;
}

export async function runTick(opts: {
  home: string;
  forceMode?: Mode;
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

    let { mode, reason } = chooseMode({
      force: opts.forceMode,
      recentModes: perception.recentModes,
      config: state.config,
      hasReadableCorpus: perception.hasReadableCorpus,
      activeThreadCount: perception.activeThreadCount,
      rng,
    });

    const baseEvents: StreamEvent[] = [
      {
        ts: nowIso,
        tick_id: tickId,
        type: "tick_started",
        payload: { gap_ms: perception.gap_ms },
      },
    ];

    let patch: TickPatch;
    let readingPlan = null as ReturnType<typeof planReading> | null;
    let rawModel: string | null = null;
    let artifact: unknown = null;

    if (mode === "contemplate") {
      readingPlan = planReading({
        index,
        taste: state.taste,
        threads: state.threads,
        config: state.config,
        contemplateOrdinal: perception.contemplateOrdinal,
      });
      if (readingPlan.items.length === 0) {
        mode = "idle";
        reason = "degraded_empty_corpus";
        baseEvents.push({
          ts: nowIso,
          tick_id: tickId,
          type: "warn_empty_corpus",
          payload: {},
        });
      }
    }

    baseEvents.push({
      ts: nowIso,
      tick_id: tickId,
      type: "mode_chosen",
      payload: { mode, reason },
    });

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
          type: op.op === "dormant" ? "thread_updated" : "thread_updated",
          payload: { op },
        })),
      };
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
