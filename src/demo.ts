import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectLlm } from "./llm/select.js";
import { loadDotEnv } from "./load-env.js";
import { LifeStore } from "./store/life-store.js";
import { runTick } from "./tick/engine.js";

/**
 * Prepare a demo life: init, seed corpus, a few ticks, then print serve instructions.
 * Uses OREN_TICK_LLM=fake by default so demos work offline.
 */
export async function runDemo(opts?: {
  home?: string;
  port?: number;
  serve?: boolean;
}): Promise<{ home: string; port: number }> {
  const port = opts?.port ?? 8787;
  const home =
    opts?.home ??
    process.env.OREN_HOME ??
    path.join(
      process.env.HOME || process.cwd(),
      "Library/Application Support/Oren",
    );

  process.env.OREN_HOME = home;
  process.env.OREN_TICK_LLM = process.env.OREN_TICK_LLM || "fake";
  // Prefer live say if key present, else fake
  if (!process.env.OREN_SAY_LLM) {
    process.env.OREN_SAY_LLM = process.env.DEEPSEEK_API_KEY ? "pi" : "fake";
  }

  loadDotEnv();
  loadDotEnv([home]);

  console.log("Oren demo setup");
  console.log("  OREN_HOME=" + home);

  let store = new LifeStore(home);
  try {
    await store.load();
    console.log("  life: existing");
  } catch {
    store = await LifeStore.init(home);
    console.log("  life: initialized");
  }

  // seed corpus
  const corpus = path.join(home, "data/corpus");
  await fs.mkdir(corpus, { recursive: true });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixtures = [
    path.resolve(here, "../fixtures/corpus"),
    path.join(process.cwd(), "fixtures/corpus"),
  ];
  let seeded = 0;
  for (const fix of fixtures) {
    try {
      for (const name of await fs.readdir(fix)) {
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
      /* next */
    }
  }
  console.log("  corpus seeded +" + seeded);

  const state = await store.load();
  const model = process.env.OREN_MODEL?.trim() || state.config.model;
  const llm = selectLlm(model, "tick");

  // Warm presence: idle + contemplate so monologues exist for the dashboard
  console.log("  tick: idle…");
  await runTick({ home, forceMode: "idle", llm });
  console.log("  tick: contemplate…");
  const t = await runTick({ home, forceMode: "contemplate", llm });
  console.log("  " + t.message);

  const after = await store.load();
  console.log("  ticks=" + after.meta.tick_count);
  console.log("  active_threads=" + Object.values(after.threads).filter((x) => x.status === "active").length);
  console.log("");
  console.log("Demo ready.");
  console.log("  Dashboard: http://127.0.0.1:" + port);
  console.log("  CLI say:   OREN_HOME=\"" + home + "\" npm run oren -- say \"你在想什么？\"");
  console.log("");

  if (opts?.serve !== false) {
    const { startDashboardServer } = await import("./dashboard/server.js");
    startDashboardServer({ home, port, host: "127.0.0.1" });
    console.log("Serving… Ctrl+C to stop");
    // open browser on macOS best-effort
    try {
      spawn("open", ["http://127.0.0.1:" + port], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* ignore */
    }
    await new Promise(() => {});
  }

  return { home, port };
}
