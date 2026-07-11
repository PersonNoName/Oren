# Oren Runtime v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a no-UI TypeScript runtime (`oren init` / `oren tick` / `oren status`) that runs a durable experience-loop tick against a local corpus, persists self-memory threads and append-only stream under `data/life`, and optionally contemplates via `@earendil-works/pi-ai`.

**Architecture:** Stage pipeline per tick (Load → Perceive → ChooseMode → Act → Integrate → Persist). Deterministic stages own state; LLM only in contemplate (single completion, no tools). Life state is JSON/JSONL on disk; Pi monorepo is not modified—only npm dependency on `pi-ai`.

**Tech Stack:** TypeScript (ESM), Node 20+, Vitest, Commander (or bare argv), `@earendil-works/pi-ai`, file-based lock + atomic writes.

**Spec:** `docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`  
**After approval:** also save this plan to `docs/superpowers/plans/2026-07-12-oren-runtime-v1.md`.

---

## Context

Oren is an independent-presence agent (essence: continuous inner life; companionship is overflow). V1 proves **mechanism D**: unsupervised ticks grow auditable self-memory from a local corpus—no chat UI, no outreach, no wound dynamics. Greenfield repo currently holds only design/discussion docs.

## Recommended approach

Single package monorepo-style app (not multi-package yet) under `src/` with clear modules matching the spec’s logical units. TDD: fake `LlmCompleter` for CI; live LLM behind `OREN_LIVE_LLM=1`.

## Critical files to create

| Path | Responsibility |
|------|----------------|
| `package.json` | name `oren`, bin `oren`, deps, scripts |
| `tsconfig.json` | strict ESM |
| `vitest.config.ts` | tests |
| `src/types.ts` | shared domain types + exit codes |
| `src/paths.ts` | resolve `OREN_HOME` → corpus/life paths |
| `src/store/life-store.ts` | load/save state, lock, stream, ticks |
| `src/store/atomic-write.ts` | tmp + rename |
| `src/corpus/index.ts` | scan + chunk + hash index |
| `src/corpus/retrieve.ts` | ReadingPlan scoring |
| `src/tick/perceive.ts` | Perception snapshot |
| `src/tick/choose-mode.ts` | mode heuristics |
| `src/tick/integrate.ts` | TickPatch → next state |
| `src/tick/organize.ts` | rule organize |
| `src/tick/contemplate.ts` | prompt + parse artifact → patch |
| `src/tick/engine.ts` | full pipeline |
| `src/llm/types.ts` | `LlmCompleter` |
| `src/llm/fake.ts` | test completer |
| `src/llm/pi-ai.ts` | pi-ai adapter |
| `src/cli.ts` | init / tick / status |
| `src/index.ts` | public exports if needed |
| `tests/**` | unit + contract fixtures |
| `fixtures/corpus/*` | sample md for tests |
| `README.md` | init, tick, cron, env keys |

**Do not modify:** `/Users/robot/Documents/Projects/pi/**`

**Reuse (external):** `@earendil-works/pi-ai` — `getModel`, streaming/completion APIs from package docs at install time; wrap behind `LlmCompleter` only.

---

## Task 1: Scaffold project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/types.ts`, `src/paths.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "oren",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "oren": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "oren": "node --import tsx src/cli.ts"
  },
  "engines": { "node": ">=20" }
}
```

DevDeps: `typescript`, `vitest`, `tsx`, `@types/node`.  
Runtime deps (later task for pi-ai): none yet.

- [ ] **Step 2: tsconfig strict ESM** (`module`/`moduleResolution` NodeNext, `outDir` dist, `rootDir` src, strict true)

- [ ] **Step 3: Define core types in `src/types.ts`**

Include at minimum:

```ts
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

export interface TasteItem { id: string; statement: string; weight: number }
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
  contemplate: { max_chunks: number; max_chars: number; explore_every_n: number };
  mode: { idle_probability: number; max_consecutive_contemplate: number };
  taste: { apply_nudges: boolean; max_nudges_per_tick: number };
  organize: { use_llm: boolean };
  limits: { max_active_threads: number };
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
  taste_nudges?: { dimension: "value" | "aesthetic"; statement: string; reason: string }[];
  felt_intensity?: number;
}

