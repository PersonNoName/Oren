import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteCorpusFile,
  listCorpusFiles,
  readCorpusFile,
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

  it("writes, reads, lists, deletes corpus files", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-corp-"));
    temps.push(home);
    const config = defaultConfig();
    await writeCorpusFile(home, config, "idea.md", "# Hello\n\nworld");
    const list = await listCorpusFiles(home, config);
    expect(list.some((f) => f.path === "idea.md")).toBe(true);
    expect(list.find((f) => f.path === "idea.md")!.preview).toContain("Hello");
    const read = await readCorpusFile(home, config, "idea.md");
    expect(read.content).toContain("world");
    await deleteCorpusFile(home, config, "idea.md");
    const after = await listCorpusFiles(home, config);
    expect(after.some((f) => f.path === "idea.md")).toBe(false);
  });
});

