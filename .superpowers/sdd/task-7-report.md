# Task 7 Report: Pi Cognition Adapter

## Scope and commits

- Base SHA: `039b758c31de1060017acdc3ac9b583bf3c5801f`
- Focused implementation SHA: `7c2cc7b73da7dac9bbc965bd1aa405df64d51344`
- Package added: `packages/pi-cognition`
- No design, README, or other package internals were modified.

## Exact dependency versions

`npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai typebox --all`
reported:

- `@earendil-works/pi-agent-core@0.75.5`
- `@earendil-works/pi-ai@0.75.5`
- `typebox@1.1.38`

All three direct dependency specifications are exact versions. The Pi packages
deduplicate to the same `pi-ai` and `typebox` versions. `pi-coding-agent` is not
present in the manifests, lockfile, packages, or extensions.

## TDD evidence

### Initial RED

The package manifest, fake Pi stream, and focused adapter/tool tests were
created before production implementation. After installing the exact
dependencies, the first runnable focused command was:

`npm test -- packages/pi-cognition/test/pi-cognition-adapter.test.ts packages/pi-cognition/test/tool-adapter.test.ts`

It failed with two failed suites because both tests imported the absent
`../src/index.js`:

`Error: Cannot find module '../src/index.js'`

This was the expected feature-missing RED.

The environment had `NODE_ENV=production`, so the first plain `npm install`
omitted the root development test runner and produced `vitest: command not
found`. `npm install --include=dev` restored the root toolchain; no production
code was written before the expected missing-module RED was observed.

### Additional RED/GREEN cycles

- A zero-step budget test first failed with `expected 1 to be +0`; an early
  bounded failure was then added. The focused rerun passed.
- An unknown proposal-field test first failed with `expected 'completed' to be
  'failed'`; `additionalProperties: false` was then added to the commit and
  proposal schemas. The focused rerun passed.

### Final focused GREEN

`npm test -- packages/pi-cognition/test`

- Test files: 2 passed
- Tests: 14 passed
- Covers typed commit, deterministic input timestamp, immediate capability
  continuation, persistent-effect termination, waiting-effect precedence and
  later-tool blocking, pre-abort, Pi terminal abort/error semantics, max-step
  exhaustion, zero-step budget, accumulated usage, max-16 validation, and
  unknown-field containment.
- All streams and models are local fakes; no live model or network call occurs.

## Fresh verification evidence

### Full suite

`npm test`

- Test files: 9 passed
- Tests: 59 passed
- Failures: 0

### Typecheck

`npm run typecheck`

- `tsc --noEmit`
- Exit code: 0

### Build

`npm run build`

- `tsc -p tsconfig.json`
- Exit code: 0

### Formatting/diff check

`git diff --check`

- Exit code: 0

### Import-boundary audit

`rg -n "@earendil-works/pi|typebox" packages --glob "*.ts" --glob package.json`

Every match was under `packages/pi-cognition`. A follow-up command filtered
out `^packages/pi-cognition/` and asserted that no matches remained; it exited
0. A separate `rg` assertion found no `pi-coding-agent` match.

### Installed production dependency audit

`npm audit --omit=dev`

- `found 0 vulnerabilities`

## Real Pi 0.75.5 API adaptations

- Used the real `runAgentLoop(prompts, context, config, emit, signal, streamFn)`
  signature; no guessed callback position or separate event array.
- Pi provider failures and aborts normally terminate as final assistant
  messages with `stopReason: "error" | "aborted"` rather than necessarily
  throwing. The adapter observes `message_end`, preserves usage, and maps both
  terminal states explicitly.
- Pi only honors a tool batch's early-termination hint when every finalized
  tool result has `terminate: true`, and sequential execution does not stop
  immediately after the first terminating result. The adapter therefore uses
  sequential execution plus `beforeToolCall` gating after either `oren_commit`
  or `waiting_for_effect`, and independently stops after the turn.
- Pi naturally stops when an assistant response has no tool call. Max-step
  testing therefore uses repeated non-terminating immediate tool turns, which
  exercises the actual provider-turn loop.
- Pi validates tool arguments before execution through TypeBox. The commit
  schema is strict, typed, capped at 16 proposals, and malformed input cannot
  reach the commit executor.
- A caller-supplied `messageTimestamp` factory makes the initial decision input
  deterministic; the option remains optional and defaults to `Date.now`.

## State ownership and effect semantics

- The adapter owns only episode-local variables. It receives an immutable
  `LifeFrame` and returns a `CognitionOutcome`; it does not mutate or persist
  Oren state.
- Only the internal `oren_commit` executor assigns accepted proposals.
- A capability returning `waiting_for_effect` records the effect id, returns
  wording that says the effect is queued and pending receipt, blocks later
  same-turn tools, terminates the episode, and takes precedence over a commit.
- Completed immediate tools return only their actual output. No queued
  persistent effect is described as completed.

## Deviations and risks

- The sample brief's `events` array was unnecessary and was not retained.
- The implementation is stricter than the sample schema: unknown commit or
  proposal fields are rejected.
- The exact Pi packages add a large provider transitive dependency section to
  `package-lock.json`; this is generated workspace resolution, not handwritten
  package expansion. The installed production audit is clean.
- The report is added after the focused implementation commit so it can record
  that implementation SHA exactly. The final report commit SHA is returned to
  the parent agent.