export type ThreadOp =
  | { op: "create"; thread: Thread }
  | { op: "update"; id: string; fields: Partial<Thread> }
  | { op: "dormant"; id: string };

export interface TickPatch {
  mode: Mode;
  reason: string;
  thoughts?: { content: string; thread_id?: string; source_refs?: string[] }[];
  thread_ops?: ThreadOp[];
  taste_ops?: { op: "nudge"; dimension: "value" | "aesthetic"; statement: string; reason: string }[];
  stream_events: Omit<StreamEvent, "ts" | "tick_id">[];
}

export interface LifeState {
  meta: Meta;
  config: Config;
  taste: Taste;
  affect: Affect;
  threads: Map<string, Thread> | Record<string, Thread>;
}
```

- [ ] **Step 4: `src/paths.ts`** — `resolveHome(env)`, `lifePaths(home)`, `corpusDir(home, config)`

- [ ] **Step 5: `.gitignore`** — `node_modules`, `dist`, `data/life`, `.DS_Store` (keep `data/corpus` samples if committed under fixtures only)

- [ ] **Step 6: Commit** `chore: scaffold oren typescript project`

---

## Task 2: Atomic write + LifeStore + lock

**Files:**
- Create: `src/store/atomic-write.ts`, `src/store/life-store.ts`
- Test: `tests/store/life-store.test.ts`

- [ ] **Step 1: Failing test** — init empty temp dir, `LifeStore.init`, assert files exist (`meta.json`, `taste.json`, `affect.json`, `config.json`, `threads/`, `stream.jsonl`, `ticks/`, `index/`)

- [ ] **Step 2: Implement `atomicWriteJson(path, data)`** — write `path.tmp` then `rename`

- [ ] **Step 3: Implement `LifeStore`**
  - `init(home)`: seed default taste (2–3 values/aesthetics), default config per spec §6.2, empty stream, meta with uuid, schema_version=1
  - `load()`: read all; if missing or schema mismatch throw with code-path for exit 3
  - `acquireLock()` / `releaseLock()`: exclusive file lock on `data/life/.lock` (open `wx` or `proper-lockfile`; on conflict throw `LockError`)
  - `appendStream(events)`, `saveMeta`, `saveThread`, `saveTaste`, `saveAffect`, `saveCorpusIndex`, `writeTickSnapshot`
  - `persistSuccess({ meta, threads mutated, stream events, tick snapshot })` ordering: JSON files first, then stream `tick_finished`, then meta tick_count bump

- [ ] **Step 4: Lock conflict test** — hold lock in same process flag or second store; second acquire fails

- [ ] **Step 5: Commit** `feat: life store with lock and atomic writes`

---

## Task 3: Corpus index + retriever

**Files:**
- Create: `src/corpus/index.ts`, `src/corpus/retrieve.ts`
- Create: `fixtures/corpus/alpha.md`, `fixtures/corpus/beta.md`
- Test: `tests/corpus/index.test.ts`, `tests/corpus/retrieve.test.ts`

- [ ] **Step 1: Index test** — index fixture dir; expect 2 files, stable hashes; edit file content → hash changes; chunk large file by blank lines

- [ ] **Step 2: Implement `buildCorpusIndex(corpusDir)`** → `{ docs: [{ path, hash, mtime_ms, preview, chunks: [{ chunk_id, start_line, end_line, preview }] }] }`

- [ ] **Step 3: Retriever tests (table-driven)**
  - High-salience thread with source path → reason `continue-thread:<id>`
  - Taste keyword overlap on preview → `taste-match`
  - When `explore_every_n` and tick counter matches → `explore`
  - Respect `max_chunks` / `max_chars`

- [ ] **Step 4: Implement `planReading({ index, taste, threads, config, contemplateOrdinal })` → ReadingPlan**

```ts
export interface ReadingPlanItem {
  path: string;
  chunk_id: string;
  text: string;
  score: number;
  reason: string;
}
export interface ReadingPlan {
  items: ReadingPlanItem[];
  thread_id?: string;
}
```

- [ ] **Step 5: Commit** `feat: local corpus index and rule-based reading plan`

---

## Task 4: ChooseMode + Organize (rules only)

**Files:**
- Create: `src/tick/choose-mode.ts`, `src/tick/organize.ts`
- Test: `tests/tick/choose-mode.test.ts`, `tests/tick/organize.test.ts`

- [ ] **Step 1: ChooseMode tests**
  - force mode wins
  - consecutive contemplate ≥ max → not contemplate
  - empty corpus candidates + would contemplate → caller will degrade; chooser may still return contemplate (engine degrades) OR chooser returns idle if no readable material—**implement in engine per spec: degrade to idle + warn_empty_corpus**
  - idle_probability: inject `rng` for determinism

```ts
export function chooseMode(input: {
  force?: Mode;
  recentModes: Mode[];
  config: Config;
  hasReadableCorpus: boolean;
  rng: () => number; // [0,1)
}): { mode: Mode; reason: string }
```

- [ ] **Step 2: Organize tests** — active threads > max → dormant lowest salience; empty ops when healthy

- [ ] **Step 3: Implement**

- [ ] **Step 4: Commit** `feat: mode selection and rule organize`

---

## Task 5: Integrate + ThoughtArtifact parse

**Files:**
- Create: `src/tick/integrate.ts`, `src/tick/parse-artifact.ts`
- Test: `tests/tick/integrate.test.ts`, `tests/tick/parse-artifact.test.ts`

- [ ] **Step 1: parseArtifact** — valid JSON; strip markdown fences; reject empty monologue; reject if both refined_summary and open_questions missing/blank after contemplate path validation in integrate

- [ ] **Step 2: integrate(state, patch, now)** → new state + applied ops list  
  - apply create/update/dormant  
  - reject unknown thread id  
  - if `config.taste.apply_nudges` false, drop taste_ops  
  - soft: optional small salience decay on idle (document constant e.g. 0.01)

- [ ] **Step 3: Commit** `feat: tick patch integrate and artifact parse`

---

## Task 6: Contemplation service (fake LLM) + TickEngine idle/contemplate

**Files:**
- Create: `src/llm/types.ts`, `src/llm/fake.ts`, `src/tick/contemplate.ts`, `src/tick/perceive.ts`, `src/tick/engine.ts`
- Test: `tests/tick/engine.contract.test.ts`

- [ ] **Step 1: `LlmCompleter` interface**

```ts
export interface LlmCompleter {
  complete(input: { system: string; user: string }): Promise<string>;
}
```

- [ ] **Step 2: Fake completer returns fixed ThoughtArtifact JSON**

- [ ] **Step 3: Contract test in temp home**
  1. init store  
  2. copy fixtures to corpus  
  3. `runTick({ forceMode: "idle", llm: fake })` → stream has `presence_blank`, llm call count 0  
  4. `runTick({ forceMode: "contemplate", llm: fake })` → thought_written, thread created/updated, tick snapshot has `reading_plan.reason`, corpus file hash unchanged  
  5. second concurrent tick with held lock → LockError / exit mapping 2

```ts
export async function runTick(opts: {
  home: string;
  forceMode?: Mode;
  llm: LlmCompleter;
  now?: () => Date;
  rng?: () => number;
}): Promise<{ exitCode: ExitCode; tickId: string; mode: Mode }>
```

Pipeline inside `runTick`:
1. acquire lock  
2. load state (exit 3 if missing)  
3. tick_id = ulid/uuid  
4. perceive (gap_ms, reindex corpus, recent modes from last N stream or meta side file—**store recent_modes in meta or derive from last 10 stream mode_chosen events**)  
5. choose mode  
6. if contemplate && no reading plan items → idle + warn_empty_corpus  
7. act → TickPatch  
8. integrate  
9. persist (including ticks/*.json with reading_plan, parsed artifact, applied_patch)  
10. release lock  
11. return

- [ ] **Step 4: Commit** `feat: tick engine with idle and fake contemplate`

---

## Task 7: CLI init / tick / status

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli/cli.test.ts` (spawn `tsx src/cli.ts` with temp home via `OREN_HOME`)

