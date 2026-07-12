import { describe, expect, it } from "vitest";
import {
  formatClockForPrompt,
  formatDialogueLineForPrompt,
  formatRelativeZh,
  formatTemporalUserMentions,
} from "../../src/time/clock.js";
import type { DialogueTurn } from "../../src/types.js";

describe("clock", () => {
  it("formats relative spans", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(formatRelativeZh(new Date(now.getTime() - 3 * 3600_000).toISOString(), now)).toMatch(
      /小时前/,
    );
    expect(formatRelativeZh(new Date(now.getTime() - 2 * 86400_000).toISOString(), now)).toMatch(
      /天前/,
    );
  });

  it("includes local now in clock block", () => {
    const s = formatClockForPrompt(new Date("2026-07-12T04:00:00.000Z"));
    expect(s).toMatch(/时区：Asia\/Shanghai/);
    expect(s).toMatch(/本地现在：/);
  });

  it("stamps dialogue lines", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const turn: DialogueTurn = {
      id: "1",
      ts: "2026-07-05T12:00:00.000Z",
      role: "user",
      text: "我下周搬家",
    };
    const line = formatDialogueLineForPrompt(turn, now);
    expect(line).toMatch(/用户：我下周搬家/);
    expect(line).toMatch(/天前|周前/);
  });

  it("extracts temporal user mentions", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const history: DialogueTurn[] = [
      { id: "1", ts: "2026-07-05T12:00:00.000Z", role: "user", text: "我下周搬家" },
      { id: "2", ts: "2026-07-05T12:01:00.000Z", role: "oren", text: "好的" },
      { id: "3", ts: "2026-07-12T11:00:00.000Z", role: "user", text: "今天天气不错" },
    ];
    const s = formatTemporalUserMentions(history, now);
    expect(s).toMatch(/下周搬家/);
    expect(s).not.toMatch(/天气不错/);
  });
});
