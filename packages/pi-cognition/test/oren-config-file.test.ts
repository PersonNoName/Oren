import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findOrenConfigPath,
  loadOrenConfigFile,
} from "../src/oren-config-file.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oren-config-"));
}

describe("findOrenConfigPath", () => {
  it("finds oren.json in an ancestor directory", () => {
    const root = tempDir();
    writeFileSync(join(root, "oren.json"), JSON.stringify({
      model: { provider: "openai", id: "gpt-4o" },
    }));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findOrenConfigPath(nested)).toBe(join(root, "oren.json"));
  });

  it("returns undefined when no oren.json exists", () => {
    expect(findOrenConfigPath(tempDir())).toBeUndefined();
  });
});

describe("loadOrenConfigFile", () => {
  it("loads a valid config", () => {
    const dir = tempDir();
    const path = join(dir, "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toEqual({
      ok: true,
      config: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
    });
  });

  it("trims provider and id on success", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "  anthropic  ", id: "  claude-sonnet-4-5  " },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toEqual({
      ok: true,
      config: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
    });
  });

  it("rejects unknown top-level fields", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "openai", id: "x" },
      extra: true,
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/unknown|extra/i);
  });

  it("rejects apiKey fields", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "openai", id: "x", apiKey: "sk-nope" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/apiKey|API key|environment/i);
    expect(result.reason).not.toContain("sk-nope");
  });

  it("rejects empty provider/id after trim", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, JSON.stringify({
      model: { provider: "  ", id: "gpt" },
    }));
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("rejects malformed JSON", () => {
    const path = join(tempDir(), "oren.json");
    writeFileSync(path, "{not-json");
    const result = loadOrenConfigFile(path);
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(path);
  });
});
