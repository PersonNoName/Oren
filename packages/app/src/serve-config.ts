import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export type ServeConfig = {
  readonly databasePath: string;
  readonly panelPort: number;
  readonly orenId: string;
  readonly personId: string;
  readonly drainIntervalMs: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function resolveServeConfig(
  env: Readonly<Record<string, string | undefined>>,
  homedir: () => string = osHomedir,
): ServeConfig {
  const databasePath = env.OREN_DB?.trim() || join(homedir(), ".oren", "life.db");
  return {
    databasePath,
    panelPort: parsePositiveInt(env.OREN_PANEL_PORT, 7465, "OREN_PANEL_PORT"),
    orenId: env.OREN_ID?.trim() || "oren-local",
    personId: env.OREN_PERSON_ID?.trim() || "person-local",
    drainIntervalMs: parsePositiveInt(env.OREN_DRAIN_INTERVAL_MS, 2000, "OREN_DRAIN_INTERVAL_MS"),
  };
}
