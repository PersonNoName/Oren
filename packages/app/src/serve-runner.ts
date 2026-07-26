import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CognitionPort } from "@oren/cognition";
import { resolveWebConfig } from "@oren/web";
import { LifeRuntime, type LifeRuntimeOptions } from "./life-runtime.js";
import { redactSecrets } from "./redact.js";
import { resolveServeConfig, type ServeConfig } from "./serve-config.js";

export type ServeHandle = {
  readonly panelUrl: string;
  readonly databasePath: string;
  readonly config: ServeConfig;
  stop(): Promise<void>;
};

export type ServeDependencies = {
  readonly cognition: CognitionPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: () => string;
  readonly log?: (line: string) => void;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly runtimeOptions?: Omit<LifeRuntimeOptions, "enablePanel" | "panelPort">;
};

export async function startServe(deps: ServeDependencies): Promise<ServeHandle> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const config = resolveServeConfig(env, deps.homedir);
  mkdirSync(dirname(config.databasePath), { recursive: true });

  const webConfig = resolveWebConfig(env);
  const runtime = await LifeRuntime.create(config.databasePath, deps.cognition, {
    enablePanel: true,
    panelPort: config.panelPort,
    useProcessEmbeddingEnv: true,
    useProcessWebEnv: webConfig.ok,
    ...deps.runtimeOptions,
  });

  try {
    await runtime.initialize(config.orenId, config.personId);
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const panelUrl = runtime.panelUrl();
  if (panelUrl === undefined) {
    await runtime.close();
    throw new Error("panel server failed to start");
  }

  log(redactSecrets(`Oren serve database=${config.databasePath}`));
  log(redactSecrets(`Oren serve panel=${panelUrl}`));
  log(redactSecrets(`Oren serve identity=${config.orenId}/${config.personId}`));

  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  let stopped = false;
  const timer = setIntervalFn(() => {
    void runtime.drain().catch((error: unknown) => {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      log(redactSecrets(`Oren serve drain error: ${message}`));
    });
  }, config.drainIntervalMs);

  return {
    panelUrl,
    databasePath: config.databasePath,
    config,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      await runtime.close();
    },
  };
}
