import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeRuntime } from "@oren/app";
import { PanelInboxAdapter } from "@oren/channel";
import type { CognitionPort } from "@oren/cognition";
import type { OrenExtension } from "@oren/extensions";
import { FakeEmbedder } from "@oren/memory";
import {
  createInitialLifeState,
  reachabilityOf,
  type Grant,
  type LifeState,
} from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { createTestCounterExtension } from "@oren/test-counter";
import { ScriptedWebAdapter } from "@oren/web";
import {
  defaultAssertions,
  type AssertionFn,
} from "./assertions.js";
import { VirtualClock } from "./clock.js";
import {
  GatedChannelPort,
  GatedWebPort,
  type NetworkGate,
} from "./network-gate.js";
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

type SimSession = {
  readonly scenario: ScenarioDefinition;
  readonly orenId: string;
  readonly personId: string;
  readonly dbPath: string;
  readonly clock: VirtualClock;
  readonly nextId: () => string;
  cognitionKey: string;
  extensionKey: string;
  readonly gate: NetworkGate;
  readonly innerWebPort: ScriptedWebAdapter;
  innerChannelPort: PanelInboxAdapter;
  runtime: LifeRuntime;
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

function resolveExtensionFactory(session: SimSession): () => OrenExtension {
  const factories = session.scenario.extensionFactories;
  if (factories) {
    const factory = factories[session.extensionKey];
    if (factory) {
      return factory;
    }
  }
  if (session.extensionKey === "default") {
    return createTestCounterExtension;
  }
  throw new Error(`Unknown extension version: ${session.extensionKey}`);
}

function resolveCognition(session: SimSession): CognitionPort {
  const cognition = session.scenario.scripts[session.cognitionKey];
  if (!cognition) {
    throw new Error(`Unknown script: ${session.cognitionKey}`);
  }
  return cognition;
}

async function createRuntime(session: SimSession): Promise<LifeRuntime> {
  session.innerChannelPort = new PanelInboxAdapter(() => session.clock.now());
  const webPort = new GatedWebPort(session.innerWebPort, session.gate);
  const channelPort = new GatedChannelPort(session.innerChannelPort, session.gate);
  return LifeRuntime.create(session.dbPath, resolveCognition(session), {
    now: () => session.clock.now(),
    nextId: session.nextId,
    embedder: new FakeEmbedder(),
    webPort,
    channelPort,
    extensionFactory: resolveExtensionFactory(session),
  });
}

async function restartRuntime(session: SimSession): Promise<void> {
  await session.runtime.close();
  session.runtime = await createRuntime(session);
}

export class ScenarioRunner {
  public constructor(
    private readonly assertions: Readonly<Record<string, AssertionFn>> = defaultAssertions,
  ) {}

  public async run(scenario: ScenarioDefinition): Promise<SimReport> {
    const orenId = scenario.orenId ?? "oren-1";
    const personId = scenario.personId ?? "person-1";
    const assertions: Array<{
      readonly name: string;
      readonly ok: boolean;
      readonly detail?: string;
    }> = [];
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

    const session: SimSession = {
      scenario,
      orenId,
      personId,
      dbPath,
      clock,
      nextId,
      cognitionKey: "default",
      extensionKey: "default",
      gate: { failing: false, web: true, channel: true },
      innerWebPort: createScriptedWebAdapter(),
      innerChannelPort: new PanelInboxAdapter(() => clock.now()),
      runtime: undefined as unknown as LifeRuntime,
    };

    const defaultScript = scenario.scripts.default;
    if (!defaultScript) {
      throw new Error("Scenario requires scripts.default");
    }

    session.runtime = await createRuntime(session);

    try {
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        try {
          await this.executeStep(step, {
            session,
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
      await session.runtime.close();
    }
  }

  private async executeStep(
    step: SimStep,
    context: {
      readonly session: SimSession;
      readonly checkpoints: Map<string, LifeState>;
      readonly assertions: Array<{
        readonly name: string;
        readonly ok: boolean;
        readonly detail?: string;
      }>;
    },
  ): Promise<void> {
    const { session, checkpoints, assertions } = context;
    const { runtime, orenId, personId, clock } = session;

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
            runtime: session.runtime,
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

      case "revokeGrant":
        runtime.revokeGrant(step.grantId, step.reason);
        return;

      case "setReachability": {
        const current = reachabilityOf(runtime.inspect(orenId));
        runtime.updateReachabilityPolicy({
          quietHours: step.quietHours === null
            ? null
            : { ...step.quietHours, timezone: "UTC" },
          maxProactivePerDay: step.maxProactivePerDay ?? current.maxProactivePerDay,
          deferWhenQuiet: true,
        }, "sim");
        return;
      }

      case "failNetwork": {
        session.gate.failing = step.failing;
        if (step.failing) {
          if (step.targets !== undefined) {
            session.gate.web = step.targets.includes("web");
            session.gate.channel = step.targets.includes("channel");
          } else {
            session.gate.web = true;
            session.gate.channel = true;
          }
        } else {
          session.gate.web = true;
          session.gate.channel = true;
        }
        return;
      }

      case "restart":
        await restartRuntime(session);
        return;

      case "swapCognition": {
        if (!session.scenario.scripts[step.scriptId]) {
          throw new Error(`Unknown script: ${step.scriptId}`);
        }
        session.cognitionKey = step.scriptId;
        await restartRuntime(session);
        return;
      }

      case "swapExtension": {
        const factories = session.scenario.extensionFactories;
        if (!factories?.[step.version]) {
          throw new Error(`Unknown extension version: ${step.version}`);
        }
        session.extensionKey = step.version;
        await restartRuntime(session);
        return;
      }

      default: {
        const _exhaustive: never = step;
        throw new Error(`Unknown step type: ${(_exhaustive as SimStep).type}`);
      }
    }
  }
}
