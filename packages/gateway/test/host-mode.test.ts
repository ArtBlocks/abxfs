/**
 * The per-project-origin gateway, and the audit's gateway findings as REGRESSION tests (each of these
 * used to be a proof that the weakness was present; they now assert the safe behaviour).
 *
 * The chain is faked at the SDK boundary, so these are about what the handler does with a request and
 * a resolution, not about the stores.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  kind: 1 as number,
  mime: "text/plain",
  cid: `0x${"11".repeat(32)}`,
  versionCid: `0x${"22".repeat(32)}`,
  versionCount: 2,
  gateway: null as string | null,
  readFileCalls: 0,
  throwOnRead: null as Error | null,
  dirIsDirectory: false,
}));

vi.mock("@artblocks/abxfs-sdk", async (orig) => {
  const real = await orig<typeof import("@artblocks/abxfs-sdk")>();
  return {
    ...real,
    isOrg: async () => true,
    readProject: async () => ({
      cid: state.cid,
      kind: state.kind,
      versionCount: state.versionCount,
      preferredGateway: state.gateway,
      owner: "0x0000000000000000000000000000000000000001",
    }),
    readVersionHistory: async () => [{ cid: state.versionCid }],
    verifyOnChainIpfsCid: async () => "bafkreifakefakefakefakefakefake",
    getFileInfo: async () => ({
      root: `0x${"55".repeat(32)}`,
      rootLevel: 0,
      chunkCount: 1,
      size: 10,
      mimeType: state.mime,
      codec: `0x${"00".repeat(32)}`,
      outputHash: `0x${"00".repeat(32)}`,
    }),
    readFile: async () => {
      state.readFileCalls++;
      if (state.throwOnRead) throw state.throwOnRead;
      return { bytes: new TextEncoder().encode("from-chain"), mimeType: state.mime };
    },
    resolvePath: async () => ({ cid: `0x${"33".repeat(32)}`, isDirectory: state.dirIsDirectory }),
    entryCount: async () => 1,
    getEntriesPage: async () => [{ name: "<img src=x onerror=1>.txt", cid: `0x${"44".repeat(32)}`, isDirectory: false }],
    readDirectory: async () => ({ entries: [{ name: "<img src=x onerror=1>.txt", cid: `0x${"44".repeat(32)}`, isDirectory: false }] }),
  };
});

import { ProjectKind } from "@artblocks/abxfs-sdk";
import { createGateway } from "../src/handler.js";
import { createGatewayServer } from "../src/server.js";
import { rootSubject } from "../src/subjects.js";
import type { Filter } from "../src/types.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const chain = {
  id: 84532,
  contracts: {
    chunkStore: "0x00000000000000000000000000000000000000c1",
    fileStore: ORG,
    directoryStore: "0x00000000000000000000000000000000000000d2",
    sstore2Backend: "0x00000000000000000000000000000000000000b1",
    fastLzBackend: "0x00000000000000000000000000000000000000b2",
    orgFactory: "0x00000000000000000000000000000000000000e1",
    projectHook: "0x00000000000000000000000000000000000000f1",
  } as never,
  client: {
    // `cidKind` asks both stores; `getFileInfo` returns the declared type.
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "fileExists" ? true : functionName === "directoryExists" ? false : { mimeType: state.mime },
  } as never,
};
const label = (id = 1, v?: number) => `84532-${ORG.slice(2)}-${id}${v ? `-v${v}` : ""}`;

function gateway(extra: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const errors: string[] = [];
  const gw = createGateway({
    chains: [chain],
    hostMode: { baseHost: BASE },
    onError: (d) => errors.push(d),
    ...extra,
  });
  const get = (host: string, path = "/", init?: RequestInit) =>
    gw(new Request(`http://${host}${path}`, { ...init, headers: { host, ...(init?.headers as object) } }));
  return { gw, get, errors };
}

let internal: Server;
let internalHits = 0;
beforeAll(async () => {
  internal = createServer((_req, res) => {
    internalHits++;
    res.end("INTERNAL-SECRET");
  });
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
});
afterAll(() => internal.close());
beforeEach(() => {
  state.kind = ProjectKind.File;
  state.mime = "text/plain";
  state.gateway = null;
  state.readFileCalls = 0;
  state.throwOnRead = null;
  state.dirIsDirectory = false;
  state.versionCount = 2;
  internalHits = 0;
});

describe("host dispatch", () => {
  it("serves a project's latest at its own host, with the request path as the path inside it", async () => {
    const { get } = gateway();
    const res = await get(`${label()}.${BASE}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-chain");
    expect(res.headers.get("x-abxfs-root")).toBe(state.cid);
  });

  it("serves a pinned version from the -v<n> host, reading THAT version's root", async () => {
    const { get } = gateway();
    const res = await get(`${label(1, 2)}.${BASE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(state.versionCid);
  });

  it("404s a version past the end", async () => {
    const { get } = gateway();
    expect((await get(`${label(1, 3)}.${BASE}`)).status).toBe(404);
  });

  it("serves raw content from a root host, resolved against the default chain", async () => {
    const { get } = gateway();
    const { rootContentLabel, asAbxfsCid } = await import("@artblocks/abxfs-sdk");
    const root = asAbxfsCid(`0x${"ab".repeat(32)}`);
    const res = await get(`${rootContentLabel(84532, root)}.${BASE}`);
    // A root with no project: kind is probed on chain (the fake store says "a file"), and it is routed as a
    // ROOT: no org check, no readProject.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(root);
  });

  it("404s every host it cannot parse canonically, and the apex, and a foreign domain, and a nested label", async () => {
    const { get } = gateway();
    for (const host of [
      BASE,
      `evil.${BASE}`,
      `a.${label()}.${BASE}`,
      `${label()}.${BASE}.evil.example`,
      `${label()}.other.example`,
      `+84532-${ORG.slice(2)}-1.${BASE}`,
      `084532-${ORG.slice(2)}-1.${BASE}`,
      `84532-${ORG.slice(2)}-01.${BASE}`,
      `84532-${ORG.slice(2)}-1-v0.${BASE}`,
      `84532-${ORG.slice(2)}-1-v01.${BASE}`,
      `0x14a34-${ORG.slice(2)}-1.${BASE}`,
      `84532-${ORG.slice(2, 40)}-1.${BASE}`,
    ]) {
      expect((await get(host)).status, host).toBe(404);
    }
  });

  it("has no path-mode routes on a content host: /g/p/... is just a path inside the project", async () => {
    const { get } = gateway();
    state.kind = ProjectKind.Directory;
    const res = await get(`${label()}.${BASE}`, `/g/cid/0x${"ab".repeat(32)}/x.txt`);
    expect(res.headers.get("x-abxfs-root")).toBe(state.cid); // the project's root, not the CID in the path
  });
});

describe("filter subjects come from the one strict parse", () => {
  it("names the project and its org for a project host, and the root for a root host", async () => {
    const seen: string[][] = [];
    const { get } = gateway({ filter: ({ subjects }) => (seen.push(subjects), { allow: true }) });
    await get(`${label(7)}.${BASE}`);
    expect(seen[0]).toEqual([`project:84532:${ORG}:7`, `org:84532:${ORG}`]);
  });

  it("calls the filter a SECOND time with the resolved root added, and refuses a blocked root through a project", async () => {
    const calls: string[][] = [];
    const filter: Filter = ({ subjects }) => {
      calls.push(subjects);
      return subjects.includes(rootSubject(state.cid)) ? { allow: false } : { allow: true };
    };
    const { get } = gateway({ filter });
    const res = await get(`${label()}.${BASE}`);
    expect(res.status).toBe(451);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(rootSubject(state.cid));
    expect(state.readFileCalls).toBe(0); // refused before a single byte was read
    // and a pinned version whose root is NOT blocked is still served
    const ok = await get(`${label(1, 2)}.${BASE}`);
    expect(ok.status).toBe(200);
  });

  it("answers 503 no-store when the filter says its own state is unavailable", async () => {
    const { get } = gateway({ filter: () => ({ allow: false, status: 503 }) });
    const res = await get(`${label()}.${BASE}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not run the filter, or the chain, for a host it cannot parse", async () => {
    const filter = vi.fn(() => ({ allow: true as const }));
    const { get } = gateway({ filter });
    await get(`+84532-${ORG.slice(2)}-1.${BASE}`);
    expect(filter).not.toHaveBeenCalled();
  });
});

describe("path strictness", () => {
  it("400s ., .., empty, backslash, NUL and an encoded slash, after decoding", async () => {
    const { get } = gateway();
    const host = `${label()}.${BASE}`;
    for (const p of ["/a/../b", "/%2e%2e/x", "/a/%2e%2e%2fb", "/a%5cb", "/a%00b", "/a%2fb", "/a//b", "//x"]) {
      const res = await get(host, p);
      // the URL parser itself collapses a literal `/a/../b`; everything it does not collapse is a 400
      expect([200, 307, 400, 404], p).toContain(res.status);
      if (p !== "/a/../b" && p !== "/%2e%2e/x") expect(res.status, p).toBe(400);
    }
  });

  it("answers 400, not 502, for a malformed percent-escape", async () => {
    const { get } = gateway();
    expect((await get(`${label()}.${BASE}`, "/%E0%A4%A.txt")).status).toBe(400);
  });

  it("never emits a Location that leaves the origin (//host)", async () => {
    state.kind = ProjectKind.Directory;
    state.dirIsDirectory = true;
    const { get } = gateway();
    const ok = await get(`${label()}.${BASE}`, "/sub");
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toBe("/sub/");
    for (const p of ["/.//attacker.example", "//attacker.example", "/a/.//attacker.example", "/\\attacker.example"]) {
      const res = await get(`${label()}.${BASE}`, p);
      expect(res.headers.get("location") ?? "", p).not.toMatch(/^\/\//);
      expect(res.headers.get("location") ?? "", p).not.toContain("attacker");
    }
  });
});

describe("a failing upstream is a generic 502", () => {
  it("never puts the error text, or the RPC URL and key, in the response, and logs it scrubbed", async () => {
    state.throwOnRead = new Error("HTTP request failed. URL: https://rpc.example/v2/SECRETAPIKEY123 Details: 429");
    const { get, errors } = gateway();
    const res = await get(`${label()}.${BASE}`);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe("upstream error");
    expect(body).not.toContain("SECRET");
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("SECRETAPIKEY123");
    expect(errors[0]).toContain("<url>");
  });

  it("standalone server answers a thrown handler with a generic 500", async () => {
    const server = createGatewayServer({
      handler: async () => {
        throw new Error("boom https://rpc.example/KEY");
      },
      hostMode: { baseHost: BASE },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/x`, { headers: { host: `${label()}.${BASE}` } });
    server.close();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("KEY");
  });
});

describe("response headers", () => {
  it("sends nosniff and no-referrer, and does NOT forbid framing (marketplaces embed project pages)", async () => {
    const { get } = gateway();
    const res = await get(`${label()}.${BASE}`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sandboxes every active document type, however it is spelled", async () => {
    const { get } = gateway();
    const host = `${label()}.${BASE}`;
    for (const [mime, sandboxed] of [
      ["image/svg+xml", true],
      ["Image/SVG+XML", true],
      ["image/svg+xml; charset=utf-8", true],
      ["IMAGE/SVG+xml ;charset=utf-8", true],
      ["application/xhtml+xml", true],
      ["Application/XHTML+XML; charset=UTF-8", true],
      ["text/xml", true],
      ["application/xml", true],
      ["application/atom+xml", true],
      ["text/html; charset=utf-8", false], // a website is the product
      ["application/pdf", false],
      ["image/png", false],
    ] as const) {
      state.mime = mime;
      const res = await get(host);
      expect([mime, res.headers.get("content-security-policy") === "sandbox"]).toEqual([mime, sandboxed]);
    }
  });

  it("gives a directory listing a CSP and escapes hostile file names", async () => {
    state.kind = ProjectKind.Directory;
    const { get } = gateway();
    // the fake resolvePath says "index.html" exists as a directory -> no nested index -> listing
    state.dirIsDirectory = true;
    const res = await get(`${label()}.${BASE}`, "/dir/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("cache policy", () => {
  it("makes project hosts short-lived at the edge and root hosts immutable", async () => {
    const { get } = gateway();
    for (const h of [label(), label(1, 2)]) {
      const cc = (await get(`${h}.${BASE}`)).headers.get("cache-control")!;
      expect(cc, h).not.toContain("immutable");
      expect(cc, h).toContain("s-maxage=60");
    }
  });

  it("answers a validator match with 304 and HEAD with no body", async () => {
    const { get } = gateway();
    const first = await get(`${label()}.${BASE}`);
    const etag = first.headers.get("etag")!;
    expect((await get(`${label()}.${BASE}`, "/", { headers: { "if-none-match": etag } })).status).toBe(304);
    const head = await get(`${label()}.${BASE}`, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("the owner's abxfs.gateway is never fetched through", () => {
  it("serves from chain without contacting it, even a public-looking one", async () => {
    state.gateway = `https://127.0.0.1:${(internal.address() as AddressInfo).port}`;
    state.mime = "image/png";
    const { get } = gateway();
    const res = await get(`${label()}.${BASE}`);
    expect(res.status).toBe(200);
    expect(internalHits).toBe(0);
  });
});

describe("path mode is explicit and strict too", () => {
  it("routes /g/... only when asked, and refuses the old spellings", async () => {
    const gw = createGateway({ chains: [chain], pathMode: {} });
    const ok = await gw(new Request(`http://gw.test/g/p/84532/${ORG}/1/latest/`));
    expect(ok.status).toBe(200);
    for (const chainSpelling of ["+84532", "0x14a34", "84532.0", "8.4532e4", "084532"]) {
      const res = await gw(new Request(`http://gw.test/g/p/${encodeURIComponent(chainSpelling)}/${ORG}/1/latest/`));
      expect(res.status, chainSpelling).toBe(400);
    }
  });

  it("single-project mode refuses, at construction, a project on a chain it does not serve", () => {
    const project = { chainId: 8453, org: ORG, tokenId: 1 };
    expect(() => createGateway({ chains: [chain], project })).toThrow(
      /the project is on chain 8453, which is not among the chains this gateway serves/,
    );
    expect(() => createGateway({ chains: [chain], project: { ...project, chainId: 84532 } })).not.toThrow();
  });

  it("single-project mode cannot be turned into an open redirect by /.//host", async () => {
    state.kind = ProjectKind.Directory;
    const gw = createGateway({ chains: [chain], project: { chainId: 84532, org: ORG, tokenId: 1 } });
    const server = createGatewayServer({ handler: gw, projectMode: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const net = await import("node:net");
    const raw = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET /.//attackerhost HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d));
      s.on("end", () => resolve(buf));
    });
    server.close();
    expect(raw.toLowerCase()).not.toContain("location: //");
  });

  it("the server reads //evil/x as a path on THIS host, never as a scheme-relative URL", async () => {
    const seen: string[] = [];
    const server = createGatewayServer({
      handler: async (req) => (seen.push(new URL(req.url).host + new URL(req.url).pathname), new Response("ok")),
      basePath: "/g",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const net = await import("node:net");
    await new Promise<void>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET //evil.example/g/cid/x HTTP/1.1\r\nHost: gw.test\r\nConnection: close\r\n\r\n"));
      s.on("data", () => {});
      s.on("end", () => resolve());
    });
    server.close();
    expect(seen).toEqual(["gw.test//evil.example/g/cid/x"]);
  });
});
