#!/usr/bin/env node
import path from "node:path";
import { FakeLlmCompleter } from "./llm/fake.js";
import { PiAiCompleter } from "./llm/pi-ai.js";
import type { LlmCompleter } from "./llm/types.js";
import { loadDotEnv } from "./load-env.js";
import { resolveHome } from "./paths.js";
import { LifeStore } from "./store/life-store.js";
import { runTick } from "./tick/engine.js";
import type { Mode } from "./types.js";

// Load .env before reading any provider keys
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
    const llm = selectLlm(model);
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
      console.log(`oren_id: ${state.meta.oren_id}`);
      console.log(`tick_count: ${state.meta.tick_count}`);
      console.log(`last_tick_at: ${state.meta.last_tick_at ?? "(never)"}`);
      console.log(`active_threads: ${active.length}`);
      for (const t of active.slice(0, 10)) {
        console.log(`  - ${t.id} salience=${t.salience.toFixed(2)} ${t.title}`);
      }
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

function selectLlm(model: string): LlmCompleter {
  const mode = (process.env.OREN_LLM ?? "").toLowerCase();
  if (mode === "fake") {
    return new FakeLlmCompleter();
  }
  if (mode === "pi" || mode === "live") {
    return new PiAiCompleter(model);
  }
  // auto: use pi when any common auth signal is present
  const hasKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_OAUTH_TOKEN ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_COMPAT_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY
  );
  if (!hasKey) {
    return new FakeLlmCompleter();
  }
  return new PiAiCompleter(model);
}

function printHelp(): void {
  console.log(`oren — continuous-presence agent runtime (v1)

Usage:
  oren init
  oren tick [--force-mode idle|organize|contemplate]
  oren status

Env:
  OREN_HOME     data root (default: cwd)
  OREN_LLM      fake | pi | auto (default auto)
  OREN_MODEL    provider:modelId
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
