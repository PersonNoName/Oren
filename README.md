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
| **Life loop** | `oren tick` — perceive → mode → act → integrate → persist |
| **Self-memory** | Active threads with summary, open questions, salience |
| **Monologues** | Auditable contemplations in `ticks/` + dashboard |
| **Dialogue** | `oren say` / dashboard chat — seepage + share gate |
| **Relation** | Visit / absence; cold/warm topic calibration (not sycophancy) |
| **Corpus** | Local md/txt feed; dashboard add / preview / delete |
| **Heartbeat** | launchd every 30m (`OREN_TICK_LLM=fake` by default) |
| **Dashboard** | Localhost UI for the whole presence |

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
| `OREN_SAY_LLM` | `fake` \| `pi` — dialogue |
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

## Develop

```bash
npm test
npm run build
npm run oren -- doctor
```

## License

Private / project use unless otherwise stated.
