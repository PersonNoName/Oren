import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedCognitionAdapter } from "@oren/cognition";
import { runSmoke } from "../src/index.js";

const FUTURE_WAKE = "2999-01-01T00:00:00.000Z";

function scriptedCognition() {
  return new ScriptedCognitionAdapter(async (frame, capabilityPort, signal) => {
    if (frame.trigger.kind === "foreground_user") {
      const increment = frame.capabilities.find(({ name }) => name === "test.increment")!;
      const pending = await capabilityPort.invoke({
        orenId: frame.orenId,
        descriptor: increment,
        arguments: { by: 1 },
        stateVersion: frame.stateVersion,
        correlationId: frame.correlationId,
      }, signal);
      if (pending.kind !== "waiting_for_effect") {
        return { kind: "failed", message: "expected durable effect", usage: { totalTokens: 0 } };
      }
      return { ...pending, usage: { totalTokens: 5 } };
    }
    return {
      kind: "completed",
      proposals: [
        { type: "AdvanceThread", threadId: "smoke", summary: "Counter incremented" },
        {
          type: "Remember",
          text: "判断：该计数器用于 smoke 垂直切片验证",
          kind: "oren_judgment",
          confidence: 0.8,
        },
        { type: "ScheduleWake", scheduleId: "smoke-wake", at: FUTURE_WAKE, purpose: "Revisit" },
      ],
      usage: { totalTokens: 7 },
    };
  });
}

describe("runSmoke", () => {
  it("exits 0 with instructions when model env is unconfigured", async () => {
    const lines: string[] = [];
    const code = await runSmoke(
      { OREN_CONFIG_SEARCH_FROM: mkdtempSync(join(tmpdir(), "oren-smoke-empty-")) },
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("OREN_MODEL_PROVIDER");
    expect(lines.join("\n")).toContain("OREN_MODEL_ID");
  });

  it("exits 1 with the reason when model env is invalid", async () => {
    const lines: string[] = [];
    const code = await runSmoke(
      { OREN_MODEL_PROVIDER: "no-such-provider", OREN_MODEL_ID: "x" },
      (line) => lines.push(line),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("no-such-provider");
  });

  it("runs the vertical slice and verifies restart replay with injected cognition", async () => {
    const lines: string[] = [];
    const databasePath = join(mkdtempSync(join(tmpdir(), "oren-smoke-")), "life.db");
    const code = await runSmoke(
      { OREN_SMOKE_DB: databasePath },
      (line) => lines.push(line),
      scriptedCognition(),
    );
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("restart replay matched");
    expect(output).toContain("memories recallable after restart");
    expect(output).toContain("waiting_for_effect");
    expect(output).toContain("ScheduleWake");
    expect(output).toContain("totalTokens");
  });
});
