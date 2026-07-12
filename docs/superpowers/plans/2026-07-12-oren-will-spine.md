# Oren Will Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Will` the sole intent source so solitude planning and dialogue moves (ask / share / lead / curt) share one durable spine; agenda becomes session projection; dialogue becomes Will-turn → Express.

**Architecture:** Add `will.json` + `WillStore` (load/save/migrate from agenda). Tick continues plan/act but reads/writes Will.session (dual-write agenda during transition). Dialogue splits into `willTurn` (short JSON moves) then `express` (utterances under frozen moves). No tool runtime in this plan.

**Tech Stack:** TypeScript (ESM), Node 20+, Vitest, existing LifeStore / LlmCompleter / agenda / dialogue modules.

**Spec:** `docs/superpowers/specs/2026-07-12-oren-will-spine-design.md`

---

## File map

| Path | Responsibility |
|------|----------------|
| `src/types.ts` | `Will`, drive enums, dialogue move kinds, stream event types, `config.will` |
| `src/paths.ts` | `will` path on `LifePaths` |
| `src/will/store.ts` | load/save/default/synthesize/dual-write session↔agenda |
| `src/will/config.ts` | resolve will config from `config.will` or legacy `config.agenda` |
| `src/will/revise.ts` | wrap agenda plan → write Will (P2 rename surface) |
| `src/will/turn.ts` | dialogue Will-turn: prompt, parse, apply patch |
| `src/dialogue/express.ts` | generate utterances under frozen moves + enforce |
| `src/dialogue/reply.ts` | facade: visit → willTurn → express → persist |
| `src/dialogue/parse-will-turn.ts` | parse Will-turn JSON |
| `src/tick/engine.ts` | load Will, dual-write, stream `will_revised` |
| `src/llm/select.ts` | `OREN_WILL_LLM` routing |
| `src/llm/fake.ts` | fake will-turn / express responses |
| `src/doctor.ts` / `src/cli.ts` | status lines for Will |
| `src/dashboard/snapshot.ts` / `html.ts` | Will summary panel |
| `tests/will/*` | unit + contract tests |
| `tests/dialogue/*` | will-turn + express constraints |

**Reuse (do not reimplement):** `agenda/plan.ts`, `agenda/act.ts`, `agenda/deferred.ts`, `agenda/schedule.ts`, `dialogue/grounding.ts`, `dialogue/parse-reply.ts` (extend if needed), `relation/*`.

---

### Task 1: Will types + path + defaults

**Files:**
- Modify: `src/types.ts`
- Modify: `src/paths.ts`
- Create: `tests/will/types-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/will/types-defaults.test.ts
import { describe, expect, it } from "vitest";
import { defaultWill, type Will } from "../../src/types.js";

describe("defaultWill", () => {
  it("builds empty session and quiet toward_user", () => {
    const w = defaultWill("2026-07-12T00:00:00.000Z");
    expect(w.focus.summary).toBeTruthy();
    expect(w.toward_user.posture).toBe("quiet");
    expect(w.toward_user.share_drive).toBe("low");
    expect(w.session.queue).toEqual([]);
    expect(w.open_moves).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/will/types-defaults.test.ts`  
Expected: FAIL (cannot find `defaultWill` / module)

- [ ] **Step 3: Add types and defaults**

In `src/types.ts` add (near Agenda / after Intent types):

```ts
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
```

Extend `StreamEventType` union with:

```ts
| "will_revised"
| "will_turn"
| "expressed"
| "will_turn_failed"
```

Extend `Config` with optional:

```ts
will?: {
  enabled: boolean;
  user_present_ms: number;
  replan_after_actions: number;
  say_cooldown_ms: number;
  max_open_moves: number;
  min_session_intents: number;
  max_session_intents: number;
};
```

In `defaultConfig()`, either omit `will` (resolved at runtime from agenda) or mirror agenda values under `will`. Prefer **omit** and resolve in `will/config.ts`.

In `src/paths.ts`, add `will: string` to `LifePaths` and:

```ts
will: path.join(lifeDir, "will.json"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/will/types-defaults.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/paths.ts tests/will/types-defaults.test.ts
git commit -m "feat(will): add Will types, path, and defaults"
```

---

### Task 2: WillStore — load, save, synthesize from agenda

**Files:**
- Create: `src/will/store.ts`
- Create: `src/will/config.ts`
- Create: `tests/will/store.test.ts`
- Modify: `src/store/life-store.ts` (optional: init does not require will.json yet)

