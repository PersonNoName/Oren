import { describe, expect, it } from "vitest";
import { EpisodeCoordinator } from "../src/index.js";

describe("EpisodeCoordinator", () => {
  it("aborts an idle episode before starting foreground cognition", async () => {
    const transitions: string[] = [];
    const coordinator = new EpisodeCoordinator(async (job, signal) => {
      transitions.push(`start:${job.triggerKind}`);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        transitions.push(`abort:${job.triggerKind}`);
        resolve();
      }, { once: true }));
    });

    void coordinator.start({
      orenId: "oren-1",
      episodeId: "background",
      baseStateVersion: 1,
      triggerKind: "health_check",
      correlationId: "corr-background",
    });
    await coordinator.start({
      orenId: "oren-1",
      episodeId: "foreground",
      baseStateVersion: 2,
      triggerKind: "foreground_user",
      correlationId: "corr-foreground",
    });

    expect(transitions.slice(0, 3)).toEqual([
      "start:health_check",
      "abort:health_check",
      "start:foreground_user",
    ]);
  });

  it("awaits aborted cleanup before running the deterministic highest-priority pending job", async () => {
    const transitions: string[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const coordinator = new EpisodeCoordinator(async (job, signal) => {
      transitions.push(`start:${job.episodeId}`);
      if (job.episodeId === "background") {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        transitions.push(`cleanup:${String(signal.reason)}`);
        await cleanup;
      }
    });

    await coordinator.start(job("background", "health_check"));
    const wake = coordinator.start(job("wake", "scheduled_wake"));
    const effect = coordinator.start(job("effect", "effect_result"));
    await Promise.resolve();
    expect(transitions).toEqual([
      "start:background",
      "cleanup:trigger_priority",
    ]);

    releaseCleanup();
    await effect;
    expect(transitions).toEqual([
      "start:background",
      "cleanup:trigger_priority",
      "start:effect",
    ]);
    await wake;
    expect(transitions.at(-1)).toBe("start:wake");
  });

  it("queues lower-priority durable work instead of dropping it", async () => {
    const transitions: string[] = [];
    let releaseForeground!: () => void;
    const foregroundDone = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const coordinator = new EpisodeCoordinator(async (candidate) => {
      transitions.push(candidate.episodeId);
      if (candidate.episodeId === "foreground") await foregroundDone;
    });

    await coordinator.start(job("foreground", "foreground_user"));
    const background = coordinator.start(job("background", "health_check"));
    await Promise.resolve();
    expect(transitions).toEqual(["foreground"]);

    releaseForeground();
    await background;
    expect(transitions).toEqual(["foreground", "background"]);
  });

  it("contains an aborted episode rejection and still starts its foreground replacement", async () => {
    const transitions: string[] = [];
    const coordinator = new EpisodeCoordinator(async (candidate, signal) => {
      transitions.push(`start:${candidate.episodeId}`);
      if (candidate.episodeId === "background") {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cleanup failed")), { once: true });
        });
      }
    });

    await coordinator.start(job("background", "health_check"));
    await expect(coordinator.start(job("foreground", "foreground_user"))).resolves.toBeUndefined();
    await expect(coordinator.waitForIdle("oren-1")).resolves.toBeUndefined();
    expect(transitions).toEqual(["start:background", "start:foreground"]);
  });

  it("allows different Orens to run concurrently", async () => {
    const active = new Set<string>();
    let observedConcurrent = false;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new EpisodeCoordinator(async (candidate) => {
      active.add(candidate.orenId);
      observedConcurrent ||= active.size === 2;
      await done;
      active.delete(candidate.orenId);
    });

    await coordinator.start(job("episode-a", "foreground_user", "oren-a"));
    await coordinator.start(job("episode-b", "foreground_user", "oren-b"));
    expect(observedConcurrent).toBe(true);
    release();
    await Promise.all([
      coordinator.waitForIdle("oren-a"),
      coordinator.waitForIdle("oren-b"),
    ]);
  });

  it("installs the active slot before a run callback can reentrantly enqueue work", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let coordinator!: EpisodeCoordinator;
    coordinator = new EpisodeCoordinator(async (candidate) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (candidate.episodeId === "first") {
        void coordinator.start(job("second", "health_check"));
        await firstDone;
      }
      active -= 1;
    });

    await coordinator.start(job("first", "health_check"));
    expect(maximumActive).toBe(1);
    releaseFirst();
    await coordinator.waitForIdle("oren-1");
    expect(maximumActive).toBe(1);
  });
});

function job(
  episodeId: string,
  triggerKind: "foreground_user" | "effect_result" | "scheduled_wake" | "health_check",
  orenId = "oren-1",
) {
  return {
    orenId,
    episodeId,
    baseStateVersion: 1,
    triggerKind,
    correlationId: `corr:${episodeId}`,
  } as const;
}
