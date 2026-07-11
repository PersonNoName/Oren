import http from "node:http";
import {
  deleteCorpusFile,
  readCorpusFile,
  writeCorpusFile,
} from "../corpus/manage.js";
import { sayToOren } from "../dialogue/reply.js";
import { selectLlm } from "../llm/select.js";
import { loadDotEnv } from "../load-env.js";
import { LifeStore } from "../store/life-store.js";
import { runTick } from "../tick/engine.js";
import type { Mode } from "../types.js";
import { dashboardHtml } from "./html.js";
import { buildDashboardSnapshot } from "./snapshot.js";

export interface ServeOptions {
  home: string;
  port?: number;
  host?: string;
}

export function startDashboardServer(opts: ServeOptions): http.Server {
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  loadDotEnv([opts.home]);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && url.pathname === "/api/snapshot") {
        return json(res, 200, await buildDashboardSnapshot(opts.home));
      }

      if (method === "POST" && url.pathname === "/api/say") {
        const body = await readJsonBody<{ text?: string }>(req);
        const text = (body.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text is required" });
        const store = new LifeStore(opts.home);
        const state = await store.load();
        const model = process.env.OREN_MODEL?.trim() || state.config.model;
        const result = await sayToOren({
          store,
          text,
          llm: selectLlm(model, "say"),
        });
        return json(res, 200, {
          ok: true,
          user: result.userTurn,
          oren: result.orenTurn,
          share: result.artifact.share,
        });
      }

      if (method === "POST" && url.pathname === "/api/tick") {
        const body = await readJsonBody<{ forceMode?: string }>(req);
        let forceMode: Mode | undefined;
        if (
          body.forceMode === "idle" ||
          body.forceMode === "organize" ||
          body.forceMode === "contemplate"
        ) {
          forceMode = body.forceMode;
        }
        const store = new LifeStore(opts.home);
        let model = "deepseek:deepseek-v4-flash";
        try {
          const state = await store.load();
          model = process.env.OREN_MODEL?.trim() || state.config.model;
        } catch {
          /* runTick handles */
        }
        const result = await runTick({
          home: opts.home,
          forceMode,
          llm: selectLlm(model, "tick"),
        });
        return json(res, result.exitCode === 0 ? 200 : 500, {
          ok: result.exitCode === 0,
          ...result,
        });
      }

      if (method === "POST" && url.pathname === "/api/corpus") {
        const body = await readJsonBody<{ name?: string; content?: string }>(req);
        const name = (body.name ?? "").trim();
        const content = body.content ?? "";
        if (!name) return json(res, 400, { error: "name is required" });
        if (!content.trim()) return json(res, 400, { error: "content is required" });
        const store = new LifeStore(opts.home);
        const state = await store.load();
        const file = await writeCorpusFile(opts.home, state.config, name, content);
        return json(res, 200, { ok: true, file });
      }

      if (method === "GET" && url.pathname === "/api/corpus") {
        const name = (url.searchParams.get("name") ?? "").trim();
        if (!name) return json(res, 400, { error: "name query required" });
        const store = new LifeStore(opts.home);
        const state = await store.load();
        const file = await readCorpusFile(opts.home, state.config, name);
        return json(res, 200, { ok: true, file });
      }

      if (method === "DELETE" && url.pathname === "/api/corpus") {
        const name = (url.searchParams.get("name") ?? "").trim();
        if (!name) return json(res, 400, { error: "name query required" });
        const store = new LifeStore(opts.home);
        const state = await store.load();
        const result = await deleteCorpusFile(opts.home, state.config, name);
        return json(res, 200, { ok: true, ...result });
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      json(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(port, host);
  return server;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
