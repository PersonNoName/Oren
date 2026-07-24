# Oren

Oren is a restartable, event-sourced life-kernel slice. The Phase 1 runtime
persists user input, cognition requests, effects, receipts, Inbox work, and
scheduled wakes in SQLite, then rehydrates the same `LifeState` after restart.

## Install and verify

```bash
npm install
npm test
npm run typecheck
npm run build
node --enable-source-maps dist/packages/app/src/demo.js
```

The demo is deterministic and offline. It executes a read, persists an
increment effect, dispatches it, resumes cognition from the durable Inbox,
schedules a wake, closes SQLite, reopens the database, and verifies exact
state replay.

## Architecture boundaries

- `LifeActor` is the only writer of life-state events.
- `SqliteLifeRepository` atomically appends events and their effect/schedule
  side tables; durable claims use leases and idempotency keys.
- Cognition depends on the generic `CognitionPort`. Pi and TypeBox imports are
  isolated to `packages/pi-cognition`; integration tests use fake streams.
- Extensions receive capability invocations, not SQLite or model credentials.
  Persistent capability calls end an episode and resume through a new,
  correlated Inbox episode.
- `LifeRuntime.drain()` drives due schedules, effect reconciliation, Inbox
  claims, actor transitions, and cognition to a bounded durable fixed point.
