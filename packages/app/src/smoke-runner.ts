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
import { resolveWebConfig } from "@oren/web";
import { LifeRuntime } from "./life-runtime.js";

export interface EpisodeRecord {
  readonly trigger: string;
  readonly kind: CognitionOutcome["kind"];
  readonly proposals: readonly Proposal[];
  readonly totalTokens: number;
}

function assertVerticalSliceEpisodes(
  episodes: readonly EpisodeRecord[],
): readonly string[] {
  const waitingIndex = episodes.findIndex(({ kind }) => kind === "waiting_for_effect");
  if (waitingIndex === -1) {
    return ["expected at least one waiting_for_effect episode (durable effect invocation)"];
  }
  const completedAfterEffect = episodes
    .slice(waitingIndex + 1)
    .find(({ kind }) => kind === "completed");
  if (!completedAfterEffect) {
    return ["expected a completed episode after waiting_for_effect"];
  }
  const hasScheduleWake = completedAfterEffect.proposals.some(
    ({ type }) => type === "ScheduleWake",
  );
  if (!hasScheduleWake) {
    return [
      "expected the post-effect completed episode to include a ScheduleWake proposal",
    ];
  }
  return [];
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

  // Smoke against a real (uninjected) model is the credential-gated manual
  // path: real embeddings are allowed there when OREN_EMBEDDING_* + a
  // provider API key are intentionally exported. Automated tests always
  // inject `cognitionOverride`, so they never consult process.env for
  // embeddings and stay offline even if those variables happen to be set.
  const webConfig = resolveWebConfig(env);
  const useProcessEnv = cognitionOverride === undefined;
  const runtimeOptions = {
    useProcessEmbeddingEnv: useProcessEnv,
    useProcessWebEnv: useProcessEnv && webConfig.ok,
  };
  const first = await LifeRuntime.create(databasePath, recorder, runtimeOptions);
  try {
    await first.initialize("oren-smoke", "person-smoke");
    await first.receiveUserMessage(
      "oren-smoke",
      "person-smoke",
      "请读取计数器，把它加一，记住一个关于这个计数器用途的判断，然后安排一次后续查看。",
    );
    await first.drain();
    const beforeRestart = first.inspect("oren-smoke");
    await first.close();

    const second = await LifeRuntime.create(databasePath, recorder, runtimeOptions);
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
      const sliceFailures = assertVerticalSliceEpisodes(recorder.episodes);
      if (sliceFailures.length > 0) {
        for (const failure of sliceFailures) {
          log(`FAIL: ${failure}`);
        }
        return 1;
      }
      const memories = await second.recall("oren-smoke", { limit: 50 });
      if (memories.length === 0) {
        log("FAIL: expected recallable memories after restart");
        return 1;
      }
      log(`memories recallable after restart: ${memories.length}`);
      if (webConfig.ok && cognitionOverride === undefined) {
        const webQuota = afterRestart.budgets.webQuotaRemaining ?? 8;
        const webFacts = await second.recall("oren-smoke", {
          kinds: ["external_fact"],
          limit: 10,
        });
        if (webQuota < 8 || webFacts.length > 0) {
          log(`web path verified: quotaRemaining=${webQuota} externalFacts=${webFacts.length}`);
        } else {
          log("web configured; no web usage observed in this smoke run");
        }
      }
      const snapshot = second.getPanelSnapshot();
      if (snapshot.inbox.length > 0) {
        log(`panel inbox deliveries: ${snapshot.inbox.length}`);
        for (const message of snapshot.inbox) {
          log(`  delivery ${message.deliveryId} status=${message.status} proactive=${message.proactive}`);
        }
      }
      if (snapshot.commitments.length > 0) {
        log(`panel commitments: ${snapshot.commitments.length}`);
        for (const commitment of snapshot.commitments) {
          log(`  commitment ${commitment.commitmentId} status=${commitment.status} goal=${commitment.goal}`);
        }
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
