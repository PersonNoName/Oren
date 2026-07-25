import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
} from "@oren/cognition";
import type { Proposal } from "@oren/kernel";
import { PiCognitionAdapter, resolveModelConfig } from "@oren/pi-cognition";
import { LifeRuntime } from "./life-runtime.js";

export interface EpisodeRecord {
  readonly trigger: string;
  readonly kind: CognitionOutcome["kind"];
  readonly proposals: readonly Proposal[];
  readonly totalTokens: number;
}

class RecordingCognition implements CognitionPort {
  public readonly episodes: EpisodeRecord[] = [];

  public constructor(private readonly inner: CognitionPort) {}

  public async run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome> {
    const outcome = await this.inner.run(frame, capabilityPort, signal);
    this.episodes.push({
      trigger: frame.trigger.kind,
      kind: outcome.kind,
      proposals: outcome.kind === "completed" ? outcome.proposals : [],
      totalTokens: outcome.usage.totalTokens,
    });
    return outcome;
  }
}

export async function runSmoke(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  cognitionOverride?: CognitionPort,
): Promise<number> {
  let inner: CognitionPort;
  if (cognitionOverride) {
    inner = cognitionOverride;
  } else {
    const config = resolveModelConfig(env);
    if (!config.ok) {
      log(config.reason);
      return config.kind === "unconfigured" ? 0 : 1;
    }
    inner = new PiCognitionAdapter({
      model: config.model,
      streamFn: config.streamFn,
    });
  }

  const recorder = new RecordingCognition(inner);
  const databasePath = env.OREN_SMOKE_DB
    ?? join(mkdtempSync(join(tmpdir(), "oren-smoke-")), "life.db");

  const first = await LifeRuntime.create(databasePath, recorder);
  try {
    await first.initialize("oren-smoke", "person-smoke");
    await first.receiveUserMessage(
      "oren-smoke",
      "person-smoke",
      "请读取计数器，把它加一，然后安排一次后续查看。",
    );
    await first.drain();
    const beforeRestart = first.inspect("oren-smoke");
    await first.close();

    const second = await LifeRuntime.create(databasePath, recorder);
    try {
      await second.drain();
      const afterRestart = second.inspect("oren-smoke");
      for (const episode of recorder.episodes) {
        log(`episode trigger=${episode.trigger} outcome=${episode.kind} `
          + `totalTokens=${episode.totalTokens}`);
        for (const proposal of episode.proposals) {
          log(`  proposal ${JSON.stringify(proposal)}`);
        }
      }
      const totalTokens = recorder.episodes.reduce(
        (sum, { totalTokens: tokens }) => sum + tokens,
        0,
      );
      log(`total totalTokens=${totalTokens}`);
      if (JSON.stringify(afterRestart) !== JSON.stringify(beforeRestart)) {
        log("FAIL: durable replay did not reproduce the pre-restart LifeState");
        return 1;
      }
      log("Oren smoke completed; restart replay matched");
      return 0;
    } finally {
      await second.close();
    }
  } catch (error) {
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await first.close();
    } catch {
      // already closed or failing; the smoke exit code carries the signal
    }
    return 1;
  }
}
