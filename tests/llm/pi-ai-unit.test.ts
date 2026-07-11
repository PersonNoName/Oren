import { describe, expect, it } from "vitest";
import { parseModelSpec } from "../../src/llm/pi-ai.js";

describe("parseModelSpec", () => {
  it("splits provider:model", () => {
    expect(parseModelSpec("anthropic:claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("defaults provider when bare id", () => {
    expect(parseModelSpec("claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });
});
