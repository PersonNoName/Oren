import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts sk- style keys and bearer tokens", () => {
    expect(redactSecrets("boom sk-abcdefghijklmnop end")).toContain("sk-***");
    expect(redactSecrets("Authorization Bearer abcdefghijklmnop")).toMatch(/Bearer \*\*\*/i);
  });

  it("redacts KEY=value assignments", () => {
    expect(redactSecrets("DEEPSEEK_API_KEY=secret-value-here")).toContain("DEEPSEEK_API_KEY=***");
  });
});
