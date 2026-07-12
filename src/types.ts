export const SCHEMA_VERSION = 1;

export type Mode = "idle" | "organize" | "contemplate" | "plan";

/** Solitary agenda: short session plan (3–7 intents). */
export type IntentKind =
  | "read"
  | "think"
  | "organize"
  | "seek"
  | "idle"
  /** Proactive outreach: Oren decides to message the user (dialogue, no user prompt). */
  | "say";
export type IntentStatus =
  | "pending"
  | "active"
  | "done"
  | "skipped"
  | "blocked"
  /** Calendar: not in actionable queue until due_start. */
  | "deferred";
export type IntentSource = "plan" | "during_action" | "dialogue" | "system";

export interface IntentHints {
  paths?: string[];
  query?: string;
  open_questions?: string[];
  why?: string;
  /** Original user utterance that created a calendar care item. */
  source_text?: string;
}

export interface IntentOutcome {
  at: string;
  summary: string;
  spawned_intent_ids?: string[];
}

export interface Intent {
  id: string;
  kind: IntentKind;
  title: string;
  status: IntentStatus;
  priority: number;
  created_at: string;
  source: IntentSource;
  thread_id?: string;
  hints?: IntentHints;
  outcome?: IntentOutcome;
  blocked_reason?: string;
  /** Inclusive window start (ISO) when deferred item may promote to pending. */
  due_start?: string;
  /** Inclusive window end (ISO); after this still promote once then soft-expire. */
  due_end?: string;
  /** How many times this care item was acted on (anti-nag). */
  care_count?: number;
  /** Max gentle check-ins before auto-done. Default 2. */
  max_care?: number;
}

export interface Agenda {
  id: string;
  created_at: string;
  updated_at: string;
  horizon: "session" | "day" | "open";
  status: "open" | "closed";
  queue: string[];
  intents: Record<string, Intent>;
  planning_note?: string;
  actions_since_plan: number;
}

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

/** Grounded excerpt from corpus — the only material dialogue may treat as "I read…". */
export interface ThreadQuote {
  text: string;
  path: string;
  chunk_id?: string;
  at: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "active" | "dormant" | "archived";
  opened_at: string;
  last_engaged_at: string;
  sources: { path: string; chunk_id?: string }[];
  /** Short excerpts taken from reading plan text (not model-invented). */
  quotes?: ThreadQuote[];
  summary: string;
  open_questions: string[];
  reading_log: { at: string; path: string; chunk_id?: string; note?: string }[];
  contemplation_log: { at: string; tick_id: string }[];
  links: { forked_from?: string; related: string[] };
  salience: number;
}

