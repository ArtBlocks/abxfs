/**
 * AUDIT 9, L1: a file whose codec this gateway cannot decode (any label but gzip/deflate: br, zstd, a made-up token),
 * or whose decoded content does not match its `outputHash`, was read IN FULL from chain on every request and answered
 * a generic `502 upstream error`, `no-store`. The chain accepts any non-zero (codec, outputHash) pair for one SSTORE.
 * Now a missing decoder is known from the file record alone (one call, no chunk), both are remembered, and the answer
 * says what happened and may be cached.
 *
 * Also N1 (a negative result kept as a regression test): a gzip bomb stops at the inflate cap and is a cached 413.
 */
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { codecLabel, rootContentLabel } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { FakeChain, chunkBytes } from "../fake-chain.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";

beforeEach(() => __resetResolveCaches());

/** A file whose record declares `codec`/`outputHash` (the fake stores none, so `getFileInfo` is rewritten). */
function setup(chunks: Uint8Array[], codec: string, outputHash: string, mime = "text/html") {
  const fc = new FakeChain();
  const { cid } = fc.addFile(chunks, mime);
  const inner = fc.client as { readContract: (a: { functionName: string }) => Promise<unknown> };
  const client = {
    ...(inner as object),
    readContract: async (a: { functionName: string }) => {
      const r = await inner.readContract(a);
      return a.functionName === "getFileInfo" ? { ...(r as object), codec, outputHash } : r;
    },
  };
  const chain = { id: 84532, contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" }, client };
  const errors: string[] = [];
  const gw = createGateway({ chains: [chain as never], hostMode: { baseHost: BASE }, maxFileBytes: 4 * 1024 * 1024, onError: (e) => errors.push(e) });
  const host = `${rootContentLabel(84532, cid)}.${BASE}`;
  const get = (headers: Record<string, string> = {}, h = host) => gw(new Request(`https://${h}/`, { headers: { host: h, ...headers } }));
  return { fc, cid, get, errors, gw };
}

const OUT = `0x${"ab".repeat(32)}`;
const chunks200 = () => Array.from({ length: 200 }, (_, i) => chunkBytes(i, 16 * 1024));

describe("L1: a codec this gateway cannot decode", () => {
  for (const [name, token] of [
    ["br (registered nowhere here by default)", "br"],
    ["a made-up token", "x"],
  ] as const) {
    it(`${name}: 501 that says so, cacheable, for one record read and no chunk`, async () => {
      const { fc, get, errors } = setup(chunks200(), codecLabel(token), OUT);
      const res = await get();
      expect(res.status).toBe(501);
      const body = await res.text();
      expect(body).toContain(`"${token}" file codec`);
      expect(body).not.toBe("upstream error");
      expect(res.headers.get("cache-control")).toMatch(/s-maxage=3600/);
      expect(fc.count("multicall:read")).toBe(0);
      expect(fc.count("getFileInfo")).toBe(1);
      expect(errors).toEqual([]); // not an operator fault: nothing to log

      // the second request reads nothing at all, ranged or not
      fc.reset();
      expect((await get()).status).toBe(501);
      expect((await get({ range: "bytes=0-0" })).status).toBe(501);
      expect(fc.calls.filter((c) => c.fn !== "fileExists" && c.fn !== "directoryExists")).toEqual([]);
    });
  }

  it("a label that is not even a token is described without echoing its bytes", async () => {
    const { get } = setup([chunkBytes(0, 10)], `0x${"ff".repeat(32)}`, OUT);
    const res = await get();
    expect(res.status).toBe(501);
    expect(await res.text()).toContain("an unrecognised file codec");
  });

  it("through a project host the refusal is cached briefly (the project can republish)", async () => {
    const { vi } = await import("vitest");
    const sdk = await import("@abxfs/sdk");
    const fc = new FakeChain();
    const { cid } = fc.addFile([chunkBytes(0, 10)], "text/plain");
    const spy = vi.spyOn(sdk, "readProject");
    spy.mockResolvedValue({ cid, kind: sdk.ProjectKind.File, versionCount: 1, preferredGateway: null } as never);
    vi.spyOn(sdk, "isOrg").mockResolvedValue(true);
    const inner = fc.client as { readContract: (a: { functionName: string }) => Promise<unknown> };
    const client = { ...(inner as object), readContract: async (a: { functionName: string }) => { const r = await inner.readContract(a); return a.functionName === "getFileInfo" ? { ...(r as object), codec: codecLabel("zstd"), outputHash: OUT } : r; } };
    const chain = { id: 84532, contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" }, client };
    const gw = createGateway({ chains: [chain as never], hostMode: { baseHost: BASE }, onError: () => {} });
    const host = `84532-${ORG.slice(2)}-1.${BASE}`;
    const res = await gw(new Request(`https://${host}/`, { headers: { host } }));
    expect(res.status).toBe(501);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=60\b/);
    vi.restoreAllMocks();
  });
});

describe("L1: decoded content that does not match outputHash", () => {
  it("gzip with a wrong outputHash: a cacheable 502 that says what happened, remembered", async () => {
    const content = new Uint8Array(512 * 1024).fill(0x41);
    const gz = new Uint8Array(gzipSync(content));
    const { fc, get, errors } = setup([gz], codecLabel("gzip"), `0x${"cd".repeat(32)}`, "text/plain");
    const res = await get();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toMatch(/outputHash mismatch/);
    expect(body).not.toBe("upstream error");
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=3600/);
    expect(errors).toEqual([]);
    fc.reset();
    expect((await get()).status).toBe(502);
    expect(fc.count("multicall:read")).toBe(0);
    expect(fc.count("getFileInfo")).toBe(0);
  });

  it("gzip with the RIGHT outputHash is served", async () => {
    const { keccak256 } = await import("viem");
    const content = new TextEncoder().encode("hello, compressed world");
    const { get } = setup([new Uint8Array(gzipSync(content))], codecLabel("gzip"), keccak256(content), "text/plain");
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello, compressed world");
  });
});

describe("N1: a gzip bomb", () => {
  it("64 MiB of zeros in a few KiB of gzip: refused at the 4 MiB cap, then a cached 413 that reads nothing", async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 }));
    const { fc, get } = setup([bomb], codecLabel("gzip"), OUT);
    const res = await get();
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=3600/);
    fc.reset();
    expect((await get()).status).toBe(413);
    expect(fc.count("multicall:read")).toBe(0);
  });
});
