import fs from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader (no dependency). Does not override existing process.env.
 * Searches: $OREN_HOME/.env, cwd/.env, package root-ish (cwd).
 */
export function loadDotEnv(extraDirs: string[] = []): void {
  const candidates = [
    ...extraDirs.map((d) => path.join(d, ".env")),
    process.env.OREN_HOME ? path.join(process.env.OREN_HOME, ".env") : "",
    path.join(process.cwd(), ".env"),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
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
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}
