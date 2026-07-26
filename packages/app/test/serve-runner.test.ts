import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CognitionOutcome, CognitionPort } from "@oren/cognition";
import { FakeEmbedder } from "@oren/memory";
import { afterEach, describe, expect, it } from "vitest";
import { startServe, type ServeHandle } from "../src/serve-runner.js";

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

const offlineRuntimeOptions = {
  embedder: new FakeEmbedder(),
  useProcessEmbeddingEnv: false,
  useProcessWebEnv: false,
} as const;

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
    const port = await freePort();
    const db = join(mkdtempSync(join(tmpdir(), "oren-serve-")), "life.db");
    const logs: string[] = [];
    handle = await startServe({
      cognition: cognitionThatExpresses("serve hi"),
      env: {
        OREN_DB: db,
        OREN_PANEL_PORT: String(port),
        OREN_DRAIN_INTERVAL_MS: "60000",
      },
      runtimeOptions: offlineRuntimeOptions,
      log: (line) => logs.push(line),
    });

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
    const port = await freePort();
    const db = join(mkdtempSync(join(tmpdir(), "oren-serve-drain-")), "life.db");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    handle = await startServe({
      cognition: cognitionThatExpresses("tick"),
      env: {
        OREN_DB: db,
        OREN_PANEL_PORT: String(port),
        OREN_DRAIN_INTERVAL_MS: "25",
      },
      runtimeOptions: offlineRuntimeOptions,
      setIntervalFn: ((cb: () => void, ms: number) => {
        timers.push({ cb: cb as () => void, ms });
        return 1 as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      log: () => undefined,
    });
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBe(25);
    await timers[0]!.cb();
  });
});
