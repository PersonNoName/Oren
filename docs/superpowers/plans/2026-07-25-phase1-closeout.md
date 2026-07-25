# Phase 1 Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 1 life-kernel gates fully green by adding an `acceptingWork` shutdown gate to `EffectDispatcher`, wiring it through `LifeRuntime`, and verifying test / typecheck / build / demo.

**Architecture:** Reuse the existing `runtimeGate.closed` flag that already blocks cognition-side capability invokes. `EffectDispatcher.runOnce` checks an optional `acceptingWork` callback before each claimed outbox row and `break`s the batch when the runtime is no longer accepting work. Skipped rows keep their durable leases for later recovery; in-flight `processClaimedEffect` calls may finish and persist terminal state.

**Tech Stack:** TypeScript 5.9.3, Vitest 3.2.4, Node.js built-in `node:sqlite`, existing `@oren/app` modular monolith on branch `feat/oren-life-kernel`.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-25-phase1-closeout-design.md` exactly.
- Do not change outbox schema, claim SQL, or lease duration.
- Do not add real-model smoke, production prompts, memory, Web, or messaging.
- Do not force skipped claims into `failed` / `uncertain` on shutdown.
- Omit `acceptingWork` ⇒ dispatcher behaves exactly as today.
- When `acceptingWork` returns `false`, use `break` (not `continue`) so the rest of the claimed batch is skipped.
- Work only on `feat/oren-life-kernel`; do not modify `codex/oren-pi-kernel`.
- End each task with a focused commit.

## Locked File Structure

```text
packages/app/src/effect-dispatcher.ts   # acceptingWork option + runOnce gate
packages/app/src/life-runtime.ts        # wire acceptingWork to runtimeGate.closed
packages/app/test/effect-dispatcher.test.ts  # existing failing closeout test (already present)
docs/superpowers/plans/2026-07-23-oren-life-kernel.md  # Phase 1 Completion Checklist
```

No new packages or files are required.

---

### Task 1: Add `acceptingWork` Gate to EffectDispatcher

**Files:**
- Modify: `packages/app/src/effect-dispatcher.ts`
- Test: `packages/app/test/effect-dispatcher.test.ts` (existing test at the describe block for EffectDispatcher; do not rewrite unless the assertion diverges from the spec)

**Interfaces:**
- Consumes: existing `EffectDispatcher(repository, registry, workerId, options?)`, `EffectRepository.claimOutbox`, `processClaimedEffect`
- Produces: `EffectDispatcherOptions.acceptingWork?: () => boolean`; `runOnce()` skips remaining claimed rows when the callback returns `false`

- [ ] **Step 1: Confirm the existing closeout test fails for the right reason**

Run:

```bash
npx vitest run packages/app/test/effect-dispatcher.test.ts -t "does not begin another external dispatch after the runtime starts closing"
```

Expected: FAIL with `expected [ Array(2) ] to deeply equal [ 'effect-first' ]` (both `effect-first` and `effect-after-close` invoked), and/or a TypeScript error that `acceptingWork` is not in `EffectDispatcherOptions`.

- [ ] **Step 2: Extend options and store the callback**

In `packages/app/src/effect-dispatcher.ts`, change the options interface and constructor to:

```ts
export interface EffectDispatcherOptions {
  readonly now?: () => number;
  readonly claimLimit?: number;
  readonly acceptingWork?: () => boolean;
}

export class EffectDispatcher {
  private readonly now: () => number;
  private readonly claimLimit: number;
  private readonly acceptingWork: (() => boolean) | undefined;

