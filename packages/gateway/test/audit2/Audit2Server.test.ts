/**
 * Re-audit 2026-10-07 (round 2): the standalone reference server and the handler's response hardening.
 */
import { createServer } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGatewayServer } from "../../src/server.js";
import { isActiveXmlType } from "../../src/resolve.js";

describe("Audit2: standalone server builds the request URL from the Host header", () => {
  let port = 0;
  const seen: string[] = [];
  const server = createGatewayServer({
    projectMode: true,
    handler: async (req) => {
      const u = new URL(req.url);
      seen.push(`${u.pathname}${u.search}`);
      return new Response("ok");
    },
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const send = (host: string, path: string) =>
    new Promise<string>((resolve) => {
      const r = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(String(res.statusCode))); });
      r.on("error", () => resolve("error"));
      r.end();
    });

  it("FIXED: a Host with '/', '?', '#', '@', a backslash or whitespace is a 400 and the handler never runs", async () => {
    for (const host of ["x/admin/secret?q=1#", "x?y", "x#y", "user@x", "x\\y", "x y", "x/", ".", "-x", "x:99999999", "[::1"]) {
      seen.length = 0;
      const status = await send(host, "/harmless.png");
      // Node's own parser may refuse some of these before we do; either way nothing reaches the handler.
      expect(["400", "error"], host).toContain(status);
      expect(seen, host).toEqual([]);
    }
  });
  it("a plain host, a host:port and a bracketed IPv6 literal still reach the handler with the request-target's own path", async () => {
    for (const host of ["gateway.example", "gateway.example:8080", "127.0.0.1:3000", "[::1]:3000", "a-b.c_d.example"]) {
      seen.length = 0;
      expect(await send(host, "/harmless.png?q=1"), host).toBe("200");
      expect(seen).toEqual(["/harmless.png?q=1"]);
    }
  });
});

describe("Audit2: which declared types get the sandbox CSP", () => {
  // `text/xsl` moved to the sandboxed side (audit 9, L2): Chromium renders it as XML and runs an XHTML <script> in it.
  const sandboxed = ["image/svg+xml", "IMAGE/SVG+XML", "image/svg+xml; charset=utf-8", " image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "application/xml; x=y", "application/rss+xml", "application/vnd.foo+xml", "application/mathml+xml", "application/xslt+xml", "text/xsl"];
  for (const t of sandboxed) it(`sandboxes ${JSON.stringify(t)}`, () => expect(isActiveXmlType(t)).toBe(true));
  const notSandboxed = ["text/html", "application/pdf", "text/javascript", "application/javascript", "text/xml-external-parsed-entity", "image/svg", "multipart/x-mixed-replace"];
  for (const t of notSandboxed) it(`does NOT sandbox ${JSON.stringify(t)} (by design or inert)`, () => expect(isActiveXmlType(t)).toBe(false));
});
