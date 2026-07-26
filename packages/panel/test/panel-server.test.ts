import { describe, expect, it } from "vitest";
import {
  createPanelServer,
  minimalSnapshot,
  type PanelHandlers,
} from "@oren/panel";
import type { ReachabilityPolicy } from "@oren/kernel";
import type { SpeechEvent } from "@oren/channel";

const noopHandlers: PanelHandlers = {
  getSnapshot: () => minimalSnapshot(),
  postMessage: async () => {},
  updateReachability: async () => {},
  revokeGrant: async () => {},
  updateCommitment: async () => {},
};

describe("createPanelServer", () => {
  it("streams speech events over SSE and unsubscribes on disconnect", async () => {
    let listener: ((event: SpeechEvent) => void) | undefined;
    let subscribers = 0;
    const server = await createPanelServer({
      ...noopHandlers,
      subscribeSpeech(next) {
        listener = next;
        subscribers += 1;
        return () => {
          subscribers -= 1;
        };
      },
    });
    const controller = new AbortController();
    const response = await fetch(`${server.url}/api/speech-events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    listener?.({
      type: "speech.delta",
      messageId: "message-1",
      text: "你",
    });
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(
      'data: {"type":"speech.delta","messageId":"message-1","text":"你"}',
    );
    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let attempt = 0; attempt < 20 && subscribers > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(subscribers).toBe(0);
    await server.close();
  });

  it("serves snapshot on loopback only", async () => {
    const server = await createPanelServer({
      getSnapshot: () => minimalSnapshot(),
      postMessage: async () => {},
      updateReachability: async () => {},
      revokeGrant: async () => {},
      updateCommitment: async () => {},
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${server.url}/api/snapshot`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.inbox).toEqual([]);
    await server.close();
  });

  it("uses ephemeral port when port is 0", async () => {
    const server = await createPanelServer(noopHandlers, { port: 0 });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${server.url}/api/snapshot`);
    expect(res.ok).toBe(true);
    await server.close();
  });

  it("POST /api/message invokes handler", async () => {
    const texts: string[] = [];
    const server = await createPanelServer({
      ...noopHandlers,
      postMessage: async (text) => {
        texts.push(text);
      },
    });
    const res = await fetch(`${server.url}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.ok).toBe(true);
    expect(texts).toEqual(["hello"]);
    await server.close();
  });

  it("POST /api/reachability invokes handler", async () => {
    const calls: Array<{ policy: ReachabilityPolicy; reason: string }> = [];
    const server = await createPanelServer({
      ...noopHandlers,
      updateReachability: async (policy, reason) => {
        calls.push({ policy, reason });
      },
    });
    const policy: ReachabilityPolicy = {
      quietHours: null,
      maxProactivePerDay: 5,
      deferWhenQuiet: true,
      proactiveDayKey: null,
      proactiveCountToday: 0,
    };
    const res = await fetch(`${server.url}/api/reachability`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy, reason: "test" }),
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ policy, reason: "test" }]);
    await server.close();
  });

  it("POST /api/grants/:id/revoke invokes handler", async () => {
    const calls: Array<{ grantId: string; reason: string }> = [];
    const server = await createPanelServer({
      ...noopHandlers,
      revokeGrant: async (grantId, reason) => {
        calls.push({ grantId, reason });
      },
    });
    const res = await fetch(`${server.url}/api/grants/g1/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "expired" }),
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ grantId: "g1", reason: "expired" }]);
    await server.close();
  });

  it("POST /api/commitments/:id invokes handler", async () => {
    const calls: Array<{
      commitmentId: string;
      body: { status: "active" | "paused" | "done"; nextStep?: string; reason: string };
    }> = [];
    const server = await createPanelServer({
      ...noopHandlers,
      updateCommitment: async (commitmentId, body) => {
        calls.push({ commitmentId, body });
      },
    });
    const res = await fetch(`${server.url}/api/commitments/c1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done", reason: "finished" }),
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { commitmentId: "c1", body: { status: "done", reason: "finished" } },
    ]);
    await server.close();
  });

  it("rejects bind host other than 127.0.0.1", async () => {
    await expect(
      createPanelServer(noopHandlers, { host: "0.0.0.0" }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("serves static HTML at GET /", async () => {
    const server = await createPanelServer(noopHandlers);
    const res = await fetch(`${server.url}/`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("inbox");
    expect(html).toContain("commitments");
    expect(html).toContain("grants");
    expect(html).toContain("budgets");
    expect(html).toContain("ledger");
    await server.close();
  });
});
