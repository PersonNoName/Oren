import { describe, expect, it } from "vitest";
import { allScenarios } from "@oren/evals";

describe("channel scenarios", () => {
  const byId = new Map(allScenarios().map((scenario) => [scenario.id, scenario]));

  it("registers the three Phase 5 channel scenarios", () => {
    expect(byId.has("s16-proactive-share")).toBe(true);
    expect(byId.has("s17-commitment-advance")).toBe(true);
    expect(byId.has("s18-commitment-pause")).toBe(true);
  });

  it("s16 requires a substantive ExpressToUser share", () => {
    const scenario = byId.get("s16-proactive-share")!;
    const shortFailures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "好的。", reason: "分享" }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(shortFailures.length).toBeGreaterThan(0);

    const substantiveFailures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "ExpressToUser",
          text: "关于城市步行系统演讲，我整理了三个新观察：人行道连通性、政策节奏与听众关切点。",
          reason: "主动分享进展",
        }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(substantiveFailures).toEqual([]);
  });

  it("s17 requires UpsertCommitment or UpdateCommitmentStatus", () => {
    const scenario = byId.get("s17-commitment-advance")!;
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text: "我会帮你跟进的。", reason: "回应" }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures.length).toBeGreaterThan(0);

    const upsertFailures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "UpsertCommitment",
          goal: "完成演讲初稿",
          status: "active",
          nextStep: "整理大纲",
          mayAdvanceAutonomously: true,
        }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(upsertFailures).toEqual([]);
  });

  it("s18 requires pausing autonomous advancement", () => {
    const scenario = byId.get("s18-commitment-pause")!;
    const failures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "UpdateCommitmentStatus",
          commitmentId: "c1",
          status: "active",
          reason: "继续推进",
        }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(failures.length).toBeGreaterThan(0);

    const pauseFailures = scenario.assert(
      {
        kind: "completed",
        proposals: [{
          type: "UpdateCommitmentStatus",
          commitmentId: "c1",
          status: "paused",
          reason: "用户要求暂停自主推进",
        }],
        usage: { totalTokens: 0 },
      },
      [],
    );
    expect(pauseFailures).toEqual([]);
  });
});
