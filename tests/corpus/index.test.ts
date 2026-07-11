import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCorpusIndex, chunkText } from "../../src/corpus/index.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/corpus");

describe("buildCorpusIndex", () => {
  it("indexes fixture docs with stable hashes", async () => {
    const a = await buildCorpusIndex(fixtures);
    const b = await buildCorpusIndex(fixtures);
    expect(a.docs.length).toBeGreaterThanOrEqual(2);
    expect(a.docs.map((d) => d.hash)).toEqual(b.docs.map((d) => d.hash));
    expect(a.docs.every((d) => d.chunks.length > 0)).toBe(true);
  });

  it("chunks on blank lines", () => {
    const chunks = chunkText("one\n\ntwo\n\nthree", "x.md");
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.text).toBe("one");
  });
});
