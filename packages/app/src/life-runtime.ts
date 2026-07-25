import { randomUUID } from "node:crypto";
import {
  Conductor,
  ScriptedCognitionAdapter,
  type CognitionPort,
} from "@oren/cognition";
import {
  CapabilityBroker,
  ExtensionRegistry,
  type OrenExtension,
} from "@oren/extensions";
import {
  canonicalizeInstant,
  createInitialLifeState,
  Guard,
  LifeActor,
  type CognitionJob,
  type LifeState,
} from "@oren/kernel";
import { openDatabase, SqliteLifeRepository } from "@oren/storage";
import { createTestCounterExtension } from "@oren/test-counter";
import { CognitionWorker } from "./cognition-worker.js";
import { EffectDispatcher } from "./effect-dispatcher.js";
import { EpisodeCoordinator } from "./episode-coordinator.js";
import { Scheduler } from "./scheduler.js";

const DEFAULT_MAX_DRAIN_CYCLES = 64;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const GRANT_EXPIRY = "9999-12-31T23:59:59.999Z";

interface RuntimeIdentity {
  readonly orenId: string;
  readonly personId: string;
}

export interface LifeRuntimeOptions {
  readonly now?: () => string;
  readonly nextId?: () => string;
  readonly extensionFactory?: () => OrenExtension;
  readonly maxDrainCycles?: number;
  readonly shutdownGraceMs?: number;
}

export class LifeRuntime {
  private identity: RuntimeIdentity | undefined;
  private readonly knownOrenIds = new Set<string>();
  private closePromise: Promise<void> | undefined;
  private activeDrain: Promise<void> | undefined;
  private readonly workflowTails = new Map<string, Promise<void>>();
  private closing = false;
  private closed = false;

  private constructor(
    private readonly repository: SqliteLifeRepository,
    private readonly actor: LifeActor,
    private readonly coordinator: EpisodeCoordinator,
    private readonly dispatcher: EffectDispatcher,
    private readonly scheduler: Scheduler,
    private readonly extension: OrenExtension,
    private readonly now: () => string,
    private readonly maxDrainCycles: number,
    private readonly shutdownGraceMs: number,
    private readonly runtimeGate: { closed: boolean },
  ) {
    const identities = repository.listLifeIdentities();
    if (identities.length > 1) {
      throw new Error("LifeRuntime requires a database containing at most one Oren identity");
    }
    this.identity = identities[0];
    if (this.identity) this.knownOrenIds.add(this.identity.orenId);
  }

  public static createDeterministic(
    databasePath: string,
    options: LifeRuntimeOptions = {},
  ): Promise<LifeRuntime> {
    const cognition = new ScriptedCognitionAdapter(
      async (frame, capabilityPort, signal) => {
        if (frame.trigger.kind === "foreground_user") {
          const read = frame.capabilities.find(({ name }) => name === "test.read");
          const increment = frame.capabilities.find(({ name }) => name === "test.increment");
          if (!read || !increment) {
            return {
              kind: "failed",
              message: "Test capabilities missing",
              usage: { totalTokens: 0 },
            };
          }
          const observed = await capabilityPort.invoke({
            orenId: frame.orenId,
            descriptor: read,
            arguments: {},
            stateVersion: frame.stateVersion,
            correlationId: frame.correlationId,
          }, signal);
          if (observed.kind !== "completed") {
            return {
              kind: "failed",
              message: "Expected immediate counter read",
              usage: { totalTokens: 0 },
            };
          }
          const pending = await capabilityPort.invoke({
            orenId: frame.orenId,
            descriptor: increment,
            arguments: { by: 1 },
            stateVersion: frame.stateVersion,
            correlationId: frame.correlationId,
          }, signal);
          return pending.kind === "waiting_for_effect"
            ? { ...pending, usage: { totalTokens: 0 } }
            : {
                kind: "failed",
                message: "Expected durable counter increment",
                usage: { totalTokens: 0 },
              };
        }
        if (frame.trigger.kind === "effect_result") {
          return {
            kind: "completed",
            proposals: [
              {
                type: "AdvanceThread",
                threadId: "counter",
                summary: "Understand the counter lifecycle",
              },
              {
                type: "ScheduleWake",
                scheduleId: "counter-follow-up",
                at: FUTURE_WAKE,
                purpose: "Revisit the counter",
              },
            ],
            usage: { totalTokens: 0 },
          };
        }
        return {
          kind: "completed",
          proposals: [{ type: "NoAction", reason: "Durable wake observed" }],
          usage: { totalTokens: 0 },
        };
      },
    );
    return LifeRuntime.create(databasePath, cognition, options);
  }

