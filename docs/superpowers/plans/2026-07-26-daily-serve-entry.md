# Daily Serve Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run start` so a durable local Oren life stays running with the loopback panel, real-model cognition, and background `drain` for scheduled wakes.

**Architecture:** Pure `serve-config` helpers parse env defaults; `serve-runner` owns start/stop + drain interval around `LifeRuntime`; `serve.ts` is the process main. Panel `postMessage` gains an in-request `drain()` so browser messages settle without waiting for the timer.

**Tech Stack:** TypeScript, Node `http` panel (`@oren/panel`), Vitest, existing `LifeRuntime` / `PiCognitionAdapter` / `resolveModelConfig`.

**Spec:** `docs/superpowers/specs/2026-07-26-daily-serve-entry-design.md`

## Global Constraints

- Panel binds only `127.0.0.1` (existing panel server rule).
- Serve fails non-zero when model config is missing or invalid (no soft-skip like smoke).
- Default DB `~/.oren/life.db`; default panel port `7465`; default identity `oren-local` / `person-local`; default drain interval `2000` ms.
- No terminal REPL, pid files, or daemonization.
- Offline tests only; no CI real-model serve gate.
- Log/error strings go through `redactSecrets` before printing.
- Do not edit the attached roadmap/plan files from other work; only this feature’s files.

## File map

| File | Responsibility |
|------|----------------|
| `packages/app/src/serve-config.ts` | Parse env → paths, port, identity, drain interval |
| `packages/app/test/serve-config.test.ts` | Pure config tests |
| `packages/app/src/life-runtime.ts` | Panel `postMessage` → `receiveUserMessage` + `drain` |
| `packages/app/test/life-runtime-panel.test.ts` | Assert `/api/message` settles without external `drain` |
| `packages/app/src/serve-runner.ts` | Start/stop orchestration (injectable cognition) |
| `packages/app/test/serve-runner.test.ts` | Offline serve lifecycle tests |
| `packages/app/src/serve.ts` | Process main: env → runner → signals |
| `packages/app/src/index.ts` | Re-export serve-config / serve-runner if useful for tests |
| `package.json` | `"start"` script |
| `README.md` | Daily use section |
| `.env.example` | Serve-related env comments |

---

### Task 1: Serve config helpers

**Files:**
- Create: `packages/app/src/serve-config.ts`
- Create: `packages/app/test/serve-config.test.ts`

**Interfaces:**
- Consumes: Node `os.homedir`, `path.join`, env record
- Produces:
  ```ts
  export type ServeConfig = {
    readonly databasePath: string;
    readonly panelPort: number;
    readonly orenId: string;
    readonly personId: string;
    readonly drainIntervalMs: number;
  };
  export function resolveServeConfig(
    env: Readonly<Record<string, string | undefined>>,
    homedir?: () => string,
  ): ServeConfig;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { resolveServeConfig } from "../src/serve-config.js";

describe("resolveServeConfig", () => {
  it("uses defaults when env empty", () => {
    const config = resolveServeConfig({}, () => "/home/me");
    expect(config).toEqual({
      databasePath: "/home/me/.oren/life.db",
      panelPort: 7465,
      orenId: "oren-local",
      personId: "person-local",
      drainIntervalMs: 2000,
    });
  });

  it("honors overrides", () => {
    const config = resolveServeConfig({
      OREN_DB: "/tmp/custom.db",
      OREN_PANEL_PORT: "9001",
      OREN_ID: "oren-x",
      OREN_PERSON_ID: "person-x",
      OREN_DRAIN_INTERVAL_MS: "500",
    }, () => "/home/me");
    expect(config.databasePath).toBe("/tmp/custom.db");
    expect(config.panelPort).toBe(9001);
    expect(config.orenId).toBe("oren-x");
    expect(config.personId).toBe("person-x");
    expect(config.drainIntervalMs).toBe(500);
  });

  it("rejects invalid panel port", () => {
    expect(() => resolveServeConfig({ OREN_PANEL_PORT: "0" }, () => "/h")).toThrow(/OREN_PANEL_PORT/);
    expect(() => resolveServeConfig({ OREN_PANEL_PORT: "abc" }, () => "/h")).toThrow(/OREN_PANEL_PORT/);
  });

  it("rejects invalid drain interval", () => {
    expect(() => resolveServeConfig({ OREN_DRAIN_INTERVAL_MS: "0" }, () => "/h"))
      .toThrow(/OREN_DRAIN_INTERVAL_MS/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/test/serve-config.test.ts`
