/**
 * AUDIT 9, coverage: `server.ts`'s edge branches, over a real socket (a request line and headers `fetch` will not
 * send): an absolute-form request target, no Host at all, a Host that passes the shape check but is not a URL, a
 * handler that throws, HEAD, CORS, repeated headers, and the built-in pages per mode.
 */
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createGatewayServer, type ServerOptions } from "../../src/server.js";

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

async function start(options: Partial<ServerOptions> & { handler?: ServerOptions["handler"] }) {
  const seen: Request[] = [];
  const lines: { method: string; path: string; status: number }[] = [];
  const server = createGatewayServer({
    handler: async (req) => {
      seen.push(req);
      return new Response("from-handler", { status: 200, headers: { "x-test": "1" } });
    },
    onRequest: (l) => lines.push(l),
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return { port: (server.address() as AddressInfo).port, seen, lines };
}

/** One raw HTTP exchange. Returns the status, the lower-cased headers and the body (as sent: use HTTP/1.0 to compare one). */
function raw(port: number, request: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(request));
    let data = "";
    socket.on("data", (c) => (data += c.toString("latin1")));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const [statusLine, ...headerLines] = (head ?? "").split("\r\n");
      const headers: Record<string, string> = {};
      for (const l of headerLines) {
        const i = l.indexOf(":");
        headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status: Number(statusLine?.split(" ")[1]), headers, body: rest.join("\r\n\r\n") });
    });
  });
}

describe("server edges", () => {
  it("an absolute-form request target is a 400: the host can only come from Host", async () => {
    const { port, seen, lines } = await start({ projectMode: true });
    const r = await raw(port, "GET http://evil.example/x HTTP/1.1\r\nHost: gw.example\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
    expect(lines[0]).toMatchObject({ status: 400, path: "http://evil.example/x" });
  });

  it("no Host at all (HTTP/1.0) is served as localhost", async () => {
    const { port, seen } = await start({ projectMode: true });
    const r = await raw(port, "GET /a.txt HTTP/1.0\r\n\r\n");
    expect(r.status).toBe(200);
    expect(new URL(seen[0]!.url).host).toBe("localhost");
  });

  it("a Host that has the right shape but is not a URL (port out of range) is a 400", async () => {
    const { port, seen } = await start({ projectMode: true });
    const r = await raw(port, "GET / HTTP/1.1\r\nHost: gw.example:99999\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("a handler that throws is a 500 with no error text", async () => {
    const { port, lines } = await start({
      projectMode: true,
      handler: async () => {
        throw new Error("https://rpc.example/v2/SECRET exploded");
      },
    });
    const r = await raw(port, "GET / HTTP/1.0\r\nHost: gw.example\r\n\r\n");
    expect(r.status).toBe(500);
    expect(r.body).toBe("internal error\n");
    expect(lines[0]!.status).toBe(500);
  });

  it("HEAD gets the handler's headers and no body; CORS is added when configured", async () => {
    const { port } = await start({ projectMode: true, cors: "*" });
    const r = await raw(port, "HEAD /x HTTP/1.1\r\nHost: gw.example\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(200);
    expect(r.headers["x-test"]).toBe("1");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.body).toBe("");
  });

  it("a response with no body is sent as one", async () => {
    const { port } = await start({ projectMode: true, handler: async () => new Response(null, { status: 304, headers: { etag: '"x"' } }) });
    const r = await raw(port, "GET /x HTTP/1.1\r\nHost: gw.example\r\nConnection: close\r\n\r\n");
    expect(r.status).toBe(304);
    expect(r.headers.etag).toBe('"x"');
  });

  it("repeated request headers reach the handler as one appended value", async () => {
    const { port, seen } = await start({ projectMode: true });
    await raw(port, "GET /x HTTP/1.1\r\nHost: gw.example\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\n");
    expect(seen[0]!.headers.get("set-cookie")).toBe("a=1, b=2");
  });

  it("host mode: /healthz and the landing page answer on a NON-content host only; HEAD of them has no body", async () => {
    const { port, seen } = await start({ hostMode: { baseHost: "content.example" } });
    const health = await raw(port, "GET /healthz HTTP/1.0\r\nHost: 10.0.0.1\r\n\r\n");
    expect(health).toMatchObject({ status: 200, body: "ok\n" });
    const landing = await raw(port, "GET / HTTP/1.1\r\nHost: content.example\r\nConnection: close\r\n\r\n");
    expect(landing.status).toBe(200);
    expect(landing.body).toContain("https://c-<root>.content.example/");
    const head = await raw(port, "HEAD /healthz HTTP/1.1\r\nHost: 10.0.0.1\r\nConnection: close\r\n\r\n");
    expect(head).toMatchObject({ status: 200, body: "" });
    expect(seen).toEqual([]);
    // on a content host both paths belong to the project
    const label = `c-${"a".repeat(52)}`;
    await raw(port, `GET /healthz HTTP/1.1\r\nHost: ${label}.content.example\r\nConnection: close\r\n\r\n`);
    expect(seen).toHaveLength(1);
  });

  it("path mode: the landing page names the mount point", async () => {
    const { port } = await start({ basePath: "/gw/" });
    const landing = await raw(port, "GET / HTTP/1.1\r\nHost: gw.example\r\nConnection: close\r\n\r\n");
    expect(landing.body).toContain("/gw/p/<chainId>/<org>/<tokenId>/latest/");
  });
});