- [ ] **Step 1: CLI**
  - `init` → LifeStore.init; write `data/corpus/README.md`  
  - `tick [--force-mode]` → runTick; map errors to exit codes; print one-line summary  
  - `status` → last_tick_at, tick_count, active thread count, last 5 stream types  

Default llm: Fake if `OREN_LLM=fake` or no API key; else pi-ai (task 8). For deterministic tests always `OREN_LLM=fake`.

- [ ] **Step 2: Exit codes** 0/1/2/3 as spec

- [ ] **Step 3: Commit** `feat: oren cli init tick status`

---

## Task 8: pi-ai LlmCompleter

**Files:**
- Create: `src/llm/pi-ai.ts`
- Modify: `package.json` add `@earendil-works/pi-ai`
- Test: `tests/llm/pi-ai.test.ts` skipped unless `OREN_LIVE_LLM=1`

- [ ] **Step 1: Implement PiAiCompleter**
  - Parse `config.model` as `provider:modelId` (e.g. `anthropic:claude-...`)  
  - Call package’s documented completion/stream API; concatenate text  
  - Prompt builder in contemplate already supplies system+user  

- [ ] **Step 2: Wire CLI** — if `OREN_LLM=fake` use Fake; else PiAiCompleter; on missing key exit 1 with clear message for contemplate only (idle still works)