Expected: FAIL (module not found / export missing)

- [ ] **Step 3: Implement `resolveServeConfig`**

```ts
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export type ServeConfig = {
  readonly databasePath: string;
  readonly panelPort: number;
  readonly orenId: string;
  readonly personId: string;
  readonly drainIntervalMs: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function resolveServeConfig(
  env: Readonly<Record<string, string | undefined>>,
  homedir: () => string = osHomedir,
): ServeConfig {
  const databasePath = env.OREN_DB?.trim() || join(homedir(), ".oren", "life.db");
  return {
    databasePath,
    panelPort: parsePositiveInt(env.OREN_PANEL_PORT, 7465, "OREN_PANEL_PORT"),
    orenId: env.OREN_ID?.trim() || "oren-local",
    personId: env.OREN_PERSON_ID?.trim() || "person-local",
    drainIntervalMs: parsePositiveInt(env.OREN_DRAIN_INTERVAL_MS, 2000, "OREN_DRAIN_INTERVAL_MS"),
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run packages/app/test/serve-config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/serve-config.ts packages/app/test/serve-config.test.ts
git commit -m "feat(app): add serve config defaults and env overrides"
```

---

### Task 2: Panel `postMessage` drains in-request

**Files:**
- Modify: `packages/app/src/life-runtime.ts` (panel `postMessage` handler ~414–417)
- Modify: `packages/app/test/life-runtime-panel.test.ts`

**Interfaces:**
- Consumes: existing `receiveUserMessage`, `drain`, `createPanelServer`
- Produces: panel `POST /api/message` settles durable work before HTTP 200

- [ ] **Step 1: Write the failing test**

Add to `life-runtime-panel.test.ts`:

```ts
  it("POST /api/message drains so inbox updates without an external drain call", async () => {
    const path = tempDb();
    const runtime = await LifeRuntime.create(path, cognitionThatExpresses("from panel post"), {
      enablePanel: true,
      now: () => DAY_NOW,
      nextId: sequenceIds(),
      embedder: new FakeEmbedder(),
    });
    try {
      await runtime.initialize("oren-1", "person-1");
      const url = runtime.panelUrl();
      expect(url).toBeDefined();

      const post = await fetch(`${url}/api/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi from panel" }),
      });
      expect(post.ok).toBe(true);

      // Intentionally no runtime.drain() here — postMessage must have drained.
      const res = await fetch(`${url}/api/snapshot`);
      const snapshot = await res.json();
      expect(snapshot.inbox).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "delivered",
            text: "from panel post",
          }),
        ]),
      );
    } finally {
      await runtime.close();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/test/life-runtime-panel.test.ts -t "POST /api/message drains"`
Expected: FAIL — inbox empty / missing delivery (no external drain)

- [ ] **Step 3: Fix panel handler**

In `life-runtime.ts` panel `postMessage`:

```ts
postMessage: async (text) => {
  const identity = runtimeRef!.requireIdentity();
  await runtimeRef!.receiveUserMessage(identity.orenId, identity.personId, text);
  await runtimeRef!.drain();
},
```

- [ ] **Step 4: Run panel tests — expect PASS**

Run: `npx vitest run packages/app/test/life-runtime-panel.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/life-runtime.ts packages/app/test/life-runtime-panel.test.ts
git commit -m "fix(app): drain after panel postMessage so durable work settles"
```

---

### Task 3: Serve runner (start / interval drain / stop)

**Files:**
- Create: `packages/app/src/serve-runner.ts`
- Create: `packages/app/test/serve-runner.test.ts`
- Modify: `packages/app/src/index.ts` (export `runServe` / types if tests import via package; prefer direct relative imports like smoke tests)

**Interfaces:**
- Consumes: `resolveServeConfig`, `LifeRuntime.create`, `resolveWebConfig`, `mkdirSync` / `mkdir` for parent dir, `redactSecrets`
- Produces:
  ```ts
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
  };

  /** Start life + panel. Caller owns process lifetime / signals. */
  export function startServe(deps: ServeDependencies): Promise<ServeHandle>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CognitionOutcome, CognitionPort } from "@oren/cognition";
