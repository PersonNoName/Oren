#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { sayToOren } from "./dialogue/reply.js";
import { readDialogueTail } from "./dialogue/store.js";
import { runDoctor } from "./doctor.js";
import { selectLlm } from "./llm/select.js";
import { loadDotEnv } from "./load-env.js";
import { resolveHome } from "./paths.js";
import { loadRelation } from "./relation/cognition.js";
import { recordVisit } from "./relation/visit.js";
import { LifeStore } from "./store/life-store.js";
import { runTick } from "./tick/engine.js";
import type { Mode } from "./types.js";

loadDotEnv();

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const home = resolveHome();
  loadDotEnv([home]);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (cmd === "init") {
    await LifeStore.init(home);
    console.log(`initialized Oren life at ${path.join(home, "data/life")}`);
    console.log(`place corpus files in ${path.join(home, "data/corpus")}`);
    return 0;
  }

  if (cmd === "tick") {
    let forceMode: Mode | undefined;
    try {
      forceMode = parseForceMode(rest);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      return 1;
    }
    const store = new LifeStore(home);
    let model = "anthropic:claude-sonnet-4-5";
    try {
      const state = await store.load();
      model = process.env.OREN_MODEL?.trim() || state.config.model;
    } catch {
      // load failure handled in runTick
    }
    const llm = selectLlm(model, "tick");
    const result = await runTick({ home, forceMode, llm });
    console.log(result.message);
    return result.exitCode;
  }

  if (cmd === "status") {
    const store = new LifeStore(home);
    try {
      const state = await store.load();
      const tail = await store.readStreamTail(20);
      const active = Object.values(state.threads).filter((t) => t.status === "active");
      const rel = await loadRelation(store);
      console.log(`oren_id: ${state.meta.oren_id}`);
      console.log(`tick_count: ${state.meta.tick_count}`);
      console.log(`last_tick_at: ${state.meta.last_tick_at ?? "(never)"}`);
      console.log(`active_threads: ${active.length}`);
      for (const t of active.slice(0, 10)) {
        console.log(`  - ${t.id} salience=${t.salience.toFixed(2)} ${t.title}`);
      }
      const last = state.affect.absence.last_user_contact_at;
      console.log(`last_visit: ${last ?? "(never)"} count=${state.affect.absence.visit_count}`);
      console.log(
        `relation: cold=${rel.cold_topics.length} warm=${rel.warm_topics.length} notes=${rel.notes.length}`,
      );
      console.log("recent_stream:");
      for (const ev of tail.slice(-5)) {
        console.log(`  ${ev.ts} ${ev.type}`);
      }
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 3;
    }
  }

  if (cmd === "visit") {
    const note = rest.join(" ").trim() || undefined;
    try {
      const { affect } = await recordVisit(new LifeStore(home), { note });
      console.log(
        `visit recorded at ${affect.absence.last_user_contact_at} (#${affect.absence.visit_count})`,
      );
      if (note) console.log(`note: ${note}`);
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 3;
    }
  }

  if (cmd === "say") {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("usage: oren say <message>");
      return 1;
    }
    try {
      const store = new LifeStore(home);
      const state = await store.load();
      const model = process.env.OREN_MODEL?.trim() || state.config.model;
      const llm = selectLlm(model, "say");
      const result = await sayToOren({ store, text, llm });
      console.log(`you: ${result.userTurn.text}`);
      console.log(`oren: ${result.orenTurn.text}`);
      if (result.artifact.share.opened) {
        console.log(
          `  [share] thread=${result.artifact.share.thread_id ?? "?"} — ${result.artifact.share.snippet ?? ""}`,
        );
      } else if (result.artifact.share.reason) {
        console.log(`  [gate] ${result.artifact.share.reason}`);
      }
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (cmd === "history") {
    const n = Number(rest[0] ?? "12") || 12;
    try {
      const turns = await readDialogueTail(new LifeStore(home), n);
      if (turns.length === 0) {
        console.log("(no dialogue yet)");
        return 0;
      }
      for (const t of turns) {
        const who = t.role === "user" ? "you" : "oren";
        console.log(`${t.ts} ${who}: ${t.text}`);
        if (t.share?.opened) {
          console.log(`  [share] ${t.share.snippet ?? ""}`);
        }
      }
      return 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 3;
    }
  }

  if (cmd === "doctor") {
    const report = await runDoctor(home);
    for (const line of report.lines) console.log(line);
    console.log(report.ok ? "doctor: OK" : "doctor: ISSUES");
    return report.ok ? 0 : 1;
  }

  if (cmd === "demo") {
    const port = Number(process.env.OREN_DASH_PORT ?? parsePort(rest) ?? 8787);
    const { runDemo } = await import("./demo.js");
    await runDemo({ home, port, serve: true });
    return 0;
  }

  if (cmd === "serve" || cmd === "dashboard") {
    const port = Number(process.env.OREN_DASH_PORT ?? parsePort(rest) ?? 8787);
    const { startDashboardServer } = await import("./dashboard/server.js");
    const host = process.env.OREN_DASH_HOST ?? "127.0.0.1";
    startDashboardServer({ home, port, host });
    console.log(`Oren dashboard: http://${host}:${port}`);
    console.log(`OREN_HOME=${home} (read-only UI, Ctrl+C to stop)`);
    // keep process alive
    await new Promise(() => {});
    return 0;
  }

  if (cmd === "setup-life") {
    const { fileURLToPath } = await import("node:url");
    let store = new LifeStore(home);
    try {
      await store.load();
    } catch {
      store = await LifeStore.init(home);
    }
    const corpus = path.join(home, "data/corpus");
    await fs.mkdir(corpus, { recursive: true });
    const fixtureCandidates = [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/corpus"),
      path.join(process.cwd(), "fixtures/corpus"),
    ];
    let seeded = 0;
    for (const fix of fixtureCandidates) {
      try {
        const names = await fs.readdir(fix);
        for (const name of names) {
          if (!/\.(md|txt)$/i.test(name)) continue;
          const dest = path.join(corpus, name);
          try {
            await fs.access(dest);
          } catch {
            await fs.copyFile(path.join(fix, name), dest);
            seeded++;
          }
        }
        break;
      } catch {
        // try next
      }
    }
    console.log(`life ready at ${store.paths.lifeDir}`);
    console.log(`corpus ${corpus} (seeded ${seeded} files)`);
    console.log(`export OREN_HOME=${home}`);
    return 0;
  }

  console.error(`unknown command: ${cmd}`);
  printHelp();
  return 1;
}

function parseForceMode(args: string[]): Mode | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--force-mode" && args[i + 1]) {
      const m = args[i + 1]!;
      if (m === "idle" || m === "organize" || m === "contemplate") return m;
      throw new Error(`invalid --force-mode: ${m}`);
    }
  }
  return undefined;
}

function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      return Number(args[i + 1]);
    }
  }
  return undefined;
}

function printHelp(): void {
  console.log(`oren — continuous-presence agent (v0.2)

Usage:
  oren demo [--port 8787]      # seed life, warm ticks, open dashboard
  oren serve [--port 8787]     # dashboard (chat + tick + corpus)
  oren setup-life | init | doctor | status
  oren tick [--force-mode idle|organize|contemplate]
  oren say <message> | history [n] | visit [note]

Env:
  OREN_HOME       life root (default for demo: ~/Library/Application Support/Oren)
  OREN_TICK_LLM   fake | pi   (ticks; default fake for cheap heartbeat)
  OREN_SAY_LLM    fake | pi   (dialogue)
  OREN_MODEL      e.g. deepseek:deepseek-v4-flash
  OREN_DASH_PORT  dashboard port (default 8787)
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
