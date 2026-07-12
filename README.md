# Oren

**A continuous-presence agent with its own inner life.**

Oren reads a local corpus, contemplates on a heartbeat, grows self-memory threads, and sometimes talks with you — companionship as *overflow*, not purpose.

```bash
npm install
npm run demo
# → http://127.0.0.1:8787
```

See **[DEMO.md](./DEMO.md)** for a 5-minute walkthrough.

---

## What you get

| Layer | Capability |
|-------|------------|
| **Will spine** | Intent truth in `will.json`; session queue is a projection |
| **Life loop** | `oren tick` — perceive → revise Will → act → integrate → persist |
| **Self-memory** | Active threads with summary, open questions, salience |
| **Monologues** | Auditable contemplations in `ticks/` + dashboard |
| **Dialogue** | Will-turn (moves) → express (utterances); seepage at express |
| **Relation** | Visit / absence; cold/warm topic calibration (not sycophancy) |
| **Corpus** | Local md/txt feed; dashboard add / preview / delete |
| **Heartbeat** | launchd every 30m (`OREN_TICK_LLM=fake` by default) |
| **Dashboard** | Localhost UI for the whole presence |

## Will spine

Oren’s intent lives in **`will.json`** (single source of truth for wants / stance / open moves). The solitude **session queue** (former agenda 3–7) is a **projection** of that Will, not a second mind.

**Dialogue** is two-step: **will-turn** chooses moves → **express** writes utterances under those frozen moves. Express does not invent policy.

See the design spec: [`docs/superpowers/specs/2026-07-12-oren-will-spine-design.md`](./docs/superpowers/specs/2026-07-12-oren-will-spine-design.md).

## Commands

```bash
oren demo                 # seed + warm ticks + open dashboard
oren serve [--port 8787]  # dashboard only
oren doctor | status
oren tick [--force-mode idle|organize|contemplate]
oren say "…" | history
oren visit [note]
oren setup-life
```

## Environment

| Variable | Role |
|----------|------|
| `OREN_HOME` | Life root (demo default: `~/Library/Application Support/Oren`) |
| `OREN_TICK_LLM` | `fake` \| `pi` — unsupervised ticks |
| `OREN_SAY_LLM` | `fake` \| `pi` — dialogue express |
| `OREN_WILL_LLM` | `fake` \| `pi` — Will revise + will-turn |
| `OREN_MODEL` | e.g. `deepseek:deepseek-v4-flash` |
| `DEEPSEEK_API_KEY` | For live `pi` dialogue |

Put secrets in `$OREN_HOME/.env` (and project `.env` for convenience). Never commit keys.

## Durable setup + heartbeat

```bash
bash scripts/setup-life.sh
bash scripts/install-heartbeat.sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.oren.tick.plist
```

## Design lineage

- Essence (what Oren *is*): `design/2026-07-11-oren-core-essence.md`
- Architecture exploration: `discussion/2026-07-10-oren-agent-design.md`
- Technical spec: `docs/superpowers/specs/2026-07-12-oren-runtime-v1-design.md`
- **Will spine**: `docs/superpowers/specs/2026-07-12-oren-will-spine-design.md`
- **Memory + presence (pending)**: `docs/superpowers/specs/2026-07-12-oren-memory-and-presence-design.md`
- **Curiosity drive (v0.1)**: `docs/superpowers/specs/2026-07-12-oren-curiosity-drive-design.md`
- Stage assessment: `docs/2026-07-12-stage-assessment.md`

## Develop

```bash
npm test
npm run build
npm run oren -- doctor
```

## License

Private / project use unless otherwise stated.
