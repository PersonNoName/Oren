// packages/pi-cognition/test/prompts.test.ts
import { describe, expect, it } from "vitest";
import { getEthos, systemPrompt, userPrompt } from "../src/index.js";
import { createFrame } from "./fixtures.js";

describe("systemPrompt", () => {
  it("injects the ethos for the frame's version and all rule sections", () => {
    const prompt = systemPrompt(createFrame());
    expect(prompt).toContain(getEthos(1));
    expect(prompt).toContain("生命导演");
    expect(prompt).toContain("oren_commit");
    expect(prompt).toContain("NoAction");
    expect(prompt).toContain("ScheduleWake");
    expect(prompt).toContain("事实");
    expect(prompt).toContain("推测");
    expect(prompt).toContain("回执");
    expect(prompt).toContain("最多 8 轮");
  });

  it("fails loudly on an unknown ethos version", () => {
    const frame = createFrame({
      identity: { ethosVersion: 99, disposition: "attentive" },
    });
    expect(() => systemPrompt(frame)).toThrow(/Unknown ethos version: 99/);
  });
});

describe("userPrompt", () => {
  it("presents trigger, attention, and relationship in labeled sections", () => {
    const prompt = userPrompt(createFrame({
      attention: { focus: "counter lifecycle", threadIds: ["t-1", "t-2"] },
      trigger: { kind: "foreground_user", summary: "hello there" },
    }));
    expect(prompt).toContain("触发");
    expect(prompt).toContain("foreground_user");
    expect(prompt).toContain("hello there");
    expect(prompt).toContain("counter lifecycle");
    expect(prompt).toContain("t-1");
    expect(prompt).toContain("person-1");
  });

  it("renders an explicit marker when focus is empty", () => {
    const prompt = userPrompt(createFrame());
    expect(prompt).toContain("（无当前关注焦点）");
  });
});
