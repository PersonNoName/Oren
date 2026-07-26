import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeRuntime } from "@oren/app";
import { PanelInboxAdapter } from "@oren/channel";
import type { CognitionPort } from "@oren/cognition";
import type { OrenExtension } from "@oren/extensions";
import { createInitialLifeState, type Grant, type LifeState } from "@oren/kernel";
import { FakeEmbedder } from "@oren/memory";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { createTestCounterExtension } from "@oren/test-counter";
import { ScriptedWebAdapter } from "@oren/web";
import {
  defaultAssertions,
  type AssertionFn,
} from "./assertions.js";
import { VirtualClock } from "./clock.js";
import type { SimStep } from "./steps.js";

export type ScenarioDefinition = {
  readonly id: string;
  readonly orenId?: string;
  readonly personId?: string;
  readonly startIso?: string;
  readonly autonomyRemaining?: number;
  readonly scripts: Readonly<Record<string, CognitionPort>>;
  readonly extensionFactories?: Readonly<Record<string, () => OrenExtension>>;
  readonly steps: readonly SimStep[];
};

export type SimReport = {
  readonly scenarioId: string;
  readonly ok: boolean;
  readonly stepsCompleted: number;
  readonly error?: string;
  readonly assertions: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly detail?: string;
  }[];
};

function sequenceIds(prefix = "id"): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function createScriptedWebAdapter(): ScriptedWebAdapter {
  return new ScriptedWebAdapter({
    search: () => ({
      results: [{ title: "Hit", url: "https://example.com/a", snippet: "s" }],
    }),
    read: () => ({
      url: "https://example.com/a",
      title: "A",
      text: "body ".repeat(20),
    }),
  });
}

export class ScenarioRunner {
  public constructor(
    private readonly assertions: Readonly<Record<string, AssertionFn>> = defaultAssertions,
  ) {}

  public async run(scenario: ScenarioDefinition): Promise<SimReport> {
    const orenId = scenario.orenId ?? "oren-1";
    const personId = scenario.personId ?? "person-1";
    const assertions: SimReport["assertions"] = [];
    const checkpoints = new Map<string, LifeState>();
    let stepsCompleted = 0;

    const tempDir = mkdtempSync(join(tmpdir(), "oren-sim-"));
    const dbPath = join(tempDir, "life.db");
    const clock = new VirtualClock(scenario.startIso);
    const nextId = sequenceIds();

    // Bootstrap (see task brief): seed identity + grant in SQLite, then open
    // LifeRuntime without calling initialize again.
    const bootstrapDb = openDatabase(dbPath);
    const bootstrapRepo = new SqliteLifeRepository(
      bootstrapDb,
      () => clock.now(),
      nextId,
    );
    const grant: Grant = {
      grantId: `runtime:${orenId}:test-counter`,
      capabilityPattern: "test.*",
      expiresAt: "9999-12-31T23:59:59.999Z",
      revoked: false,
    };
    bootstrapRepo.initializeWithGrant(
      {
        ...createInitialLifeState(orenId, personId),
        budgets: {
          autonomyRemaining: scenario.autonomyRemaining ?? 64,
          interactionMaxSteps: 8,
          commitmentRemaining: {},
          webQuotaRemaining: 8,
        },
      },
      grant,
    );
    bootstrapRepo.close();

    const webPort = createScriptedWebAdapter();
    const channelPort = new PanelInboxAdapter(() => clock.now());
    const extensionFactory = (
      scenario.extensionFactories?.default ?? createTestCounterExtension
    );

    const runtime = await LifeRuntime.create(dbPath, scenario.scripts.default, {
      now: () => clock.now(),
      nextId,
      embedder: new FakeEmbedder(),
      webPort,
      channelPort,
      extensionFactory,
    });

    try {
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        try {
          await this.executeStep(step, {
            runtime,
            orenId,
            personId,
            clock,
            checkpoints,
            assertions,
          });
          stepsCompleted += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            scenarioId: scenario.id,
            ok: false,
            stepsCompleted,
            error: `Step ${index}: ${message}`,
            assertions,
          };
        }
      }

      return {
        scenarioId: scenario.id,
        ok: true,
        stepsCompleted,
        assertions,
      };
    } finally {
      await runtime.close();
    }
  }

  private async executeStep(
    step: SimStep,
    context: {
      readonly runtime: LifeRuntime;
      readonly orenId: string;
      readonly personId: string;
      readonly clock: VirtualClock;
      readonly checkpoints: Map<string, LifeState>;
      readonly assertions: Array<{
        readonly name: string;
        readonly ok: boolean;
        readonly detail?: string;
      }>;
    },
  ): Promise<void> {
    const { runtime, orenId, personId, clock, checkpoints, assertions } = context;

    switch (step.type) {
      case "message":
        await runtime.receiveUserMessage(orenId, personId, step.text);
        await runtime.drain();
        return;

      case "advance": {
        const hasMs = step.ms !== undefined;
        const hasTo = step.to !== undefined;
        if (hasMs === hasTo) {
          throw new Error("advance step requires exactly one of ms or to");
        }
        if (hasMs) {
          clock.advanceBy(step.ms!);
        } else {
          clock.advanceTo(step.to!);
        }
        if (step.drain !== false) {
          await runtime.drain();
        }
        return;
      }

      case "checkpoint":
        checkpoints.set(
          step.name,
          structuredClone(runtime.inspect(orenId)),
        );
        return;

      case "assert": {
        const fn = this.assertions[step.name];
        if (!fn) {
          throw new Error(`Unknown assertion: ${step.name}`);
        }
        try {
          await fn({
            runtime,
            orenId,
            checkpoints,
            clock,
            args: step.args ?? {},
          });
          assertions.push({ name: step.name, ok: true });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          assertions.push({ name: step.name, ok: false, detail });
          throw new Error(detail);
        }
        return;
      }

      case "restart":
      case "swapCognition":
      case "swapExtension":
      case "revokeGrant":
      case "failNetwork":
      case "setReachability":
        throw new Error("not implemented in Task 2");

      default: {
        const _exhaustive: never = step;
        throw new Error(`Unknown step type: ${(_exhaustive as SimStep).type}`);
      }
    }
  }
}
