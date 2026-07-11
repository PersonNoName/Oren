import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../../src/dashboard/server.js";
import { LifeStore } from "../../src/store/life-store.js";

const temps: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const t of temps.splice(0)) {
    await fs.rm(t, { recursive: true, force: true });
  }
});

function waitPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const done = () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    };
    if (server.listening) done();
    else server.once("listening", done);
  });
}

describe("dashboard server APIs", () => {
  it("POST /api/say records dialogue", async () => {
    process.env.OREN_SAY_LLM = "fake";
    process.env.OREN_TICK_LLM = "fake";
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "oren-srv-"));
    temps.push(home);
    await LifeStore.init(home);

    const server = startDashboardServer({ home, host: "127.0.0.1", port: 0 });
    servers.push(server);
    const port = await waitPort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      oren: { text: string };
    };
    expect(body.ok).toBe(true);
    expect(body.oren.text.length).toBeGreaterThan(0);

    const snapRes = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    const snap = (await snapRes.json()) as { dialogue: unknown[] };
    expect(snap.dialogue.length).toBeGreaterThanOrEqual(2);
  });
});
