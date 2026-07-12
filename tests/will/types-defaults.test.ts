// tests/will/types-defaults.test.ts
import { describe, expect, it } from "vitest";
import { defaultWill, type Will } from "../../src/types.js";

describe("defaultWill", () => {
  it("builds empty session and quiet toward_user", () => {
    const w = defaultWill("2026-07-12T00:00:00.000Z");
    expect(w.focus.summary).toBeTruthy();
    expect(w.toward_user.posture).toBe("quiet");
    expect(w.toward_user.share_drive).toBe("low");
    expect(w.session.queue).toEqual([]);
    expect(w.open_moves).toEqual([]);
  });
});
