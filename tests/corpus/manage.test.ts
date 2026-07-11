import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCorpusFiles,
  sanitizeCorpusName,
  writeCorpusFile,
} from "../../src/corpus/manage.js";
import { defaultConfig } from "../../src/types.js";

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

describe("corpus manage", () => {
  it("sanitizes names and rejects traversal", () => {
    expect(sanitizeCorpusName("notes.md")).toBe("notes.md");
    expect(() => sanitizeCorpusName("../x.md")).toThrow();
    expect(() => sanitizeCorpusName("x.exe")).toThrow();
  });

  it("writes and lists corpus files", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-corp-"));
    temps.push(home);
    const config = defaultConfig();
    await fs.mkdir(path.join(home, "data/corpus"), { recursive: true });
    await writeCorpusFile(home, config, "idea.md", "# Hello\n\nworld");
    const list = await listCorpusFiles(home, config);
    expect(list.some((f) => f.path === "idea.md")).toBe(true);
    expect(list[0]!.bytes).toBeGreaterThan(0);
  });
});