- [ ] **Step 1: Write the failing test**

```ts
// tests/will/store.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LifeStore } from "../../src/store/life-store.js";
import { saveAgenda } from "../../src/agenda/store.js";
import { loadWill, saveWill, synthesizeWillFromLife } from "../../src/will/store.js";
import { defaultAgenda, defaultWill } from "../../src/types.js";

describe("WillStore", () => {
  let home: string;
  let store: LifeStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-will-"));
    store = await LifeStore.init(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("synthesizes from agenda when will.json missing", async () => {
    const now = "2026-07-12T12:00:00.000Z";
    const ag = defaultAgenda(now);
    ag.planning_note = "读一点再想";
    ag.queue = ["i1"];
    ag.intents = {
      i1: {
        id: "i1",
        kind: "think",
        title: "想问题",
        status: "pending",
        priority: 1,
        created_at: now,
        source: "plan",
      },
    };
    await saveAgenda(store, ag);

    const will = await loadWill(store, now);
    expect(will.session.queue).toEqual(["i1"]);
    expect(will.session.planning_note).toBe("读一点再想");
  });

  it("round-trips save/load", async () => {
    const now = "2026-07-12T12:00:00.000Z";
    const w = defaultWill(now);
    w.focus.summary = "在啃 alpha";
    await saveWill(store, w);
    const loaded = await loadWill(store, now);
    expect(loaded.focus.summary).toBe("在啃 alpha");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/will/store.test.ts`  
Expected: FAIL missing module

- [ ] **Step 3: Implement store + config**

```ts
// src/will/config.ts
import type { Config } from "../types.js";

export function willConfig(config: Config) {
  if (config.will) return config.will;
  const ag = config.agenda;
  return {
    enabled: ag?.enabled ?? true,
    user_present_ms: ag?.user_present_ms ?? 2 * 60 * 1000,
    replan_after_actions: ag?.replan_after_actions ?? 3,
    say_cooldown_ms: ag?.say_cooldown_ms ?? 4 * 60 * 60 * 1000,
    max_open_moves: 12,
    min_session_intents: ag?.min_intents ?? 3,
    max_session_intents: ag?.max_intents ?? 7,
  };
}
```

```ts
// src/will/store.ts
import fs from "node:fs/promises";
import { atomicWriteJson } from "../store/atomic-write.js";
import type { LifeStore } from "../store/life-store.js";
import { loadAgenda, saveAgenda } from "../agenda/store.js";
import {
  defaultWill,
  type Agenda,
  type LifeState,
  type Will,
} from "../types.js";

export async function loadWill(store: LifeStore, now: string): Promise<Will> {
  try {
    const raw = await fs.readFile(store.paths.will, "utf8");
    const data = JSON.parse(raw) as Will;
    return normalizeWill(data, now);
  } catch {
    const agenda = await loadAgenda(store, now);
    const state = await store.load().catch(() => null);
    return synthesizeWillFromLife({ agenda, state, now });
  }
}

export async function saveWill(store: LifeStore, will: Will): Promise<void> {
  await atomicWriteJson(store.paths.will, will);
}

/** Dual-write session projection for transition period. */
export async function saveWillAndAgenda(
  store: LifeStore,
  will: Will,
): Promise<void> {
  await saveWill(store, will);
  await saveAgenda(store, will.session);
}

export function synthesizeWillFromLife(input: {
  agenda: Agenda;
  state: LifeState | null;
  now: string;
}): Will {
  const base = defaultWill(input.now);
  const active = input.state
    ? Object.values(input.state.threads)
        .filter((t) => t.status === "active")
        .sort((a, b) => b.salience - a.salience)
    : [];
  const top = active[0];
  return {
    ...base,
    updated_at: input.now,
    focus: top
      ? { thread_id: top.id, summary: top.title || top.summary.slice(0, 80) }
      : base.focus,
    session: input.agenda,
    last_reason: "synthesized_from_agenda",
  };
}

export function normalizeWill(raw: Will, now: string): Will {
  const d = defaultWill(now);
  return {
    updated_at: raw.updated_at ?? now,
    focus: {
      thread_id: raw.focus?.thread_id,
      summary: raw.focus?.summary?.trim() || d.focus.summary,
    },
    solitude: {
      mode_bias: raw.solitude?.mode_bias ?? "mixed",
      note: raw.solitude?.note,
    },
    toward_user: {
      posture: raw.toward_user?.posture ?? "quiet",
      share_drive: raw.toward_user?.share_drive ?? "low",
      ask_drive: raw.toward_user?.ask_drive ?? "low",
    },
    open_moves: Array.isArray(raw.open_moves) ? raw.open_moves : [],
    session: raw.session ?? d.session,
    last_reason: raw.last_reason,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/will/store.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/will/store.ts src/will/config.ts tests/will/store.test.ts
git commit -m "feat(will): WillStore load/save/synthesize and dual-write helper"
```

