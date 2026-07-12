import fs from "node:fs/promises";
import path from "node:path";
import { corpusDir } from "./paths.js";
import { describeAbsence } from "./relation/visit.js";
import { LifeStore } from "./store/life-store.js";
import { loadWill } from "./will/store.js";

export interface DoctorReport {
  ok: boolean;
  lines: string[];
}

export async function runDoctor(home: string): Promise<DoctorReport> {
  const lines: string[] = [];
  let ok = true;
  const store = new LifeStore(home);

  lines.push(`OREN_HOME=${home}`);
  lines.push(`OREN_LLM=${process.env.OREN_LLM ?? "(auto)"}`);
  lines.push(`OREN_TICK_LLM=${process.env.OREN_TICK_LLM ?? "(same as OREN_LLM)"}`);
  lines.push(`OREN_SAY_LLM=${process.env.OREN_SAY_LLM ?? "(same as OREN_LLM)"}`);
  lines.push(`OREN_MODEL=${process.env.OREN_MODEL ?? "(from config/default)"}`);

  const hasKey = !!(
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_OAUTH_TOKEN
  );
  lines.push(`provider_key=${hasKey ? "present" : "MISSING"}`);
  const dsKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (dsKey) {
    lines.push(`DEEPSEEK_API_KEY=****${dsKey.slice(-4)} (len=${dsKey.length})`);
  } else {
    lines.push(`DEEPSEEK_API_KEY=(missing)`);
  }

  if (!hasKey && (process.env.OREN_LLM === "pi" || process.env.OREN_LLM === "live")) {
    ok = false;
  }

  try {
    const state = await store.load();
    lines.push(`life=ok oren_id=${state.meta.oren_id}`);
    lines.push(`tick_count=${state.meta.tick_count}`);
    lines.push(`last_tick_at=${state.meta.last_tick_at ?? "(never)"}`);
    lines.push(`model_config=${state.config.model}`);
    const active = Object.values(state.threads).filter((t) => t.status === "active");
    lines.push(`active_threads=${active.length}`);
    lines.push(`relation: ${describeAbsence(state.affect)}`);

    let willFilePresent = false;
    try {
      await fs.access(store.paths.will);
      willFilePresent = true;
    } catch {
      willFilePresent = false;
    }
    if (!willFilePresent) {
      lines.push(
        "will=missing (soft) — will be synthesized from agenda/life on next tick or load",
      );
    } else {
      try {
        const will = await loadWill(store, new Date().toISOString());
        const focus = will.focus.summary.slice(0, 80);
        lines.push(
          `will=ok focus=${JSON.stringify(focus)} posture=${will.toward_user.posture} queue=${will.session.queue.length}`,
        );
      } catch (err) {
        ok = false;
        lines.push(
          `will=CORRUPT (${err instanceof Error ? err.message : err})`,
        );
      }
    }

    const cDir = corpusDir(home, state.config);
    let corpusFiles = 0;
    try {
      const walk = async (d: string) => {
        const ents = await fs.readdir(d, { withFileTypes: true });
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else if (/\.(md|txt|markdown)$/i.test(e.name) && e.name !== "README.md") {
            corpusFiles++;
          }
        }
      };
      await walk(cDir);
    } catch {
      ok = false;
      lines.push(`corpus=MISSING (${cDir})`);
    }
    lines.push(`corpus_docs=${corpusFiles}`);
    if (corpusFiles === 0) {
      lines.push("warn: empty corpus — contemplate will degrade to idle");
    }

    try {
      await fs.access(store.paths.lock);
      lines.push("lock=HELD (another tick may be running or crashed)");
    } catch {
      lines.push("lock=free");
    }
  } catch (err) {
    ok = false;
    lines.push(`life=NOT_INITIALIZED (${err instanceof Error ? err.message : err})`);
    lines.push("hint: run `oren init` or `bash scripts/setup-life.sh`");
  }

  return { ok, lines };
}
