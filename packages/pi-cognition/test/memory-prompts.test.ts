import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import type { LifeFrame } from "@oren/cognition";
import { CommitSchema, systemPrompt, userPrompt } from "@oren/pi-cognition";

const FRAME: LifeFrame = {
  orenId: "oren-1", correlationId: "c1", stateVersion: 1,
  identity: { ethosVersion: 1, disposition: "attentive" },
  attention: { focus: null, threadIds: [] },
  relationship: { primaryPersonId: "p1", contextRef: null },
  trigger: { kind: "foreground_user", summary: "hi" },
  memoryPins: [{
    memoryId: "m-pin-1", kind: "oren_judgment",
    text: "判断：用户在准备一场演讲", confidence: 0.6,
    occurredAt: "2026-07-20T00:00:00.000Z",
  }],
  capabilities: [],
  maxSteps: 8,
};

describe("memory proposals in commit schema", () => {
  it("accepts Remember/ReviseBelief/Forget", () => {
    expect(Check(CommitSchema, {
      proposals: [
        { type: "Remember", text: "事实", kind: "external_fact" },
        { type: "ReviseBelief", memoryId: "m1", confidence: 0.2, reason: "r" },
        { type: "Forget", memoryId: "m2", reason: "r" },
      ],
    })).toBe(true);
    expect(Check(CommitSchema, {
      proposals: [{ type: "Remember", text: "x" }],
    })).toBe(false);
  });
});

describe("memory prompts", () => {
  it("system prompt teaches memory discipline", () => {
    const prompt = systemPrompt(FRAME);
    expect(prompt).toContain("记忆纪律");
    expect(prompt).toContain("Remember");
    expect(prompt).toContain("ReviseBelief");
    expect(prompt).toContain("Forget");
    expect(prompt).toContain("memory.recall");
  });

  it("user prompt renders memory pins with memoryId", () => {
    const prompt = userPrompt(FRAME);
    expect(prompt).toContain("相关记忆");
    expect(prompt).toContain("m-pin-1");
    expect(prompt).toContain("判断：用户在准备一场演讲");
    const empty = userPrompt({ ...FRAME, memoryPins: [] });
    expect(empty).toContain("无相关记忆钉");
  });
});