import { FakeEmbedder } from "@oren/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeRuntime } from "../src/life-runtime.js";
import { startServe, type ServeHandle } from "../src/serve-runner.js";

function cognitionThatExpresses(text: string): CognitionPort {
  return {
    async run(): Promise<CognitionOutcome> {
      return {
        kind: "completed",
        proposals: [{ type: "ExpressToUser", text, reason: "reply" }],
        usage: { totalTokens: 0 },
      };
    },
  };
}

describe("startServe", () => {
  let handle: ServeHandle | undefined;

  afterEach(async () => {
    if (handle !== undefined) {
      await handle.stop();
      handle = undefined;
    }
  });

  it("starts panel, accepts a message, and stops cleanly", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "oren-serve-")), "life.db");
    const logs: string[] = [];
    handle = await startServe({
      cognition: cognitionThatExpresses("serve hi"),
      env: {
        OREN_DB: db,
        OREN_PANEL_PORT: "0", // ephemeral — extend config to allow 0 ONLY in tests OR use a free port helper
        OREN_DRAIN_INTERVAL_MS: "60_000",
      },
      log: (line) => logs.push(line),
    });
    // NOTE: If port 0 is rejected by parsePositiveInt, use an explicit free port:
    // import { createServer } from "node:net"; probe then pass that port.

    expect(handle.panelUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const post = await fetch(`${handle.panelUrl}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(post.ok).toBe(true);
    const snap = await (await fetch(`${handle.panelUrl}/api/snapshot`)).json();
    expect(snap.inbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "serve hi", status: "delivered" }),
      ]),
    );
    await handle.stop();
    handle = undefined;
    expect(logs.some((l) => l.includes("panel"))).toBe(true);
  });

  it("interval drain invokes LifeRuntime.drain", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "oren-serve-drain-")), "life.db");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    handle = await startServe({
      cognition: cognitionThatExpresses("tick"),
      env: { OREN_DB: db, OREN_PANEL_PORT: "<free-port>", OREN_DRAIN_INTERVAL_MS: "25" },
      setIntervalFn: ((cb: () => void, ms: number) => {
        timers.push({ cb: cb as () => void, ms });
        return 1 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      log: () => undefined,
    });
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(25);
    // Spy: call the interval callback; should not throw
    await timers[0]!.cb();
  });
});
```

**Port note for implementer:** `resolveServeConfig` rejects `0`. For tests, either:
- (Preferred) add optional `ServeDependencies.panelPortOverride?: number` that bypasses env when set, allowing `0` for ephemeral bind; **or**
- Probe a free port with a short-lived `net.createServer().listen(0)` and pass it as `OREN_PANEL_PORT`.

Use the free-port probe in tests so production config stays “positive int only”.

Helper to paste into the test file:

```ts
import { createServer } from "node:net";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/test/serve-runner.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `startServe`**

Sketch:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CognitionPort } from "@oren/cognition";
import { resolveWebConfig } from "@oren/web";
import { LifeRuntime } from "./life-runtime.js";
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
  /** When set, skip creating Pi model; used by process main only via wrapper. */
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
```

**Test note:** Offline tests must pass an explicit `embedder` — `useProcessEmbeddingEnv: true` would try real env. Adjust `startServe` to accept optional `LifeRuntime` option overrides:

```ts
export type ServeDependencies = {
  // ...
  readonly runtimeOptions?: Omit<
    Parameters<typeof LifeRuntime.create>[2],
    "enablePanel" | "panelPort"
  >;
};
```

And merge:

```ts
const runtime = await LifeRuntime.create(config.databasePath, deps.cognition, {
  enablePanel: true,
  panelPort: config.panelPort,
  useProcessEmbeddingEnv: true,
  useProcessWebEnv: webConfig.ok,
  ...deps.runtimeOptions,
});
```

In tests pass `{ embedder: new FakeEmbedder(), useProcessEmbeddingEnv: false, useProcessWebEnv: false }`.

- [ ] **Step 4: Run serve-runner tests — expect PASS**

Run: `npx vitest run packages/app/test/serve-runner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/serve-runner.ts packages/app/test/serve-runner.test.ts
git commit -m "feat(app): add serve runner with panel and interval drain"
```

---

### Task 4: Process main, npm script, docs

**Files:**
- Create: `packages/app/src/serve.ts`
- Modify: `package.json` (`scripts.start`)
- Modify: `README.md` (Daily use section near Real-model commands)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `resolveModelConfig`, `PiCognitionAdapter`, `startServe`, `redactSecrets`
- Produces: `npm run start` long-running process

- [ ] **Step 1: Implement `serve.ts`**

```ts
import { PiCognitionAdapter, resolveModelConfig } from "@oren/pi-cognition";
import { redactSecrets } from "./redact.js";
import { startServe } from "./serve-runner.js";

const env = process.env;
const configSearchFrom = env.OREN_CONFIG_SEARCH_FROM?.trim();
const model = resolveModelConfig(
  env,
  configSearchFrom ? { searchFrom: configSearchFrom } : undefined,
);
if (!model.ok) {
  console.error(redactSecrets(model.reason));
  process.exitCode = 1;
} else {
  const handle = await startServe({
    cognition: new PiCognitionAdapter({
      model: model.model,
      streamFn: model.streamFn,
    }),
    env,
    log: (line) => console.log(line),
  });
  console.log(redactSecrets(`Oren model=${model.model.provider}/${model.model.id}`));

  const shutdown = async () => {
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}
```

- [ ] **Step 2: Wire `package.json`**

Add script:

```json
"start": "npm run build && node --enable-source-maps dist/packages/app/src/serve.js"
```

- [ ] **Step 3: Update README**

Add section **Daily use** (after Real-model commands intro is fine):

```markdown
## Daily use

Keep a local life running with the loopback panel (real model required):

```bash
set -a && source .env && set +a
npm run start
```

Open the printed `http://127.0.0.1:7465/` URL (or `OREN_PANEL_PORT`). Message Oren from the panel. Ctrl+C stops cleanly. Database defaults to `~/.oren/life.db` (`OREN_DB` to override).
```

- [ ] **Step 4: Update `.env.example`**

Append:

```bash
# --- Daily serve (`npm run start`) ---
# OREN_DB=
# OREN_PANEL_PORT=7465
# OREN_ID=oren-local
# OREN_PERSON_ID=person-local
# OREN_DRAIN_INTERVAL_MS=2000
```

- [ ] **Step 5: Typecheck + relevant tests**

Run:

```bash
npm run typecheck
npx vitest run packages/app/test/serve-config.test.ts packages/app/test/serve-runner.test.ts packages/app/test/life-runtime-panel.test.ts
```

Expected: all PASS

- [ ] **Step 6: Manual check (local, credential-gated)**

```bash
set -a && source .env && set +a
npm run start
```

Expected: prints panel URL; browser loads; Ctrl+C exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/serve.ts package.json README.md .env.example
git commit -m "feat(app): add npm run start daily serve entry"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `npm run start` entry + build | Task 4 |
| `serve.ts` / `serve-runner.ts` | Tasks 3–4 |
| Default `~/.oren/life.db`, port 7465, identity, drain 2s | Task 1 |
| Env overrides | Task 1 |
| Force `enablePanel` | Task 3 |
| Embedding/web env opt-in like smoke | Task 3 |
| Model missing → non-zero exit | Task 4 |
| Panel postMessage + drain | Task 2 |
| Interval drain + log errors | Task 3 |
| SIGINT/SIGTERM close | Task 4 |
| README + `.env.example` | Task 4 |
| Offline config / panel / runner tests | Tasks 1–3 |
| No smoke assertion coupling | All tasks |

## Self-review notes

- Port `0` is not a production default; tests probe a free port instead of weakening validation.
- Tests override `runtimeOptions.embedder` so `useProcessEmbeddingEnv` does not break offline CI.
- `unconfigured` exits non-zero in serve (explicitly different from smoke) — covered in Task 4 main.
