/**
 * Round-3 handler behaviour: a raw-root host tries every served chain, a path that names nothing is a plain 404
 * (no 307 hop), only a directory that exists is redirected, a chain that could not be read is a retryable 503,
 * and the too-large message points at somewhere else to get the bytes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** path -> isDirectory, for the project's directory root. Anything else reverts (not found). */
  paths: new Map<string, boolean>(),
  readError: null as unknown,
  resolveError: null as unknown,
  readCalls: 0,
}));

vi.mock("@artblocks/abxfs-sdk", async (orig) => {
  const real = await orig<typeof import("@artblocks/abxfs-sdk")>();
  return {
    ...real,
    getFileInfo: async () => ({
      root: `0x${"55".repeat(32)}`,
      rootLevel: 0,
      chunkCount: 1,
      size: 10,
      mimeType: (globalThis as { __stubMime?: string }).__stubMime ?? "text/plain",
      codec: `0x${"00".repeat(32)}`,
      outputHash: `0x${"00".repeat(32)}`,
    }),
    entryCount: async () => 1,
    getEntriesPage: async () => [{ name: "<img src=x onerror=1>.txt", cid: `0x${"44".repeat(32)}`, isDirectory: false }],
    isOrg: async () => true,
    readProject: async () => ({ cid: `0x${"11".repeat(32)}`, kind: real.ProjectKind.Directory, versionCount: 1, preferredGateway: null, owner: "0x0000000000000000000000000000000000000001" }),
    resolvePath: async (_c: unknown, _a: unknown, _root: unknown, path: string) => {
      if (state.resolveError) throw state.resolveError;
      if (state.paths.has(path)) return { cid: `0x${"33".repeat(32)}`, isDirectory: state.paths.get(path)! };
      throw revertError();
    },
    readDirectory: async () => ({ entries: [] }),
    readFile: async () => {
      state.readCalls++;
      if (state.readError) throw state.readError;
      return { bytes: new TextEncoder().encode("body"), mimeType: "text/plain" };
    },
  };
});

import { LimitExceededError, asAbxfsCid, rootContentLabel } from "@artblocks/abxfs-sdk";
import { createGateway } from "../../src/handler.js";
import { revertError } from "../helpers.js";
import { __resetResolveCaches } from "../../src/resolve.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const FACTORY = "0x00000000000000000000000000000000000000e1";
const HOOK = "0x00000000000000000000000000000000000000f1";
const label = `84532-${ORG.slice(2)}-1`;

beforeEach(() => {
  __resetResolveCaches();
  state.paths = new Map([
    ["index.html", false],
    ["docs", true],
    ["docs/index.html", false],
    ["v1.2", true],
    ["v1.2/index.html", true], // no index: a listing
    ["app.js", false],
  ]);
  state.readError = null;
  state.resolveError = null;
  state.readCalls = 0;
});

const transport = () => Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError", status: 429 });

function projectGateway() {
  const chain = { id: 84532, contracts: { chunkStore: "0x00000000000000000000000000000000000000c1", directoryStore: "0x00000000000000000000000000000000000000d2", sstore2Backend: "0x00000000000000000000000000000000000000b1", fastLzBackend: "0x00000000000000000000000000000000000000b2", fileStore: ORG, orgFactory: FACTORY, projectHook: HOOK } as never, client: { readContract: async () => ({ mimeType: "text/plain" }) } as never };
  const gw = createGateway({ chains: [chain], hostMode: { baseHost: BASE }, onError: () => {} });
  return (path: string, init?: RequestInit) => gw(new Request(`http://${label}.${BASE}${path}`, { ...init, headers: { host: `${label}.${BASE}` } }));
}

describe("a path that names nothing is a plain 404; only a directory that exists is redirected", () => {
  it("/nope is a 404 straight away (no 307 to /nope/)", async () => {
    const get = projectGateway();
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await get("/nope/deeper")).status).toBe(404);
  });

  it("/docs (a directory with an index) gets its trailing slash, query kept; a directory whose name has a dot too", async () => {
    const get = projectGateway();
    const d = await get("/docs?x=1");
    expect(d.status).toBe(307);
    expect(d.headers.get("location")).toBe("/docs/?x=1");
    expect(d.headers.get("cache-control")).toBe("no-store");
    const dotted = await get("/v1.2");
    expect(dotted.status).toBe(307);
    expect(dotted.headers.get("location")).toBe("/v1.2/");
  });

  it("a file, the root, and a slashed directory are served as before", async () => {
    const get = projectGateway();
    expect((await get("/app.js")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
    expect((await get("/docs/")).status).toBe(200);
  });
});

