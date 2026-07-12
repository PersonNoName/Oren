# Curiosity Drive Implementation Plan

> **For agentic workers:** Implement task-by-task from design `docs/superpowers/specs/2026-07-12-oren-curiosity-drive-design.md`.

**Goal:** Shift solitude + dialogue from unread-KPI reading to question-led curiosity (optional read, note-via-think, seek wishes).

**Architecture:** Reuse `threads.open_questions` + `Will.focus`; plan hard rules; think `hints.mode=note|ruminate`; dialogue seepage includes questions.

**Tech Stack:** TypeScript, vitest, existing agenda/will/dialogue paths.

## Tasks

- P0: plan prompts + parse mode + ensure curiosity + FakeLlm + unit tests
- P1: act seek wish + think note path + open_questions writeback
- P2: dialogue seepage + light absorb
- P3: dashboard curiosity strip + README line
- Verify: npm test

Execution: inline this session.