- [ ] **Step 3: Optional live test** documents env vars (`ANTHROPIC_API_KEY` etc. as required by pi-ai)

- [ ] **Step 4: Commit** `feat: pi-ai contemplation adapter`

---

## Task 9: README + DoD checklist script

**Files:**
- Create: `README.md`
- Create: `scripts/dod-smoke.sh` (optional) runs init + fake ticks against temp dir

- [ ] **Step 1: README** — concept pointer to design docs; install; `OREN_HOME`; init; place corpus; tick; force-mode; status; cron example; fake vs live LLM; what v1 does not do

- [ ] **Step 2: Run full vitest + manual DoD D1–D8 with fake LLM**

- [ ] **Step 3: Commit** `docs: readme and v1 smoke verification`

- [ ] **Step 4: Update spec status line** to “已批准 / 实现中” only if user already approved (optional)

---

## Verification (end-to-end)

```bash
cd /Users/robot/Documents/Projects/Oren
npm install
npm test
export OREN_HOME=/tmp/oren-dod-$$
export OREN_LLM=fake
npx tsx src/cli.ts init
cp fixtures/corpus/*.md "$OREN_HOME/data/corpus/"
npx tsx src/cli.ts tick --force-mode idle      # D6
npx tsx src/cli.ts tick --force-mode contemplate  # D2–D5
npx tsx src/cli.ts status
# D7: two ticks with lock held
# D8: shasum corpus files before/after
```

Live (optional): `OREN_LLM=pi OREN_LIVE_LLM=1` + provider key + one contemplate.

## Spec coverage map

| Spec area | Task |
|-----------|------|
| Life dirs / schema | 1–2 |
| Corpus + ReadingPlan | 3 |
| Modes + organize | 4 |
| Integrate / artifact | 5 |
| Pipeline + fake contemplate | 6 |
| CLI | 7 |
| pi-ai boundary | 8 |
| DoD / docs | 9 |
| No Pi fork, no chat, no outreach | enforced by scope (no tasks) |

## Out of scope (do not implement)

User chat, outreach, wound/healing, vector DB, daemon mode, modifying Pi repo, multi-user, auto thread merge.

---

## Execution notes

- Prefer **subagent-driven-development** per task with review between tasks.  
- Commit after each task as listed.  
- If `pi-ai` API surface differs at install time, only adapt `src/llm/pi-ai.ts`—do not leak provider types into TickEngine.
