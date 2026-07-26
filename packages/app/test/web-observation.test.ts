import { describe, expect, it } from "vitest";
import { observationFromRead } from "../src/web-observation.js";

describe("observationFromRead", () => {
  it("returns null for empty text", () => {
    expect(observationFromRead({
      url: "https://example.com/empty",
      text: "",
    })).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    expect(observationFromRead({
      url: "https://example.com/blank",
      text: "   \n\t  ",
    })).toBeNull();
  });

  it("returns observation for non-empty text", () => {
    expect(observationFromRead({
      url: "https://example.com/page",
      text: "Hello world",
    })).toEqual({
      kind: "web_page",
      sourceUrl: "https://example.com/page",
      excerpt: "Hello world",
    });
  });
});