---

### Task 3: Tick engine wires Will (P0)

**Files:**
- Modify: `src/tick/engine.ts`
- Create: `tests/will/tick-will.test.ts` (or extend existing tick tests)

- [ ] **Step 1: Write failing integration-style test**

Use temp `LifeStore.init`, fake LLM, force plan then assert `will.json` exists after tick:

```ts
// tests/will/tick-will.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LifeStore } from "../../src/store/life-store.js";
import { runTick } from "../../src/tick/engine.js";
import { FakeLlm } from "../../src/llm/fake.js";

describe("tick + will", () => {
  it("persists will.json after plan tick", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-tick-will-"));
    const store = await LifeStore.init(home);
    // seed minimal corpus so plan/read can succeed if needed
    await fs.writeFile(
      path.join(home, "data/corpus/a.md"),
      "# A\nhello\n",
      "utf8",
    );
    const llm = new FakeLlm(); // ensure FakeLlm returns valid plan JSON when used
    const result = await runTick({
      home,
      forceMode: "plan",
      llm,
    });
    expect(result.exitCode).toBe(0);
    const willRaw = await fs.readFile(store.paths.will, "utf8");
    const will = JSON.parse(willRaw);
    expect(will.session).toBeTruthy();
    expect(Array.isArray(will.session.queue)).toBe(true);
    await fs.rm(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (will.json not written)

- [ ] **Step 3: Wire engine**

In `src/tick/engine.ts`:

1. Import `loadWill`, `saveWillAndAgenda` from `../will/store.js`.
2. After lock + `store.load()`, replace bare `loadAgenda` primary path with:

```ts
let will = await loadWill(store, nowIso);
let agenda = will.session;
```

3. Wherever agenda is saved today, also:

```ts
will = { ...will, session: agenda, updated_at: nowIso };
await saveWillAndAgenda(store, will);
```

4. On successful plan branch, push stream event:

```ts
{
  ts: nowIso,
  tick_id: tickId,
  type: "will_revised",
  payload: {
    reason,
    focus: will.focus,
    queue_len: will.session.queue.length,
  },
}
```

5. Keep `loadAgenda`/`saveAgenda` only inside dual-write helper to avoid drift.

Ensure `forceMode: "plan"` still works (map to agenda plan path).

- [ ] **Step 4: Fix FakeLlm if plan JSON missing**

If tests fail because FakeLlm does not return plan-shaped JSON, extend `src/llm/fake.ts` to detect plan system/user prompts (e.g. includes `planning_note` or `意图 kind`) and return:

```json
{
  "planning_note": "先想再idle",
  "intents": [
    { "kind": "think", "title": "想想当前线索" },
    { "kind": "idle", "title": "发呆一下" },
    { "kind": "organize", "title": "轻量整理" }
  ]
}
```

- [ ] **Step 5: Run full will + tick tests**

Run: `npx vitest run tests/will tests/tick`  
Expected: PASS (or only pre-existing skips)

- [ ] **Step 6: Commit**

```bash
git add src/tick/engine.ts src/llm/fake.ts tests/will/tick-will.test.ts
git commit -m "feat(will): tick loads and dual-writes Will session"
```

---

### Task 4: Parse Will-turn + apply patch (unit)

**Files:**
- Create: `src/will/parse-turn.ts`
- Create: `src/will/apply-turn.ts`
- Create: `tests/will/turn-parse.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// tests/will/turn-parse.test.ts
import { describe, expect, it } from "vitest";
import { parseWillTurn } from "../../src/will/parse-turn.js";
import { applyWillTurnPatch } from "../../src/will/apply-turn.js";
import { defaultWill } from "../../src/types.js";

