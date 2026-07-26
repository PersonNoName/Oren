import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitmentStatus, ReachabilityPolicy } from "@oren/kernel";
import type { PanelHandlers, PanelServer, PanelServerOptions } from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

export function createPanelServer(
  handlers: PanelHandlers,
  options?: PanelServerOptions,
): Promise<PanelServer> {
  const host = options?.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    return Promise.reject(new Error(`panel server must bind to ${LOOPBACK_HOST}, got ${host}`));
  }

  const port = options?.port ?? 0;
  let indexHtml: string | undefined;

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);

      if (method === "GET" && url.pathname === "/api/snapshot") {
        const snapshot = await handlers.getSnapshot();
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        indexHtml ??= await readFile(join(STATIC_DIR, "index.html"), "utf8");
        sendText(res, 200, indexHtml, "text/html; charset=utf-8");
        return;
      }

      if (method === "POST" && url.pathname === "/api/message") {
        const raw = await readJsonBody(req);
        const body = isRecord(raw) ? raw : {};
        const text = readStringField(body, "text");
        if (text === undefined || text.length === 0) {
          sendJson(res, 400, { error: "text required" });
          return;
        }
        await handlers.postMessage(text);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/api/reachability") {
        const raw = await readJsonBody(req);
        const body = isRecord(raw) ? raw : {};
        const policy = body.policy as ReachabilityPolicy | undefined;
        const reason = readStringField(body, "reason");
        if (policy === undefined || reason === undefined || reason.length === 0) {
          sendJson(res, 400, { error: "policy and reason required" });
          return;
        }
        await handlers.updateReachability(policy, reason);
        sendJson(res, 200, { ok: true });
        return;
      }

      const grantRevokeMatch = /^\/api\/grants\/([^/]+)\/revoke$/.exec(url.pathname);
      if (method === "POST" && grantRevokeMatch) {
        const grantId = grantRevokeMatch[1];
        const raw = await readJsonBody(req);
        const body = isRecord(raw) ? raw : {};
        const reason = readStringField(body, "reason");
        if (grantId === undefined || reason === undefined || reason.length === 0) {
          sendJson(res, 400, { error: "reason required" });
          return;
        }
        await handlers.revokeGrant(grantId, reason);
        sendJson(res, 200, { ok: true });
        return;
      }

      const commitmentMatch = /^\/api\/commitments\/([^/]+)$/.exec(url.pathname);
      if (method === "POST" && commitmentMatch) {
        const commitmentId = commitmentMatch[1];
        const raw = await readJsonBody(req);
        const body = isRecord(raw) ? raw : {};
        const status = readStringField(body, "status") as CommitmentStatus | undefined;
        const reason = readStringField(body, "reason");
        const nextStep = readStringField(body, "nextStep");
        if (
          commitmentId === undefined
          || status === undefined
          || reason === undefined
          || reason.length === 0
        ) {
          sendJson(res, 400, { error: "status and reason required" });
          return;
        }
        await handlers.updateCommitment(
          commitmentId,
          nextStep === undefined ? { status, reason } : { status, nextStep, reason },
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      sendJson(res, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to resolve panel server address"));
        return;
      }
      resolve({
        url: `http://${LOOPBACK_HOST}:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}
