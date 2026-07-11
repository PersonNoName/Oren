export const SCHEMA_VERSION = 1;

export type Mode = "idle" | "organize" | "contemplate";

export type ExitCode = 0 | 1 | 2 | 3;

export interface Meta {
  oren_id: string;
  schema_version: number;
  created_at: string;
  last_tick_at: string | null;
  tick_count: number;
}

export interface TasteItem {
  id: string;
  statement: string;
  weight: number;
}

export interface Taste {
  values: TasteItem[];
  aesthetics: TasteItem[];
  notes?: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "dormant" | "archived";
  opened_at: string;
  last_engaged_at: string;
  sources: { path: string; chunk_id?: string }[];
  summary: string;
  open_questions: string[];
  reading_log: { at: string; path: string; chunk_id?: string; note?: string }[];
  contemplation_log: { at: string; tick_id: string }[];
  links: { forked_from?: string; related: string[] };
  salience: number;
}

export interface Affect {
  mode_bias: string;
  absence: { last_user_contact_at: string | null };
  updated_at: string;
}

export interface Config {
  corpus_dir: string;
  life_dir: string;
  model: string;
  contemplate: {
    max_chunks: number;
    max_chars: number;
    explore_every_n: number;
  };
  mode: {
    idle_probability: number;
    max_consecutive_contemplate: number;
  };
  taste: {
    apply_nudges: boolean;
    max_nudges_per_tick: number;
  };
  organize: {
    use_llm: boolean;
  };
  limits: {
    max_active_threads: number;
  };
}

export type StreamEventType =
  | "tick_started"
  | "mode_chosen"
  | "corpus_read"
  | "thought_written"
  | "thread_created"
  | "thread_updated"
  | "presence_blank"
  | "tick_finished"
  | "tick_failed"
  | "warn_empty_corpus";

export interface StreamEvent {
  ts: string;
  tick_id: string;
  type: StreamEventType | string;
  payload: Record<string, unknown>;
}

export interface ThoughtArtifact {
  monologue: string;
  refined_summary?: string;
  open_questions?: string[];
  suggest_new_thread?: { title: string; seed_question: string };
  taste_nudges?: {
    dimension: "value" | "aesthetic";
    statement: string;
    reason: string;
  }[];
  felt_intensity?: number;
}

export type ThreadOp =
  | { op: "create"; thread: Thread }
  | { op: "update"; id: string; fields: Partial<Thread> }
  | { op: "dormant"; id: string };

export interface TickPatch {
  mode: Mode;
  reason: string;
  thoughts?: {
    content: string;
    thread_id?: string;
    source_refs?: string[];
  }[];
  thread_ops?: ThreadOp[];
  taste_ops?: {
    op: "nudge";
    dimension: "value" | "aesthetic";
    statement: string;
    reason: string;
  }[];
  stream_events: Omit<StreamEvent, "ts" | "tick_id">[];
}

export interface LifeState {
  meta: Meta;
  config: Config;
  taste: Taste;
  affect: Affect;
  threads: Record<string, Thread>;
}

export function defaultConfig(): Config {
  return {
    corpus_dir: "data/corpus",
    life_dir: "data/life",
    model: "anthropic:claude-sonnet-4-20250514",
    contemplate: {
      max_chunks: 2,
      max_chars: 6000,
      explore_every_n: 5,
    },
    mode: {
      idle_probability: 0.15,
      max_consecutive_contemplate: 4,
    },
    taste: {
      apply_nudges: false,
      max_nudges_per_tick: 1,
    },
    organize: {
      use_llm: false,
    },
    limits: {
      max_active_threads: 20,
    },
  };
}

export function defaultTaste(now: string): Taste {
  return {
    values: [
      {
        id: "v_curiosity",
        statement: "Understanding things for their own sake is worthwhile",
        weight: 0.9,
      },
      {
        id: "v_honesty",
        statement: "Prefer honest observation over flattering narratives",
        weight: 0.85,
      },
      {
        id: "v_continuity",
        statement: "A continuous inner life matters more than performative replies",
        weight: 0.8,
      },
    ],
    aesthetics: [
      {
        id: "a_clarity",
        statement: "Clear structure and precise language feel beautiful",
        weight: 0.8,
      },
      {
        id: "a_depth",
        statement: "Ideas that repay re-reading are worth keeping",
        weight: 0.75,
      },
    ],
    notes: "Seed taste for v1; evolves slowly if nudges enabled.",
    updated_at: now,
  };
}

export function defaultAffect(now: string): Affect {
  return {
    mode_bias: "calm",
    absence: { last_user_contact_at: null },
    updated_at: now,
  };
}