describe("parseWillTurn", () => {
  it("parses moves and patch", () => {
    const t = parseWillTurn(
      JSON.stringify({
        turn_moves: ["follow", "acknowledge"],
        share_allowed: false,
        toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
        reason: "user curt",
      }),
    );
    expect(t.turn_moves).toEqual(["follow", "acknowledge"]);
    expect(t.share_allowed).toBe(false);
  });

  it("rejects empty moves by filling follow+acknowledge", () => {
    const t = parseWillTurn(JSON.stringify({ turn_moves: [] }));
    expect(t.turn_moves.length).toBeGreaterThan(0);
  });
});

describe("applyWillTurnPatch", () => {
  it("updates toward_user", () => {
    const w = defaultWill("t");
    const next = applyWillTurnPatch(w, {
      turn_moves: ["curt"],
      share_allowed: false,
      toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
      reason: "cold",
    }, "t");
    expect(next.toward_user.posture).toBe("quiet");
    expect(next.last_reason).toContain("cold");
  });
});
```

- [ ] **Step 2: Implement parse + apply**

```ts
// src/will/parse-turn.ts
import type { DialogueMoveKind, DriveLevel, WillPosture } from "../types.js";

const MOVES = new Set<DialogueMoveKind>([
  "follow", "ask", "weave", "lead", "share", "care", "curt", "acknowledge",
]);

export interface WillTurnResult {
  turn_moves: DialogueMoveKind[];
  share_allowed: boolean;
  toward_user?: {
    posture?: WillPosture;
    share_drive?: DriveLevel;
    ask_drive?: DriveLevel;
  };
  reason?: string;
  /** optional open_moves titles to enqueue — keep minimal in v1 */
  promote_open?: { kind: DialogueMoveKind; title: string }[];
}

export function parseWillTurn(raw: string): WillTurnResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("will-turn: no JSON");
  const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  let moves = Array.isArray(obj.turn_moves)
    ? (obj.turn_moves as string[]).filter((m): m is DialogueMoveKind =>
        MOVES.has(m as DialogueMoveKind),
      )
    : [];
  if (moves.length === 0) moves = ["follow", "acknowledge"];
  // hard caps
  if (moves.includes("curt")) {
    moves = moves.filter((m) => m === "curt" || m === "acknowledge" || m === "follow");
  }
  return {
    turn_moves: moves.slice(0, 4),
    share_allowed: Boolean(obj.share_allowed),
    toward_user: obj.toward_user as WillTurnResult["toward_user"],
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}
```

```ts
// src/will/apply-turn.ts
import type { Will } from "../types.js";
import type { WillTurnResult } from "./parse-turn.js";

export function applyWillTurnPatch(
  will: Will,
  turn: WillTurnResult,
  now: string,
): Will {
  return {
    ...will,
    updated_at: now,
    toward_user: {
      posture: turn.toward_user?.posture ?? will.toward_user.posture,
      share_drive: turn.toward_user?.share_drive ?? will.toward_user.share_drive,
      ask_drive: turn.toward_user?.ask_drive ?? will.toward_user.ask_drive,
    },
    last_reason: turn.reason ?? will.last_reason,
  };
}