  public static async create(
    databasePath: string,
    cognition: CognitionPort,
    options: LifeRuntimeOptions = {},
  ): Promise<LifeRuntime> {
    const rawNow = options.now ?? (() => new Date().toISOString());
    const now = (): string => {
      const canonical = canonicalizeInstant(rawNow());
      if (!canonical) throw new Error("LifeRuntime clock must return a valid instant");
      return canonical;
    };
    const localNextId = options.nextId ?? randomUUID;
    const bootNonce = randomUUID();
    const nextId = (): string => `${bootNonce}:${localNextId()}`;
    const maxDrainCycles = options.maxDrainCycles ?? DEFAULT_MAX_DRAIN_CYCLES;
    if (!Number.isSafeInteger(maxDrainCycles) || maxDrainCycles <= 0) {
      throw new Error("maxDrainCycles must be a positive safe integer");
    }
    const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0) {
      throw new Error("shutdownGraceMs must be a nonnegative safe integer");
    }

    const repository = new SqliteLifeRepository(openDatabase(databasePath), now, nextId);
    let extension: OrenExtension | undefined;
    let activationAttempted = false;
    try {
      extension = (options.extensionFactory ?? createTestCounterExtension)();
      const registry = new ExtensionRegistry();
      registry.register(extension);
      activationAttempted = true;
      await extension.activate({
        extensionId: extension.manifest.id,
        reportProgress() {},
        emitObservation() {},
      });

      const actor = new LifeActor(repository, nextId, now);
      const guard = new Guard();
      const runtimeGate = { closed: false };
      const broker = new CapabilityBroker(
        registry,
        (effect) => actor.requestEffect(
          effect.orenId,
          effect.correlationId,
          effect,
        ).accepted,
        (input) => guard.evaluateCapability({
          capability: input.capability,
          grants: repository.loadGrants(input.orenId).filter(
            ({ grantId }) => input.grantIds.includes(grantId),
          ),
          now: now(),
        }).allowed,
        () => Date.parse(now()),
      );
      const worker = new CognitionWorker(
        cognition,
        new Conductor(),
        actor,
        guard,
        (job) => ({
          state: repository.loadState(job.orenId),
          correlationId: job.correlationId,
          trigger: { kind: job.triggerKind, summary: job.correlationId },
          capabilities: registry.listCapabilities(),
          maxSteps: 8,
        }),
        {
          invoke: (
            { orenId, descriptor, arguments: arguments_, stateVersion, correlationId },
          ) => runtimeGate.closed
            ? Promise.resolve({ kind: "rejected", reason: "runtime_closed" })
            : broker.invoke({
                orenId,
                correlationId,
                capability: descriptor.name,
                arguments: arguments_,
                grantIds: repository.loadGrants(orenId).map(({ grantId }) => grantId),
                stateVersion,
                effectId: nextId(),
              }),
        },
      );
      const coordinator = new EpisodeCoordinator(
        (job, signal) => worker.run(job, signal),
      );
      const dispatcher = new EffectDispatcher(
        repository,
        registry,
        `life-runtime:${nextId()}`,
        { now: () => Date.parse(now()) },
      );
      return new LifeRuntime(
        repository,
        actor,
        coordinator,
        dispatcher,
        new Scheduler(repository, { now }),
        extension,
        now,
        maxDrainCycles,
        shutdownGraceMs,
        runtimeGate,
      );
    } catch (primaryError) {
      const cleanupErrors: unknown[] = [];
      if (extension && activationAttempted) {
        try {
          await extension.deactivate();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        repository.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          "LifeRuntime initialization and cleanup both failed",
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
  }

  public async initialize(orenId: string, personId: string): Promise<void> {
    this.assertOpen();
    const requested = { orenId, personId };
    const existing = this.identity ?? this.repository.listLifeIdentities()[0];
    if (
      existing
      && (existing.orenId !== requested.orenId || existing.personId !== requested.personId)
    ) {
      throw new Error(
        `LifeRuntime identity conflict: expected ${existing.orenId}/${existing.personId}`,
      );
    }
    this.repository.initializeWithGrant(createInitialLifeState(orenId, personId), {
      grantId: `runtime:${orenId}:test-counter`,
      capabilityPattern: "test.*",
      expiresAt: GRANT_EXPIRY,
      revoked: false,
    });
    this.identity = requested;
    this.knownOrenIds.add(orenId);
  }

  public async receiveUserMessage(
    orenId: string,
    personId: string,
    text: string,
  ): Promise<void> {
    this.assertOpen();
    this.assertIdentity(orenId, personId);
    await this.withOrenWorkflow(orenId, async () => {
      const job = this.actor.handleUserMessage(orenId, personId, text);
      await this.runJob(job);
    });
  }

  public async drain(): Promise<void> {
    this.assertOpen();
    if (this.activeDrain) {
      await this.activeDrain;
      return;
    }
    const running = this.drainToFixedPoint();
    const tracked = running.finally(() => {
      if (this.activeDrain === tracked) this.activeDrain = undefined;
    });
    this.activeDrain = tracked;
    await tracked;
  }

  public inspect(orenId: string): LifeState {
    this.assertOpen();
    if (this.identity && this.identity.orenId !== orenId) {
      throw new Error(`LifeRuntime identity conflict: expected ${this.identity.orenId}`);
    }
    return this.repository.loadState(orenId);
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.runtimeGate.closed = true;
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private async drainToFixedPoint(): Promise<void> {
    let productiveCycles = 0;
    while (!this.closing) {
      let activity = 0;
      const recovered = this.repository.loadPendingCognitionJobs();
      if (recovered.length > 0) {
        const recoveredRuns = await Promise.all(recovered.map((job) =>
          this.withOrenWorkflow(job.orenId, async () => {
            if (!this.repository.isPendingCognitionJob(job)) return false;
            await this.runJob(job);
            return true;
          })));
        activity += recoveredRuns.filter(Boolean).length;
      }

      activity += this.scheduler.runOnce(this.now());
      activity += (await this.dispatcher.runOnce()).length;

      const claimed = this.repository.claimInbox(
        "life-runtime-inbox",
        this.now(),
        32,
      );
      activity += claimed.length;
      await Promise.all(claimed.map((inbox) => this.withOrenWorkflow(
        inbox.orenId,
        async () => {
          try {
            this.knownOrenIds.add(inbox.orenId);
            const job = this.actor.handleInbox(inbox);
            if (job) await this.runJob(job);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown Inbox failure";
            try {
              this.repository.quarantineInbox(
                inbox.inboxId,
                inbox.leaseOwner,
                inbox.leaseToken,
                `LifeActor rejected Inbox row: ${message}`,
                this.now(),
              );
            } catch {
              // A failed quarantine remains protected by its current durable lease.
            }
          }
        },
      )));

      if (activity === 0) return;
      productiveCycles += 1;
      if (productiveCycles >= this.maxDrainCycles) {
        if (!this.repository.hasImmediateWork(this.now())) return;
        throw new Error(
          `LifeRuntime did not quiesce within ${this.maxDrainCycles} productive cycles`,
        );
      }
    }
  }

  private async runJob(job: CognitionJob): Promise<void> {
    this.knownOrenIds.add(job.orenId);
    await this.coordinator.start(job);
    await this.coordinator.waitForIdle(job.orenId);
  }

  private async withOrenWorkflow<T>(
    orenId: string,
    workflow: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workflowTails.get(orenId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      this.assertOpen();
      return workflow();
    });
    const tail = current.then(() => undefined, () => undefined);
    this.workflowTails.set(orenId, tail);
    try {
      return await current;
    } finally {
      if (this.workflowTails.get(orenId) === tail) {
        this.workflowTails.delete(orenId);
      }
    }
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      const pending = [
        ...[...this.knownOrenIds].map((orenId) =>
          this.coordinator.interrupt(orenId, "shutdown")),
        ...(this.activeDrain ? [this.activeDrain] : []),
      ];
      const observed = Promise.allSettled(pending);
      await this.waitForShutdownGrace(observed);
      await this.extension.deactivate();
    } finally {
      this.repository.close();
      this.closed = true;
    }
  }

  private async waitForShutdownGrace(settled: Promise<unknown>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const graceElapsed = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.shutdownGraceMs);
    });
    try {
      await Promise.race([settled, graceElapsed]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private assertIdentity(orenId: string, personId: string): void {
    if (!this.identity) throw new Error("LifeRuntime has not been initialized");
    if (this.identity.orenId !== orenId || this.identity.personId !== personId) {
      throw new Error(
        `LifeRuntime identity conflict: expected ${this.identity.orenId}/${this.identity.personId}`,
      );
    }
  }

  private assertOpen(): void {
    if (this.closed || this.closing) throw new Error("LifeRuntime is closed");
  }
}

const FUTURE_WAKE = "2099-01-02T00:00:00.000Z";
