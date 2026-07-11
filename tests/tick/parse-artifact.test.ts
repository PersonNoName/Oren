import { describe, expect, it } from "vitest";
import {
  ArtifactParseError,
  assertArtifactUseful,
  parseArtifact,
} from "../../src/tick/parse-artifact.js";

describe("parseArtifact", () => {
  it("parses fenced json", () => {
    const a = parseArtifact('```json\n{"monologue":"hi","refined_summary":"s"}\n```');
    expect(a.monologue).toBe("hi");
    assertArtifactUseful(a);
  });

  it("rejects empty monologue", () => {
    expect(() => parseArtifact('{"monologue":"  "}')).toThrow(ArtifactParseError);
  });

  it("rejects useless artifact", () => {
    const a = parseArtifact('{"monologue":"only vibes"}');
    expect(() => assertArtifactUseful(a)).toThrow(ArtifactParseError);
  });
});
