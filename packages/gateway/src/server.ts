/**
 * `node:http` around a gateway handler. No framework, no dependencies: a reference implementation
 * should be readable in one sitting and runnable on anything with Node.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { parseContentHost } from "@abxfs/sdk";

import type { GatewayHandler } from "./handler.js";

export interface ServerOptions {
  handler: GatewayHandler;
  /** Mount point the handler serves under, for the landing page (path mode). Default `/g`. */
  basePath?: string;
  /** The handler serves one project at `/` (see `GatewayOptions.project`), so there is no landing page. */
  projectMode?: boolean;
  /**
   * The handler serves per-project hosts under this base (see `GatewayOptions.hostMode`). `/` and
   * `/healthz` on a CONTENT host belong to the project, so the built-in pages answer only on other
   * hosts (a load balancer probing by IP, or the bare domain).
   */
  hostMode?: { baseHost: string };
  /** Sent as `access-control-allow-origin` when set. Off by default: it widens who can read what. */
  cors?: string;
  /** Called once per request with method, path, status and milliseconds. */
  onRequest?: (line: { method: string; path: string; status: number; ms: number }) => void;
}

const VALID_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

export function createGatewayServer(options: ServerOptions): Server {
  const base = (options.basePath ?? "/g").replace(/\/+$/, "") || "/g";

  return createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    try {
      // `req.url` is the request-target. Only origin-form (`/path`) is accepted: `new URL("//evil/x",
      // base)` would read it as a scheme-relative URL and swap the host, so the origin is prepended as
      // a string instead and the target can only ever be a path on THIS server.
      if (!req.url || !req.url.startsWith("/")) {
        status = 400;
        return send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "bad request\n", req.method);
      }
      // The Host header is client text that is about to be spliced into a URL. A `/`, `?`, `#`, `@`, a
      // backslash or whitespace in it would move where the path begins (`x/admin?q=1#` + `/harmless.png`
      // reads as the path `/admin`), so only a plain host[:port] or a bracketed IPv6 literal gets through.
      const rawHost = req.headers.host ?? "localhost";
      if (!VALID_HOST.test(rawHost)) {
        status = 400;
        return send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "bad request\n", req.method);
      }
      let url: URL;
      try {
        url = new URL(`http://${rawHost}${req.url}`);
      } catch {
        status = 400;
        return send(res, 400, { "content-type": "text/plain; charset=utf-8" }, "bad request\n", req.method);
      }

      const onContentHost = options.hostMode
        ? parseContentHost(req.headers.host, options.hostMode.baseHost.toLowerCase()) !== null
        : false;

      if (url.pathname === "/healthz" && !onContentHost) {
        status = 200;
        return send(res, 200, { "content-type": "text/plain; charset=utf-8" }, "ok\n", req.method);
      }
      if (url.pathname === "/" && !options.projectMode && !onContentHost) {
        status = 200;
        const body = options.hostMode
          ? `ABX FS gateway\n\n  https://<chain>-<org>-<id>.${options.hostMode.baseHost}/\n  https://<chain>-<root>.${options.hostMode.baseHost}/\n`
          : `ABX FS gateway\n\n  ${base}/p/<chainId>/<org>/<tokenId>/latest/…\n  ${base}/cid/<chainId>/<root>/…\n`;
        return send(res, 200, { "content-type": "text/plain; charset=utf-8" }, body, req.method);
      }

      const response = await options.handler(toRequest(req, url));
      status = response.status;
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      if (options.cors) headers["access-control-allow-origin"] = options.cors;

      const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
      res.writeHead(response.status, headers);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (err) {
      status = 500;
      // Never the error text: it can carry an RPC URL with its key.
      send(res, 500, { "content-type": "text/plain; charset=utf-8" }, "internal error\n", req.method);
    } finally {
      options.onRequest?.({ method: req.method ?? "?", path: req.url ?? "", status, ms: Date.now() - started });
    }
  });
}

function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(url, { method: req.method, headers });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string, method?: string) {
  res.writeHead(status, headers);
  res.end(method === "HEAD" ? undefined : body);
}