describe("the chain could not be read: a retryable 503, never a 404", () => {
  it("a transport failure while resolving a path is 503 with Retry-After and no-store (it used to read as 'not found')", async () => {
    state.resolveError = transport();
    const res = await projectGateway()("/docs/");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toMatch(/not found/i);
  });

  it("the too-large 413 says where else to get the bytes", async () => {
    state.readError = new LimitExceededError("bytes", 10, "5");
    const res = await projectGateway()("/app.js");
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/IPFS or another ABX FS gateway/);
  });
});

describe("S3: a raw root names its chain, and only that chain is read", () => {
  const ROOT = asAbxfsCid(`0x${"ab".repeat(32)}`);

  /** A chain whose stores say `stored` (or throw `fail`) and that counts its probes. */
  function chain(id: number, mode: "has" | "lacks" | "down") {
    const probes = { n: 0 };
    return {
      probes,
      chain: {
        id,
        contracts: { chunkStore: "0x00000000000000000000000000000000000000c1", sstore2Backend: "0x00000000000000000000000000000000000000b1", fastLzBackend: "0x00000000000000000000000000000000000000b2", fileStore: ORG, directoryStore: ORG } as never,
        client: {
          readContract: async ({ functionName }: { functionName: string }) => {
            if (functionName === "fileExists" || functionName === "directoryExists") {
              probes.n++;
              if (mode === "down") throw transport();
              return mode === "has" && functionName === "fileExists";
            }
            return { mimeType: "text/plain" };
          },
        } as never,
      },
    };
  }
  const make = (a: ReturnType<typeof chain>, b: ReturnType<typeof chain>, chainId: number) => {
    const gw = createGateway({ chains: [a.chain, b.chain], hostMode: { baseHost: BASE }, onError: () => {} });
    const host = `${rootContentLabel(chainId, ROOT)}.${BASE}`;
    return () => gw(new Request(`http://${host}/`, { headers: { host } }));
  };

  it("serves a root from the chain its host names, and never asks another", async () => {
    const a = chain(84532, "lacks");
    const b = chain(8453, "has");
    const res = await make(a, b, 8453)();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(ROOT);
    expect(a.probes.n).toBe(0);
  });

  it("in path mode, `/cid/<chain>/<root>` reads that chain alone too", async () => {
    const a = chain(84532, "lacks");
    const b = chain(8453, "has");
    const gw = createGateway({ chains: [a.chain, b.chain], pathMode: {}, onError: () => {} });
    const res = await gw(new Request(`http://gw.example/g/cid/8453/${ROOT}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(ROOT);
    expect(a.probes.n).toBe(0);
    const bProbes = b.probes.n;
    expect((await gw(new Request(`http://gw.example/g/cid/84532/${ROOT}/`))).status).toBe(404);
    expect(b.probes.n).toBe(bProbes);
  });

  it("a root the named chain does not store is a 404, even when another served chain stores it (not cached by a shared cache)", async () => {
    const a = chain(84532, "lacks");
    const b = chain(8453, "has");
    const res = await make(a, b, 84532)();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(b.probes.n).toBe(0);
  });

  it("a chain this gateway does not serve is a 404 without a read", async () => {
    const a = chain(84532, "has");
    const b = chain(8453, "has");
    expect((await make(a, b, 1)()).status).toBe(404);
    expect(a.probes.n + b.probes.n).toBe(0);
  });

  it("a named chain that could not be asked is a 503, never 'not stored'", async () => {
    const none = await make(chain(84532, "down"), chain(8453, "has"), 84532)();
    expect(none.status).toBe(503);
    expect(none.headers.get("retry-after")).toBeTruthy();
    expect(none.headers.get("cache-control")).toBe("no-store");
  });
});
