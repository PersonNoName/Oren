import http from "node:http";
import { buildDashboardSnapshot } from "./snapshot.js";
import { dashboardHtml } from "./html.js";

export interface ServeOptions {
  home: string;
  port?: number;
  host?: string;
}

export function startDashboardServer(opts: ServeOptions): http.Server {
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/api/snapshot") {
        const snap = await buildDashboardSnapshot(opts.home);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(snap));
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  server.listen(port, host);
  return server;
}
