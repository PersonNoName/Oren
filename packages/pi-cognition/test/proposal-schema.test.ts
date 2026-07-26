import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { CommitSchema } from "@oren/pi-cognition";

describe("commitment proposals in commit schema", () => {
  it("accepts UpsertCommitment and UpdateCommitmentStatus", () => {
    expect(Check(CommitSchema, {
      proposals: [
        {
          type: "UpsertCommitment",
          goal: "finish report",
          status: "active",
          nextStep: "draft outline",
          mayAdvanceAutonomously: true,
        },
        {
          type: "UpsertCommitment",
          commitmentId: "c1",
          goal: "exercise",
          status: "paused",
          nextStep: "rest",
          mayAdvanceAutonomously: false,
        },
        {
          type: "UpdateCommitmentStatus",
          commitmentId: "c1",
          status: "done",
          nextStep: "celebrate",
          reason: "finished",
        },
      ],
    })).toBe(true);
    expect(Check(CommitSchema, {
      proposals: [{ type: "UpsertCommitment", goal: "g", status: "active" }],
    })).toBe(false);
    expect(Check(CommitSchema, {
      proposals: [{
        type: "UpdateCommitmentStatus",
        commitmentId: "c1",
        status: "done",
      }],
    })).toBe(false);
  });
});
