import { describe, expect, it } from "vitest";
import type { LifeFrame } from "@oren/cognition";
import { systemPrompt } from "@oren/pi-cognition";

const FRAME: LifeFrame = {
  orenId: "oren-1", correlationId: "c1", stateVersion: 1,
  identity: { ethosVersion: 1, disposition: "attentive" },
  attention: { focus: null, threadIds: [] },
  relationship: { primaryPersonId: "p1", contextRef: null },
  trigger: { kind: "foreground_user", summary: "hi" },
  memoryPins: [],
  capabilities: [],
  maxSteps: 8,
};

describe("provenance prompts", () => {
  it("system prompt teaches web provenance discipline", () => {
    const prompt = systemPrompt(FRAME);
    expect(prompt).toContain("来源与事实");
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("web.read");
    expect(prompt).toMatch(/观察|检索/);
    expect(prompt).toMatch(/来源|引用/);
  });
});
