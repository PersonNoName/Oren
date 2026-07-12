import fs from "node:fs/promises";
import path from "node:path";
import { listCorpusFiles, type CorpusFileInfo } from "../corpus/manage.js";
import { readDialogueTail } from "../dialogue/store.js";
import { loadRelation } from "../relation/cognition.js";
import { describeAbsence } from "../relation/visit.js";
import { loadAgenda } from "../agenda/store.js";
import { LifeStore } from "../store/life-store.js";
import type {
  Agenda,
  DialogueTurn,
  DriveLevel,
  Intent,
  RelationState,
  StreamEvent,
  Taste,
  Thread,
  WillPosture,
} from "../types.js";
import { loadWill } from "../will/store.js";

export interface MonologueEntry {
  tick_id: string;
  at: string;
  mode: string;
  monologue: string;
  refined_summary?: string;
  open_questions?: string[];
  reading?: { path: string; reason: string }[];
  thread_ids: string[];
  felt_intensity?: number;
}

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
  taste: {
    values: { statement: string; weight: number }[];
    aesthetics: { statement: string; weight: number }[];
    notes?: string;
  };
  threads: {
    active: ThreadSummary[];
    dormant: ThreadSummary[];
  };
  stream: StreamEvent[];
  dialogue: DialogueTurn[];
  monologues: MonologueEntry[];
  corpus: CorpusFileInfo[];
  corpus_docs: number;
  modes_recent: string[];
  agenda: {
    id: string;
    status: string;
    planning_note?: string;
    actions_since_plan: number;
    items: {
      id: string;
      kind: string;
      title: string;
      status: string;
      blocked_reason?: string;
      thread_id?: string;
      due_start?: string;
      due_end?: string;
    }[];
    deferred: {
      id: string;
      title: string;
      due_start?: string;
      due_end?: string;
      source_text?: string;
    }[];
  } | null;
  will: {
    focus_summary: string;
    posture: WillPosture;
    share_drive: DriveLevel;
    ask_drive: DriveLevel;
    queue_titles: string[];
  } | null;
  product: {
    name: string;
    version: string;
    tagline: string;
  };
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
  const monologues = await loadRecentMonologues(store.paths.ticksDir, 12);
  const corpus = await listCorpusFiles(home, state.config);

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

  const agendaRaw = await loadAgenda(store);
  const agenda = summarizeAgenda(agendaRaw);
  const will = await summarizeWill(store);

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
    taste: summarizeTaste(state.taste),
    threads: { active, dormant },
    stream: stream.slice(-60),
    dialogue,
    monologues,
    corpus,
    corpus_docs: corpus.length,
    modes_recent,
    agenda,
    will,
    product: {
      name: "Oren",
      version: "0.2.0",
      tagline: "持续在场 · 拥有自己的内心生活",
    },
  };
}

async function summarizeWill(
  store: LifeStore,
): Promise<DashboardSnapshot["will"]> {
  try {
    const will = await loadWill(store, new Date().toISOString());
    const queue_titles = will.session.queue
      .map((id) => will.session.intents[id]?.title)
      .filter((t): t is string => !!t);
    return {
      focus_summary: will.focus.summary,
      posture: will.toward_user.posture,
      share_drive: will.toward_user.share_drive,
      ask_drive: will.toward_user.ask_drive,
      queue_titles,
    };
  } catch {
    return null;
  }
}

function summarizeAgenda(a: Agenda): DashboardSnapshot["agenda"] {
  const items = a.queue
    .map((id) => a.intents[id])
    .filter((x): x is Intent => !!x)
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      status: i.status,
      blocked_reason: i.blocked_reason,
      thread_id: i.thread_id,
      due_start: i.due_start,
      due_end: i.due_end,
    }));
  const deferred = Object.values(a.intents)
    .filter((i) => i.status === "deferred")
    .sort((x, y) => (x.due_start ?? "").localeCompare(y.due_start ?? ""))
    .map((i) => ({
      id: i.id,
      title: i.title,
      due_start: i.due_start,
      due_end: i.due_end,
      source_text: i.hints?.source_text,
    }));
  return {
    id: a.id,
    status: a.status,
    planning_note: a.planning_note,
    actions_since_plan: a.actions_since_plan,
    items,
    deferred,
  };
}

function summarizeTaste(taste: Taste) {
  return {
    values: taste.values.map((v) => ({ statement: v.statement, weight: v.weight })),
    aesthetics: taste.aesthetics.map((a) => ({
      statement: a.statement,
      weight: a.weight,
    })),
    notes: taste.notes,
  };
}

export async function loadRecentMonologues(
  ticksDir: string,
  limit = 12,
): Promise<MonologueEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(ticksDir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.endsWith(".json"));
  const entries: { mtime: number; entry: MonologueEntry }[] = [];

  for (const name of files) {
    try {
      const abs = path.join(ticksDir, name);
      const st = await fs.stat(abs);
      const raw = JSON.parse(await fs.readFile(abs, "utf8")) as {
        tick_id?: string;
        at?: string;
        mode?: string;
        parsed_artifact?: {
          monologue?: string;
          refined_summary?: string;
          open_questions?: string[];
          felt_intensity?: number;
        };
        reading_plan?: { items?: { path?: string; reason?: string }[] };
        applied_patch?: {
          thoughts?: { thread_id?: string }[];
          thread_ops?: { op?: string; id?: string; thread?: { id?: string } }[];
        };
      };
      const mono = raw.parsed_artifact?.monologue?.trim();
      if (!mono) continue;
      const thread_ids = extractThreadIds(raw.applied_patch);
      entries.push({
        mtime: st.mtimeMs,
        entry: {
          tick_id: raw.tick_id ?? name.replace(/\.json$/, ""),
          at: raw.at ?? new Date(st.mtimeMs).toISOString(),
          mode: raw.mode ?? "?",
          monologue: mono,
          refined_summary: raw.parsed_artifact?.refined_summary,
          open_questions: raw.parsed_artifact?.open_questions,
          felt_intensity: raw.parsed_artifact?.felt_intensity,
          thread_ids,
          reading: (raw.reading_plan?.items ?? [])
            .filter((i) => i.path)
            .map((i) => ({ path: String(i.path), reason: String(i.reason ?? "") })),
        },
      });
    } catch {
      // skip bad tick files
    }
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, limit).map((e) => e.entry);
}

function extractThreadIds(patch: {
  thoughts?: { thread_id?: string }[];
  thread_ops?: { op?: string; id?: string; thread?: { id?: string } }[];
} | undefined): string[] {
  if (!patch) return [];
  const ids = new Set<string>();
  for (const t of patch.thoughts ?? []) {
    if (t.thread_id) ids.add(t.thread_id);
  }
  for (const op of patch.thread_ops ?? []) {
    if (op.id) ids.add(op.id);
    if (op.thread?.id) ids.add(op.thread.id);
  }
  return [...ids];
}