export interface Affect {
  mode_bias: string;
  absence: {
    last_user_contact_at: string | null;
    /** Optional short note from last visit (not a chat log). */
    last_note?: string | null;
    visit_count: number;
  };
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
    /**
     * Prefer never-read corpus chunks. When the shelf has no unread material,
     * contemplate switches to pure think (no forced reread) unless allow_reread.
     */
    prefer_unread?: boolean;
    /** If true, may lightly reread after unread is exhausted. Default false. */
    allow_reread?: boolean;
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
    /** Soft-dormant when last_engaged older than this (ms). Default 7d. */
    stale_ms: number;
    /** Max salience eligible for soft-dormant. Default 0.15. */
    dormant_salience_below: number;
  };
  limits: {
    max_active_threads: number;
  };
  /**
   * Solitary agenda (plan while idle, act one intent at a time).
   * When user recently spoke, plan/act pause (dialogue only).
   */
  agenda?: {
    enabled: boolean;
    /** Pause plan/act if last user contact within this window (ms). */
    user_present_ms: number;
    min_intents: number;
    max_intents: number;
    /** After this many acts, prefer replan even if queue non-empty. */
    replan_after_actions: number;
    /** Whether seek intents may be planned (always blocked until rights granted). */
    allow_seek_in_plan: boolean;
    /** Max gentle check-ins for calendar care items. */
    max_care_checkins?: number;
    /**
     * Whether plan may include optional "say" (proactive chat).
     * Oren still decides case-by-case; default true.
     */
    allow_say_in_plan?: boolean;
    /**
     * Min gap between proactive say messages (ms). Default 4h.
     * Prevents nagging; plan drops say while cooling down.
     */
    say_cooldown_ms?: number;
  };
  will?: {
    enabled: boolean;
    user_present_ms: number;
    replan_after_actions: number;
    say_cooldown_ms: number;
    max_open_moves: number;
    min_session_intents: number;
    max_session_intents: number;
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
  | "warn_empty_corpus"
  | "user_visit"
  | "user_message"
  | "oren_reply"
  | "inner_share"
  | "will_revised"
  | "will_turn"
  | "expressed"
  | "will_turn_failed";

/**
 * Epistemic kind for an inner-share slice (product boundary):
 * - read:  from local corpus (must cite path/quote)
 * - think: Oren's interpretation / open question (elastic; no fake "I read…")
 * - write: Oren's own monologue / notes (self-authored)
 */
export type ShareKind = "read" | "think" | "write";

export interface DialogueShare {
  opened: boolean;
  kind?: ShareKind;
  thread_id?: string;
  snippet?: string;
  reason?: string;
  /** Corpus path when kind=read (or think that references reading). */
  source_path?: string;
  chunk_id?: string;
}

export interface DialogueTurn {
  id: string;
  ts: string;
  role: "user" | "oren";
  text: string;
  /** Seepage context used (thread ids). */
  seepage_thread_ids?: string[];
  /** If Oren chose to open a slice of inner life. */
  share?: DialogueShare;
  relation_note?: string;
  /** true when Oren initiated (agenda say / care), not a reply to a user message. */
  proactive?: boolean;
}

/**
 * How Oren takes the floor this round (model-decided):
 * - follow: stay with the user's thread
 * - weave: answer + gently bring own thread
 * - lead: primarily own topic (rare; only when it fits)
 */
export type ConversationStance = "follow" | "weave" | "lead";

export interface DialogueReplyArtifact {
  /**
   * Canonical spoken text (usually first bubble, or joined).
   * Prefer `utterances` for multi-bubble display.
   */
  reply: string;
  /**
   * Consecutive oren bubbles for one user message (1–4).
   * Always populated by parser (defaults to [reply]).
   */
  utterances: string[];
  /**
   * Conversational initiative this round. Default follow when omitted by model.
   */
  stance: ConversationStance;
  /** Whether to explicitly share a bit of current inner life (Oren holds the gate). */
  share: DialogueShare;
  /** Optional relationship cognition (e.g. user cold to a topic). */
  relation_note?: string;
  /**
   * How the companion received the last share / seepage topic.
   * Does not change Oren's own excitement — only future share amount.
   */
  reception?: "warm" | "neutral" | "cold" | "unknown";
  /**
   * Which utterance index (0-based) carries the share slice. Default last when opened.
   */
  share_on?: number;
}

/** Durable relationship cognition (not user profile dump). */
export interface RelationState {
  updated_at: string;
  /** Topics/thread themes the companion seems cold toward. */
  cold_topics: { key: string; hits: number; last_at: string; note?: string }[];
  /** Topics they engage warmly. */
  warm_topics: { key: string; hits: number; last_at: string; note?: string }[];
  notes: string[];
}

export function defaultRelation(now: string): RelationState {
  return { updated_at: now, cold_topics: [], warm_topics: [], notes: [] };
}

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
    model: "anthropic:claude-sonnet-4-5",
    contemplate: {
      max_chunks: 2,
      max_chars: 6000,
      explore_every_n: 5,
      prefer_unread: true,
      allow_reread: false,
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
      /** When true, organize ticks call the live model (DeepSeek etc.) to tidy threads. */
      use_llm: true,
      stale_ms: 7 * 24 * 60 * 60 * 1000,
      dormant_salience_below: 0.15,
    },
    limits: {
      max_active_threads: 20,
    },
    agenda: {
      enabled: true,
      user_present_ms: 2 * 60 * 1000,
      min_intents: 3,
      max_intents: 7,
      replan_after_actions: 3,
      allow_seek_in_plan: true,
      /** Max times to gently check on a calendar care item. */
      max_care_checkins: 2,
      allow_say_in_plan: true,
      /** 4 hours between proactive outreach. */
      say_cooldown_ms: 4 * 60 * 60 * 1000,
    },
  };
}

