import fs from "node:fs";
import path from "node:path";

/** Keys that should prefer the life-home .env over a stale process/shell value. */
const OVERRIDE_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OREN_MODEL",
  "OREN_LLM",
  "OREN_TICK_LLM",
  "OREN_SAY_LLM",
  "OREN_WILL_LLM",
  "OREN_PLAN_LLM",
  "OREN_ORGANIZE_LLM",
  "OREN_HOME",
]);

/**
 * Minimal .env loader.
 * - First pass: fill missing keys from cwd / known paths
 * - Prefer life-home (extraDirs / OREN_HOME) for API keys so a stale shell
 *   export cannot keep an expired DEEPSEEK_API_KEY forever.
 */
export function loadDotEnv(extraDirs: string[] = []): void {
  const homeEnv = [
    ...extraDirs.map((d) => path.join(d, ".env")),
    process.env.OREN_HOME ? path.join(process.env.OREN_HOME, ".env") : "",
  ].filter(Boolean);

  const general = [path.join(process.cwd(), ".env")].filter(Boolean);

  // 1) non-override fill from cwd
  for (const file of general) {
    applyEnvFile(file, false);
  }
  // 2) life home: override secrets / Oren routing
  for (const file of homeEnv) {
    applyEnvFile(file, true);
  }
  // 3) if still missing, try cwd again for any leftover non-secrets
  for (const file of general) {
    applyEnvFile(file, false);
  }
}

function applyEnvFile(file: string, allowOverride: boolean): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const exists = process.env[key] !== undefined && process.env[key] !== "";
    if (!exists) {
      process.env[key] = val;
      continue;
    }
    if (allowOverride && OVERRIDE_KEYS.has(key) && val) {
      process.env[key] = val;
    }
  }
}
