import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const OREN_CONFIG_FILENAME = "oren.json";
export const OREN_CONFIG_ENV = "OREN_CONFIG";

export type OrenFileConfig = {
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
};

type LoadSuccess = { readonly ok: true; readonly config: OrenFileConfig };
type LoadFailure = {
  readonly ok: false;
  readonly kind: "invalid";
  readonly reason: string;
};

export function findOrenConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, OREN_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function invalid(path: string, reason: string): LoadFailure {
  return { ok: false, kind: "invalid", reason: `${path}: ${reason}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(path: string, parsed: unknown): LoadSuccess | LoadFailure {
  if (!isRecord(parsed)) {
    return invalid(path, "Config must be a JSON object.");
  }

  const keys = Object.keys(parsed);
  const unknownKeys = keys.filter((key) => key !== "model");
  if (unknownKeys.length > 0) {
    return invalid(
      path,
      `Unknown top-level field(s): ${unknownKeys.join(", ")}. Only "model" is allowed.`,
    );
  }

  if ("apiKey" in parsed) {
    return invalid(
      path,
      "apiKey must not be set in oren.json; use environment variables for API keys.",
    );
  }

  const { model } = parsed;
  if (!isRecord(model)) {
    return invalid(path, '"model" must be an object.');
  }

  if ("apiKey" in model) {
    return invalid(
      path,
      "apiKey must not be set under model; use environment variables for API keys.",
    );
  }

  const modelKeys = Object.keys(model);
  const unknownModelKeys = modelKeys.filter(
    (key) => key !== "provider" && key !== "id",
  );
  if (unknownModelKeys.length > 0) {
    return invalid(
      path,
      `Unknown field(s) under model: ${unknownModelKeys.join(", ")}. Only "provider" and "id" are allowed.`,
    );
  }

  if (typeof model.provider !== "string" || typeof model.id !== "string") {
    return invalid(path, '"model.provider" and "model.id" must be strings.');
  }

  const provider = model.provider.trim();
  const id = model.id.trim();
  if (!provider) {
    return invalid(path, '"model.provider" must be a non-empty string.');
  }
  if (!id) {
    return invalid(path, '"model.id" must be a non-empty string.');
  }

  return { ok: true, config: { model: { provider, id } } };
}

export function loadOrenConfigFile(path: string): LoadSuccess | LoadFailure {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Cannot read Oren config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return validateConfig(path, parsed);
}