export function safeFallbackTurn(userText: string): WillTurnResult {
  const t = userText.trim();
  const curt = t.length <= 2 || /^(嗯|哦|哦。|行|随便)$/.test(t);
  if (curt) {
    return {
      turn_moves: ["curt", "acknowledge"],
      share_allowed: false,
      toward_user: { posture: "quiet", share_drive: "low", ask_drive: "low" },
      reason: "fallback_curt",
    };
  }
  return {
    turn_moves: ["follow", "acknowledge"],
    share_allowed: false,
    reason: "fallback_follow",
  };
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
git add src/will/parse-turn.ts src/will/apply-turn.ts tests/will/turn-parse.test.ts
git commit -m "feat(will): parse and apply dialogue Will-turn"
```

---

### Task 5: Express constraints (no policy brain)

**Files:**
- Create: `src/dialogue/express-constraints.ts`
- Create: `tests/dialogue/express-constraints.test.ts`
- Modify: `src/dialogue/parse-reply.ts` if needed to accept stance derived from moves

- [ ] **Step 1: Failing test**

```ts
// tests/dialogue/express-constraints.test.ts
import { describe, expect, it } from "vitest";
import { enforceExpressConstraints } from "../../src/dialogue/express-constraints.js";
import type { DialogueReplyArtifact } from "../../src/types.js";

function base(over: Partial<DialogueReplyArtifact> = {}): DialogueReplyArtifact {
  return {
    reply: "hello",
    utterances: ["hello"],
    stance: "lead",
    share: { opened: true, kind: "think", snippet: "x" },
    ...over,
  };
}

describe("enforceExpressConstraints", () => {
  it("blocks share when not allowed", () => {
    const a = enforceExpressConstraints(base(), {
      turn_moves: ["follow"],
      share_allowed: false,
    });
    expect(a.share.opened).toBe(false);
  });

  it("downgrades lead when move missing", () => {
    const a = enforceExpressConstraints(base({ stance: "lead" }), {
      turn_moves: ["follow", "acknowledge"],
      share_allowed: false,
    });
    expect(a.stance).toBe("follow");
  });

  it("curtails bubbles when curt", () => {
    const a = enforceExpressConstraints(
      base({ utterances: ["a", "b", "c"], reply: "a" }),
      { turn_moves: ["curt"], share_allowed: false },
    );
    expect(a.utterances.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/dialogue/express-constraints.ts
import type { ConversationStance, DialogueMoveKind, DialogueReplyArtifact } from "../types.js";

export function enforceExpressConstraints(
  artifact: DialogueReplyArtifact,
  opts: { turn_moves: DialogueMoveKind[]; share_allowed: boolean },
): DialogueReplyArtifact {
  const moves = new Set(opts.turn_moves);
  let stance: ConversationStance = artifact.stance;
  if (moves.has("lead")) stance = "lead";
  else if (moves.has("weave")) stance = "weave";
  else stance = "follow";

  let utterances = [...artifact.utterances];
  let share = { ...artifact.share };

  if (!opts.share_allowed || !moves.has("share")) {
    share = { opened: false, reason: share.reason ?? "will_blocked_share" };
  }

  if (moves.has("curt")) {
    utterances = utterances.slice(0, 1);
    stance = "follow";
    share = { opened: false, reason: "curt" };
  }

  if (!moves.has("lead") && stance === "lead") stance = "follow";

  const reply = utterances[0] ?? artifact.reply;
  return { ...artifact, stance, utterances, reply, share };
}

export function stanceFromMoves(moves: DialogueMoveKind[]): ConversationStance {
  if (moves.includes("lead")) return "lead";
  if (moves.includes("weave")) return "weave";
  return "follow";
}
```

- [ ] **Step 3: Pass + commit**

```bash
git add src/dialogue/express-constraints.ts tests/dialogue/express-constraints.test.ts
git commit -m "feat(dialogue): enforce Express constraints from Will moves"
```

---

### Task 6: Will-turn LLM module + FakeLlm

**Files:**
- Create: `src/will/turn.ts`
- Modify: `src/llm/fake.ts`
- Modify: `src/llm/select.ts`
- Create: `tests/will/turn-llm.test.ts`

- [ ] **Step 1: Implement `runWillTurn`**

```ts
// src/will/turn.ts
import type { LlmCompleter } from "../llm/types.js";
import type { LifeState, RelationState, Thread, Will } from "../types.js";
import { applyWillTurnPatch, safeFallbackTurn } from "./apply-turn.js";
import { parseWillTurn, type WillTurnResult } from "./parse-turn.js";

const SYSTEM = `你是 Oren 的意志层，只决定本回合意图，不写对用户台词。
只返回 JSON：
{
  "turn_moves": ["follow"|"ask"|"weave"|"lead"|"share"|"care"|"curt"|"acknowledge"],
  "share_allowed": boolean,
  "toward_user": { "posture": "engage"|"soft_check"|"quiet"|"care", "share_drive": "low"|"mid"|"high", "ask_drive": "low"|"mid"|"high" },
  "reason": string
}
规则：用户敷衍 → curt；无充分理由勿 lead/share；share_allowed 仅当 moves 含 share 且关系不冷。
中文 reason。`;

export async function runWillTurn(input: {
  llm: LlmCompleter;
  will: Will;
  state: LifeState;
  userText: string;
  seepage: Thread[];
  relation: RelationState;
  now: string;
}): Promise<{ turn: WillTurnResult; will: Will; raw: string; failed: boolean }> {
  const user = [
    `当前焦点：${input.will.focus.summary}`,
    `对用户：${JSON.stringify(input.will.toward_user)}`,
    `渗入线索：${input.seepage.map((t) => t.title).join("；") || "无"}`,
    `冷话题：${input.relation.cold_topics.map((c) => c.key).slice(0, 5).join(",") || "无"}`,
    `用户说：${input.userText}`,
  ].join("\n");

  try {
    let raw = await input.llm.complete({ system: SYSTEM, user });
    let turn = parseWillTurn(raw);
    // consistency: share_allowed requires share move
    if (turn.share_allowed && !turn.turn_moves.includes("share")) {
      turn = { ...turn, share_allowed: false };
    }
    if (turn.turn_moves.includes("share") && !turn.share_allowed) {
      turn = { ...turn, turn_moves: turn.turn_moves.filter((m) => m !== "share") };
    }
    const will = applyWillTurnPatch(input.will, turn, input.now);
    return { turn, will, raw, failed: false };
  } catch {
    const turn = safeFallbackTurn(input.userText);
    const will = applyWillTurnPatch(input.will, turn, input.now);
    return { turn, will, raw: "", failed: true };
  }
}
```

Export `safeFallbackTurn` from `apply-turn.ts` (already defined there). Fix imports in `parse-turn` tests.

- [ ] **Step 2: FakeLlm branch** for will-turn (detect system containing `意志层` or `turn_moves`) return curt for short 嗯.

- [ ] **Step 3: selectLlm** — add purpose `"will"` reading `OREN_WILL_LLM` (default same as tick or say; prefer `fake` in tests).

```ts
// in select.ts pattern
// purpose: "tick" | "say" | "will" | "plan" | ...
// env OREN_WILL_LLM
```

- [ ] **Step 4: Unit test runWillTurn with FakeLlm + commit**

```bash
git commit -m "feat(will): runWillTurn LLM path and routing"
```

---

### Task 7: Dialogue facade — Will-turn then Express (P1)

**Files:**
- Create: `src/dialogue/express.ts` (extract express prompt from reply or thin wrapper)
- Modify: `src/dialogue/reply.ts`
- Modify: `tests/dialogue/reply.test.ts`
- Create: `tests/dialogue/will-dialogue.test.ts`

- [ ] **Step 1: Failing behavior test**

```ts
// tests/dialogue/will-dialogue.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LifeStore } from "../../src/store/life-store.js";
import { sayToOren } from "../../src/dialogue/reply.js";
import { FakeLlm } from "../../src/llm/fake.js";
import { loadWill } from "../../src/will/store.js";

describe("sayToOren will spine", () => {
  it("does not open share when will-turn disallows", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-say-will-"));
    const store = await LifeStore.init(home);
    const llm = new FakeLlm(); // configure: will-turn share_allowed false; express tries share
    const result = await sayToOren({ store, text: "嗯", llm });
    expect(result.artifact.share.opened).toBe(false);
    const will = await loadWill(store, new Date().toISOString());
    expect(will.toward_user).toBeTruthy();
    // stream should contain will_turn — read store stream tail
    await fs.rm(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Refactor `sayToOren`**

Order:

1. load state, relation, visit  
2. `loadWill`  
3. seepage, history, candidates (candidates **hint only** for will-turn + express)  
4. `selectLlm({ purpose: "will" })` or use injected llm for both in tests  
5. `runWillTurn` → `saveWillAndAgenda`  
6. append stream `will_turn` or `will_turn_failed`  
7. Express: existing SYSTEM prompt **plus** injected block:

```ts
`本回合冻结意图 turn_moves=${JSON.stringify(turn.turn_moves)} share_allowed=${turn.share_allowed}
必须遵守：无 share 不得 share.opened；无 lead 不得强行换题；curt 则 1 条气泡。`
```

8. parse reply → `enforceExpressConstraints` → grounding → normalize share  
9. append dialogue  
10. care deferred (update `will.session` not only agenda) via `saveWillAndAgenda`  
11. absorb relation; optionally nudge drives on cold  
12. stream `expressed`  
13. final `saveWillAndAgenda`

Keep `SayResult` shape; add optional `willTurn: WillTurnResult` for tests.

- [ ] **Step 3: Update FakeLlm** so two-step dialogue works: first complete → will-turn JSON; second → express JSON without share if curt.

- [ ] **Step 4: Run dialogue + will tests**

Run: `npx vitest run tests/dialogue tests/will`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(dialogue): Will-turn then Express with frozen moves"
```

---

### Task 8: WillRevise surface + plan stream (P2)

**Files:**
- Create: `src/will/revise.ts` (thin wrapper around `buildAgendaPlan` + session assign)
- Modify: `src/tick/engine.ts` to call `reviseWill` instead of raw `buildAgendaPlan`
- Modify: `tests/agenda/plan.test.ts` still pass via re-export or unchanged plan.ts

- [ ] **Step 1: Wrapper**

```ts
// src/will/revise.ts
import { buildAgendaPlan } from "../agenda/plan.js";
import type { Will } from "../types.js";
// ... same inputs as buildAgendaPlan plus current Will

export async function reviseWill(input: /* ... */): Promise<{ will: Will; raw: string }> {
  const { agenda, raw } = await buildAgendaPlan({ ...input, previous: input.will.session });
  const will: Will = {
    ...input.will,
    updated_at: input.now,
    session: agenda,
    last_reason: agenda.planning_note ?? "revised",
    solitude: {
      ...input.will.solitude,
      note: agenda.planning_note,
    },
  };
  // optional: if plan includes say, set toward_user.posture soft_check / share_drive mid
  return { will, raw };
}
```

- [ ] **Step 2: Engine uses reviseWill; emit `will_revised`**

- [ ] **Step 3: Test plan still works + commit**

```bash
git commit -m "feat(will): WillRevise wraps session planning"
```

---

### Task 9: Doctor, CLI status, dashboard snapshot (P2)

**Files:**
- Modify: `src/doctor.ts`
- Modify: `src/cli.ts` (`status`)
- Modify: `src/dashboard/snapshot.ts`
- Modify: `src/dashboard/html.ts` (small Will section)
- Create: `tests/will/doctor-status.test.ts` or extend doctor test

- [ ] **Step 1: status output includes**

```
will_focus: …
will_posture: quiet share=low ask=low
will_queue: 3 open_moves: 0
```

- [ ] **Step 2: doctor warns if will missing but agenda present (soft)** — after load synthesis this should auto-heal on next tick; doctor can say `will=synthesized_ok` if file missing until written.

- [ ] **Step 3: snapshot.will = { focus, toward_user, queue_titles }**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(will): surface Will in doctor, status, dashboard"
```

---

### Task 10: Regression suite + README (P3 partial)

**Files:**
- Modify: `README.md` — document Will spine, env `OREN_WILL_LLM`, dialogue two-step
- Run: full `npm test`
- Optional: stop writing agenda-only paths in new code (dual-write remains until Task 11)

- [ ] **Step 1: Full test**

Run: `npm test`  
Expected: all pass (1 live skip ok)

- [ ] **Step 2: README section**

```markdown
## Will spine
Oren's intent lives in `will.json`. Solitude session queue is a projection.
Dialogue: will-turn (moves) → express (utterances). Env: `OREN_WILL_LLM`.
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: document Will spine and verify full test suite"
```

---

### Task 11 (optional cleanup): Prefer will.json as primary (P3)

**Files:**
- Modify: `src/will/store.ts` — keep dual-write but document  
- Modify: care paths in reply to only touch `will.session`  
- Do **not** delete `agenda.json` support in this plan unless all tests green with dual-write only  

- [ ] **Step 1: Grep for `saveAgenda` / `loadAgenda` outside will/store and agenda/*`**

- [ ] **Step 2: Route remaining call sites through will session**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(will): route remaining agenda IO through Will session"
```

---

## Self-review vs spec

| Spec requirement | Task |
|------------------|------|
| Will types + 落盘 | 1–2 |
| 迁移合成 from agenda | 2 |
| Dual-write session↔agenda | 2–3 |
| Tick 读/写 Will + will_revised | 3, 8 |
| Will-turn + fallback | 4, 6 |
| Express 硬约束 | 5, 7 |
| Dialogue 先 Will 后嘴 | 7 |
| share/lead/curt 行为 | 5, 7 |
| deferred preserve | inherits agenda; care via will.session in 7 |
| OREN_WILL_LLM | 6 |
| doctor/status/dashboard | 9 |
| tool 不实现 | no task (hang point only in types comment optional) |
| README | 10 |

**Out of plan (explicit):** tool runtime, wound/heal, remove agenda file entirely, taste nudge enable.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-oren-will-spine.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with executing-plans and checkpoints  

Which approach?
