import { readDialogueTail } from "../dialogue/store.js";
import { corpusDir } from "../paths.js";
import { loadRelation } from "../relation/cognition.js";
import { describeAbsence } from "../relation/visit.js";
import { LifeStore } from "../store/life-store.js";
import type { DialogueTurn, RelationState, StreamEvent, Thread } from "../types.js";
import fs from "node:fs/promises";
import path from "node:path";

export interface DashboardSnapshot {
  generated_at: string;
  home: string;
  meta: {
    oren_id: string;
    tick_count: number;
    last_tick_at: string | null;
    model: string;
  };
  relation_field: string;
  relation: RelationState;
  threads: {
    active: ThreadSummary[];
    dormant: ThreadSummary[];
  };
  stream: StreamEvent[];
  dialogue: DialogueTurn[];
  corpus_docs: number;
  modes_recent: string[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  status: string;
  salience: number;
  summary: string;
  open_questions: string[];
  last_engaged_at: string;
  contemplation_count: number;
}

export async function buildDashboardSnapshot(home: string): Promise<DashboardSnapshot> {
  const store = new LifeStore(home);
  const state = await store.load();
  const relation = await loadRelation(store);
  const stream = await store.readStreamTail(80);
  const dialogue = await readDialogueTail(store, 40);

  const threads = Object.values(state.threads);
  const toSummary = (t: Thread): ThreadSummary => ({
    id: t.id,
    title: t.title,
    status: t.status,
    salience: t.salience,
    summary: t.summary,
    open_questions: t.open_questions,
    last_engaged_at: t.last_engaged_at,
    contemplation_count: t.contemplation_log?.length ?? 0,
  });

  const active = threads
    .filter((t) => t.status === "active")
    .sort((a, b) => b.salience - a.salience)
    .map(toSummary);
  const dormant = threads
    .filter((t) => t.status === "dormant")
    .sort((a, b) => b.last_engaged_at.localeCompare(a.last_engaged_at))
    .map(toSummary)
    .slice(0, 20);

  const modes_recent = stream
    .filter((e) => e.type === "mode_chosen")
    .map((e) => String(e.payload.mode ?? "?"))
    .slice(-20);

  let corpus_docs = 0;
  try {
    const cDir = corpusDir(home, state.config);
    const walk = async (d: string) => {
      const ents = await fs.readdir(d, { withFileTypes: true });
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(md|txt|markdown)$/i.test(e.name) && e.name !== "README.md") {
          corpus_docs++;
        }
      }
    };
    await walk(cDir);
  } catch {
    corpus_docs = 0;
  }

  return {
    generated_at: new Date().toISOString(),
    home,
    meta: {
      oren_id: state.meta.oren_id,
      tick_count: state.meta.tick_count,
      last_tick_at: state.meta.last_tick_at,
      model: state.config.model,
    },
    relation_field: describeAbsence(state.affect),
    relation,
    threads: { active, dormant },
    stream: stream.slice(-60),
    dialogue,
    corpus_docs,
    modes_recent,
  };
}
