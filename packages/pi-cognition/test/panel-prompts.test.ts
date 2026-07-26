import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import type { LifeFrame } from "@oren/cognition";
import { CommitSchema, systemPrompt } from "@oren/pi-cognition";

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

describe("panel prompts", () => {
  it("system prompt teaches sharing/reachability and commitment discipline", () => {
    const prompt = systemPrompt(FRAME);
    expect(prompt).toContain("分享与打扰");
    expect(prompt).toContain("共同承诺");
    expect(prompt).toContain("UpsertCommitment");
    expect(prompt).toContain("UpdateCommitmentStatus");
    expect(prompt).toMatch(/主动分享|打扰/);
    expect(prompt).toMatch(/nextStep|下一步/);
  });

  it("accepts commitment proposals in commit schema", () => {
    expect(Check(CommitSchema, {
      proposals: [
        {
          type: "UpsertCommitment",
          goal: "完成演讲初稿",
          status: "active",
          nextStep: "整理大纲",
          mayAdvanceAutonomously: true,
        },
        {
          type: "UpdateCommitmentStatus",
          commitmentId: "c1",
          status: "paused",
          reason: "用户要求暂停",
        },
      ],
    })).toBe(true);
  });
});