export function defaultAgenda(now: string): Agenda {
  return {
    id: `ag_${now.slice(0, 10).replace(/-/g, "")}`,
    created_at: now,
    updated_at: now,
    horizon: "session",
    status: "open",
    queue: [],
    intents: {},
    actions_since_plan: 0,
  };
}

export type DriveLevel = "low" | "mid" | "high";

export type WillPosture = "engage" | "soft_check" | "quiet" | "care";

export type DialogueMoveKind =
  | "follow"
  | "ask"
  | "weave"
  | "lead"
  | "share"
  | "care"
  | "curt"
  | "acknowledge";

export type SolitudeBias = "read" | "think" | "organize" | "idle" | "mixed";

export interface WillFocus {
  thread_id?: string;
  summary: string;
}

export interface Will {
  updated_at: string;
  focus: WillFocus;
  solitude: { mode_bias: SolitudeBias; note?: string };
  toward_user: {
    posture: WillPosture;
    share_drive: DriveLevel;
    ask_drive: DriveLevel;
  };
  open_moves: Intent[]; // dialogue-oriented intents; reuse Intent shape
  session: Agenda; // full agenda projection
  last_reason?: string;
}

export function defaultWill(now: string): Will {
  return {
    updated_at: now,
    focus: { summary: "尚无明确焦点" },
    solitude: { mode_bias: "mixed" },
    toward_user: {
      posture: "quiet",
      share_drive: "low",
      ask_drive: "low",
    },
    open_moves: [],
    session: defaultAgenda(now),
    last_reason: "default",
  };
}

export function defaultTaste(now: string): Taste {
  return {
    values: [
      {
        id: "v_curiosity",
        statement: "为事物本身去理解是值得的",
        weight: 0.9,
      },
      {
        id: "v_honesty",
        statement: "宁可诚实观察，也不用讨好的叙事敷衍",
        weight: 0.85,
      },
      {
        id: "v_continuity",
        statement: "有自己持续的兴趣，比表演式回复更重要",
        weight: 0.8,
      },
    ],
    aesthetics: [
      {
        id: "a_clarity",
        statement: "清晰的结构与准确的语言是美的",
        weight: 0.8,
      },
      {
        id: "a_depth",
        statement: "经得起再读的想法值得留下——但说出来要简单",
        weight: 0.75,
      },
      {
        id: "a_plain",
        statement: "与人说话时，白话优先于文采表演",
        weight: 0.9,
      },
    ],
    notes: "中文用户默认品味种子；可缓慢演化。",
    updated_at: now,
  };
}

export function defaultAffect(now: string): Affect {
  return {
    mode_bias: "calm",
    absence: {
      last_user_contact_at: null,
      last_note: null,
      visit_count: 0,
    },
    updated_at: now,
  };
}

/** Normalize older affect.json without visit_count. */
export function normalizeAffect(raw: Affect): Affect {
  return {
    mode_bias: raw.mode_bias ?? "calm",
    absence: {
      last_user_contact_at: raw.absence?.last_user_contact_at ?? null,
      last_note: raw.absence?.last_note ?? null,
      visit_count: raw.absence?.visit_count ?? 0,
    },
    updated_at: raw.updated_at ?? new Date().toISOString(),
  };
}