  public constructor(
    private readonly repository: EffectRepository,
    private readonly registry: EffectRegistry,
    private readonly workerId: string,
    options: EffectDispatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.claimLimit = options.claimLimit ?? 8;
    this.acceptingWork = options.acceptingWork;
  }
```

- [ ] **Step 3: Gate each claimed row in `runOnce`**

Replace the `runOnce` loop body with:

```ts
public async runOnce(): Promise<EffectDispatchResult[]> {
  const claimed = this.repository.claimOutbox(
    this.workerId,
    this.claimLimit,
    new Date(this.now()).toISOString(),
  );
  const results: EffectDispatchResult[] = [];
  for (const row of claimed) {
    if (this.acceptingWork && !this.acceptingWork()) break;
    results.push(await this.processClaimedEffect(row));
  }
  return results;
}
```

Do not change `processClaimedEffect`, timeout, reconciliation, or persist helpers.

- [ ] **Step 4: Re-run the focused test and the full dispatcher suite**

Run:

```bash
npx vitest run packages/app/test/effect-dispatcher.test.ts
```

Expected: PASS for all tests in that file, including “does not begin another external dispatch after the runtime starts closing”.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/effect-dispatcher.ts
git commit -m "$(cat <<'EOF'
fix(app): stop effect dispatch once runtime stops accepting work

EOF
)"
```

---

### Task 2: Wire LifeRuntime Shutdown Gate into EffectDispatcher

**Files:**
- Modify: `packages/app/src/life-runtime.ts` (dispatcher construction inside `createDeterministic` / shared factory path that already creates `runtimeGate`)

**Interfaces:**
- Consumes: Task 1 `EffectDispatcherOptions.acceptingWork`; existing `runtimeGate = { closed: false }` and `close()` setting `runtimeGate.closed = true`
- Produces: LifeRuntime-owned dispatcher that refuses new outbox work after `close()` begins

- [ ] **Step 1: Pass `acceptingWork` when constructing the dispatcher**

Find the `new EffectDispatcher(...)` call in `packages/app/src/life-runtime.ts` (currently options are only `{ now: () => Date.parse(now()) }`) and change it to:

```ts
const dispatcher = new EffectDispatcher(
  repository,
  registry,
  `life-runtime:${nextId()}`,
  {
    now: () => Date.parse(now()),
    acceptingWork: () => !runtimeGate.closed,
  },
);
```

Keep the cognition-side `runtimeGate.closed` rejection path unchanged.

- [ ] **Step 2: Run LifeRuntime and EffectDispatcher tests**

Run:

```bash
npx vitest run packages/app/test/effect-dispatcher.test.ts packages/app/test/life-runtime.test.ts
```

Expected: PASS. Existing close / grace / restart tests must remain green.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/life-runtime.ts
git commit -m "$(cat <<'EOF'
fix(app): gate durable effect dispatch on LifeRuntime close

EOF
)"
```

---

### Task 3: Verify Phase 1 Gates and Mark the Checklist Complete

**Files:**
- Modify: `docs/superpowers/plans/2026-07-23-oren-life-kernel.md` (only the `## Phase 1 Completion Checklist` section at the end)
- Verify via commands (no source changes expected)

**Interfaces:**
- Consumes: Tasks 1–2 behavior; existing demo at `packages/app/src/demo.ts`
- Produces: green Phase 1 quality gates; checklist items marked `[x]`

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
npm test
```

Expected: all test files pass; 0 failures.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0, no diagnostics.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: `tsc` and `scripts/prepare-dist.mjs` succeed; `dist/packages/app/src/demo.js` exists.

- [ ] **Step 4: Run the deterministic restart demo**

Run:

```bash
node --enable-source-maps dist/packages/app/src/demo.js
```

Expected stdout includes: `Oren demo completed; restart replay matched`

- [ ] **Step 5: Mark the Phase 1 Completion Checklist**

In `docs/superpowers/plans/2026-07-23-oren-life-kernel.md`, under `## Phase 1 Completion Checklist`, change every `- [ ]` in that section only to `- [x]`. Do not rewrite historical Task 1–10 step checkboxes earlier in the file.

- [ ] **Step 6: Commit verification docs**

```bash
git add docs/superpowers/plans/2026-07-23-oren-life-kernel.md
git commit -m "$(cat <<'EOF'
docs: mark Phase 1 life-kernel completion checklist done

EOF
)"
```

---

## Spec Coverage Self-Check

| Spec requirement | Task |
|---|---|
| `acceptingWork?: () => boolean` on options | Task 1 |
| Default omit ⇒ unchanged behavior | Task 1 (no default callback) |
| Check before each claimed row; `break` on false | Task 1 |
| Skip without invoke/query/finishEffect | Task 1 |
| In-flight process may finish | Task 1 (gate only in loop) |
| Wire `() => !runtimeGate.closed` | Task 2 |
| No schema / fake terminal / new product scope | Global Constraints |
| `npm test` / typecheck / build / demo | Task 3 |
| Checklist marked complete | Task 3 |
