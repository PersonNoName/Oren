import { createTestCounterExtension } from "@oren/test-counter";
import type { OrenExtension } from "@oren/extensions";
import { describe, expect, it } from "vitest";
import { createSequencedCognition, ScenarioRunner } from "../src/index.js";

function versionedTestCounter(version: string): () => OrenExtension {
  return () => {
    const extension = createTestCounterExtension();
    return {
      ...extension,
      manifest: { ...extension.manifest, version },
    };
  };
}

describe("ScenarioRunner fault steps", () => {
  it("revokes grant and asserts grantGone", async () => {
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-revoke",
      scripts: {
        default: createSequencedCognition([{ proposals: [{ type: "NoAction", reason: "n" }] }]),
      },
      steps: [
        { type: "revokeGrant", grantId: "runtime:oren-1:test-counter", reason: "sim revoke" },
        { type: "assert", name: "grantGone", args: { grantId: "runtime:oren-1:test-counter" } },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("restarts and replayMatches", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "AdvanceThread", threadId: "t1", summary: "clue" },
          { type: "NoAction", reason: "d" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-restart",
      scripts: { default: cognition },
      steps: [
        { type: "message", text: "go" },
        { type: "checkpoint", name: "pre" },
        { type: "restart" },
        { type: "assert", name: "replayMatches", args: { before: "pre" } },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("failNetwork on channel records delivery failure path without throwing runner", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "ExpressToUser", text: "ping", reason: "n" },
          { type: "NoAction", reason: "d" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-net",
      startIso: "2026-01-01T12:00:00.000Z",
      scripts: { default: cognition },
      steps: [
        { type: "setReachability", quietHours: null, maxProactivePerDay: 10 },
        { type: "failNetwork", failing: true, targets: ["channel"] },
        { type: "message", text: "hi" },
        { type: "failNetwork", failing: false },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("swapExtension restarts with a different extension version", async () => {
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-swap-ext",
      scripts: {
        default: createSequencedCognition([{ proposals: [{ type: "NoAction", reason: "n" }] }]),
      },
      extensionFactories: {
        "1.0.0": versionedTestCounter("1.0.0"),
        "1.1.0": versionedTestCounter("1.1.0"),
      },
      steps: [
        { type: "swapExtension", version: "1.1.0" },
        { type: "assert", name: "ok" },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("swapCognition restarts with a different cognition script", async () => {
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-swap-cog",
      scripts: {
        default: createSequencedCognition([
          { proposals: [{ type: "NoAction", reason: "default" }] },
        ]),
        "model-b": createSequencedCognition([
          {
            proposals: [
              { type: "AdvanceThread", threadId: "t1", summary: "model-b" },
              { type: "NoAction", reason: "model-b done" },
            ],
          },
        ]),
      },
      steps: [
        { type: "message", text: "go" },
        { type: "swapCognition", scriptId: "model-b" },
        { type: "message", text: "continue" },
        { type: "assert", name: "threadContinues" },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("failNetwork clearing restores default web and channel gates", async () => {
    const cognition = createSequencedCognition([
      {
        proposals: [
          { type: "ExpressToUser", text: "ping", reason: "n" },
          { type: "NoAction", reason: "d" },
        ],
      },
    ]);
    const runner = new ScenarioRunner();
    const report = await runner.run({
      id: "t4-net-reset",
      startIso: "2026-01-01T12:00:00.000Z",
      scripts: { default: cognition },
      steps: [
        { type: "setReachability", quietHours: null, maxProactivePerDay: 10 },
        { type: "failNetwork", failing: true, targets: ["web"] },
        { type: "failNetwork", failing: false },
        { type: "message", text: "hi" },
        { type: "assert", name: "shareDelivered", args: { textIncludes: "ping" } },
      ],
    });
    expect(report.ok).toBe(true);
  });
});
