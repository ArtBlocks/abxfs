/**
 * AUDIT 9, L2: the sandbox decision read the declared type's text up to the first `;`, but a browser runs Fetch's
 * "extract a MIME type" on the header: it splits on commas and the LAST valid type wins. `image/svg+xml,` and
 * `image/svg+xml,x` were therefore SVG to Chrome and nothing to the gateway, served without `sandbox`, and their script
 * ran on the content origin (reproduced in headless Chrome during the audit). `text/xsl` is an XML type to Chromium and
 * ran script too. Now only a declared type that is exactly ONE valid MIME type is sent as declared; anything else is
 * `application/octet-stream` with the sandbox.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { rootContentLabel } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { isActiveEssence, servedType, singleMimeEssence } from "../../src/mime.js";
import { __resetResolveCaches, isActiveXmlType } from "../../src/resolve.js";
import { FakeChain } from "../fake-chain.js";

beforeEach(() => __resetResolveCaches());

describe("L2: one valid MIME type, or octet-stream", () => {
  it("the audit's bypasses are octet-stream and sandboxed", () => {
    for (const declared of ["image/svg+xml,", "image/svg+xml,x", "text/html, image/svg+xml", "text/plain,image/svg+xml", ",image/svg+xml"]) {
      expect(servedType(declared), declared).toEqual({ contentType: "application/octet-stream", essence: "application/octet-stream", sandbox: true });
      expect(isActiveXmlType(declared), declared).toBe(true);
    }
  });

  it("text/xsl is active", () => {
    expect(servedType("text/xsl")).toEqual({ contentType: "text/xsl", essence: "text/xsl", sandbox: true });
    expect(isActiveEssence("text/xsl")).toBe(true);
  });

  it("anything that is not ONE valid type is octet-stream and sandboxed", () => {
    for (const declared of [
      "",
      " ",
      "text",
      "text/",
      "/html",
      "text/html/x",
      "text/ht ml",
      "text/html; charset",
      "text/html; =utf-8",
      'text/html; charset="unterminated',
      "text/html; charset=utf-8, image/svg+xml",
      "tëxt/html",
      "text/html; x=é",
      "text/html\u0000",
      "text/(html)",
    ]) {
      expect(servedType(declared), JSON.stringify(declared)).toEqual({ contentType: "application/octet-stream", essence: "application/octet-stream", sandbox: true });
    }
  });

  it("valid single types are sent as declared (trimmed), and only active ones are sandboxed", () => {
    const cases: Array<[string, string, boolean]> = [
      ["text/html", "text/html", false],
      ["text/html; charset=utf-8", "text/html", false],
      ["Text/HTML;charset=UTF-8", "text/html", false],
      ["text/html;", "text/html", false],
      ['text/plain; name="a,b; c"', "text/plain", false],
      ['text/plain; x="say \\"hi\\""', "text/plain", false],
      ["application/json", "application/json", false],
      ["image/png", "image/png", false],
      ["image/svg+xml", "image/svg+xml", true],
      ["  image/svg+xml; charset=utf-8  ", "image/svg+xml", true],
      ["application/xhtml+xml", "application/xhtml+xml", true],
      ["text/xml", "text/xml", true],
      ["application/xml", "application/xml", true],
      ["application/rss+xml", "application/rss+xml", true],
      ['image/svg+xml; x="a,b"', "image/svg+xml", true],
    ];
    for (const [declared, essence, sandbox] of cases) {
      expect(singleMimeEssence(declared), declared).toBe(essence);
      const t = servedType(declared);
      expect(t.essence, declared).toBe(essence);
      expect(t.sandbox, declared).toBe(sandbox);
      expect(t.contentType, declared).toBe(declared.trim());
    }
  });
});

describe("L2: on the wire", () => {
  const BASE = "content.example";
  const enc = (s: string) => new TextEncoder().encode(s);
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('/beacon')</script></svg>`;

  it("every bypass from the audit is served as octet-stream with `Content-Security-Policy: sandbox`", async () => {
    const fc = new FakeChain();
    const gw = createGateway({ chains: [{ id: 84532, contracts: fc.contracts, client: fc.client } as never], hostMode: { baseHost: BASE }, onError: () => {} });
    const cases: Array<[string, string, string | null]> = [
      ["image/svg+xml", "image/svg+xml", "sandbox"],
      ["image/svg+xml,", "application/octet-stream", "sandbox"],
      ["image/svg+xml,x", "application/octet-stream", "sandbox"],
      ["text/xsl", "text/xsl", "sandbox"],
      ["text/html", "text/html", null],
    ];
    for (const [declared, contentType, csp] of cases) {
      const { cid } = fc.addFile([enc(`${SVG}<!-- ${declared} -->`)], declared);
      const host = `${rootContentLabel(84532, cid)}.${BASE}`;
      const res = await gw(new Request(`https://${host}/`, { headers: { host } }));
      expect(res.status, declared).toBe(200);
      expect(res.headers.get("content-type"), declared).toBe(contentType);
      expect(res.headers.get("content-security-policy"), declared).toBe(csp);
      expect(res.headers.get("x-content-type-options"), declared).toBe("nosniff");
    }
  });
});
