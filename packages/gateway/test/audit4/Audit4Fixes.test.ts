/**
 * AUDIT4 fixes in the handler: a deadline on every request, a root read on its own chain only, a cached 413 that reads no
 * chunks the second time, a generic body for a configuration fault, and `Range`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  readCalls: 0,
  readError: null as unknown,
  bytes: new TextEncoder().encode("0123456789"),
  cidKindCalls: 0,
}));
vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
  return {
    ...real,
    // The file is one chunk holding `state.bytes`: enough for the handler's whole-file, size-cap and Range paths.
    getFileInfo: async () => ({
      root: `0x${"55".repeat(32)}`,
      rootLevel: 0,
      chunkCount: 1,
      size: state.bytes.length,
      mimeType: "text/plain",
      codec: `0x${"00".repeat(32)}`,
      outputHash: `0x${"00".repeat(32)}`,
    }),
    locateByte: async () => ({ index: 0, chunkStart: 0, chunkId: `0x${"66".repeat(32)}`, chunkSize: state.bytes.length }),
    getChunkIdsPage: async () => [`0x${"66".repeat(32)}`],
    readChunkSlices: async () => {
      state.readCalls++;
      if (state.readError) throw state.readError;
      return [state.bytes];
    },
    locateContent: async (client: { kind: () => Promise<number> }) => {
      state.cidKindCalls++;
      return { kind: await client.kind() };
    },
    isOrg: async () => true,
    readProject: async () => ({ cid: `0x${"11".repeat(32)}`, kind: real.ProjectKind.File, versionCount: 1, preferredGateway: null, owner: "0x1" }),
    cidKind: async (client: { kind: () => Promise<number> }) => {
      state.cidKindCalls++;
      return client.kind();
    },
    readFile: async () => {
      state.readCalls++;
      if (state.readError) throw state.readError;
      return { bytes: state.bytes, mimeType: "text/plain" };
    },
  };
});

import { LimitExceededError, ProjectKind, asAbxfsCid, rootContentLabel } from "@abxfs/sdk";
import { createGateway, byteRange, GatewayError } from "../../src/index.js";
import { __resetResolveCaches } from "../../src/resolve.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const ROOT = asAbxfsCid(`0x${"cd".repeat(32)}`);
const contracts = { chunkStore: "0x00000000000000000000000000000000000000c1", directoryStore: "0x00000000000000000000000000000000000000d2", sstore2Backend: "0x00000000000000000000000000000000000000b1", fastLzBackend: "0x00000000000000000000000000000000000000b2", fileStore: ORG, orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" } as never;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  __resetResolveCaches();
  state.readCalls = 0;
  state.readError = null;
  state.cidKindCalls = 0;
  state.bytes = new TextEncoder().encode("0123456789");
});

const projectGw = (extra: Record<string, unknown> = {}) =>
  createGateway({ chains: [{ id: 84532, contracts, client: {} as never }], hostMode: { baseHost: BASE }, onError: () => {}, ...extra });
const get = (gw: ReturnType<typeof createGateway>, host: string, path = "/", headers: Record<string, string> = {}, method = "GET") =>
  gw(new Request(`http://${host}${path}`, { method, headers: { host, ...headers } }));
const PROJECT_HOST = `84532-${ORG.slice(2)}-1.${BASE}`;
const ROOT_HOST = `${rootContentLabel(84532, ROOT)}.${BASE}`;

describe("per-request deadline", () => {
  it("a read that never answers becomes a 503 with no-store and Retry-After at the deadline", async () => {
    const hung = createGateway({
      chains: [{ id: 84532, contracts, client: {} as never }],
      hostMode: { baseHost: BASE },
      requestTimeoutMs: 150,
      onError: () => {},
      filter: () => never(),
    });
    const t = Date.now();
    const res = await get(hung, PROJECT_HOST);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("a root host reads the chain it names, and no other", () => {
  const mk = (id: number, kind: () => Promise<number>) => ({ id, contracts, client: { kind } as never });

  it("a hung chain the URL does not name cannot hold the request", async () => {
    const gw = createGateway({
      chains: [mk(84532, async () => ProjectKind.File), mk(8453, never)],
      hostMode: { baseHost: BASE },
      onError: () => {},
    });
    const t = Date.now();
    expect((await get(gw, ROOT_HOST)).status).toBe(200);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("a chain that errors is never read as 'not stored': 503, not 404", async () => {
    const gw = createGateway({
      chains: [mk(84532, async () => { throw new Error("socket hang up"); }), mk(8453, async () => ProjectKind.File)],
      hostMode: { baseHost: BASE },
      onError: () => {},
    });
    const res = await get(gw, ROOT_HOST);
    expect([503, 502]).toContain(res.status);
    expect(res.status).not.toBe(404);
  });

  it("an unknown root costs one probe, and is remembered for seconds: a repeat costs none", async () => {
    const gw = createGateway({
      chains: [mk(84532, async () => ProjectKind.Unset), mk(8453, async () => ProjectKind.File)],
      hostMode: { baseHost: BASE },
      onError: () => {},
    });
    expect((await get(gw, ROOT_HOST)).status).toBe(404);
    expect(state.cidKindCalls).toBe(1);
    for (let i = 0; i < 5; i++) expect((await get(gw, ROOT_HOST)).status).toBe(404);
    expect(state.cidKindCalls).toBe(1);
  });
});

describe("a file over the limit", () => {
  it("is refused once, remembered, and held by shared caches (an hour for a root, a minute for a project)", async () => {
    state.readError = new LimitExceededError("bytes", 10, "file");
    const gw = createGateway({
      chains: [{ id: 84532, contracts, client: { kind: async () => ProjectKind.File } as never }],
      hostMode: { baseHost: BASE },
      maxFileBytes: 10,
      onError: () => {},
    });
    const first = await get(gw, ROOT_HOST);
    expect(first.status).toBe(413);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600, stale-while-revalidate=0");
    expect(state.readCalls).toBe(1);
    for (let i = 0; i < 3; i++) {
      const again = await get(gw, ROOT_HOST);
      expect(again.status).toBe(413);
      expect(again.headers.get("cache-control")).toContain("s-maxage=3600");
    }
    expect(state.readCalls).toBe(1); // no chunk read after the first refusal
    const viaProject = await get(gw, PROJECT_HOST);
    expect(viaProject.status).toBe(413);
    expect(viaProject.headers.get("cache-control")).toContain("s-maxage=60");
  });
});

describe("a configuration fault is the operator's to read", () => {
  it("a 500 names no environment variable to the visitor and is logged once", async () => {
    const logged: string[] = [];
    const gw = createGateway({
      chains: () => {
        throw new GatewayError("no RPC configured for chain 84532 — set ABXFS_RPC_URL_84532 or ABXFS_RPC_URL", 500);
      },
      hostMode: { baseHost: BASE },
      onError: (d) => logged.push(d),
    });
    const res = await get(gw, PROJECT_HOST);
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).not.toMatch(/ABXFS_|RPC_URL|env/i);
    expect(logged.join("\n")).toMatch(/ABXFS_RPC_URL_84532/);
  });
});

describe("Range", () => {
  const first = async (headers: Record<string, string> = {}, method = "GET") => get(projectGw(), PROJECT_HOST, "/", headers, method);

  it("bytes=a-b, bytes=a-, bytes=-n answer 206 with Content-Range and the right slice", async () => {
    const full = await first();
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    for (const [range, want, cr] of [
      ["bytes=2-4", "234", "bytes 2-4/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=8-999", "89", "bytes 8-9/10"],
      ["bytes=-999", "0123456789", "bytes 0-9/10"],
      ["bytes=0-0", "0", "bytes 0-0/10"],
    ] as const) {
      const res = await first({ range });
      expect(res.status, range).toBe(206);
      expect(await res.text(), range).toBe(want);
      expect(res.headers.get("content-range"), range).toBe(cr);
      expect(res.headers.get("content-length"), range).toBe(String(want.length));
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("etag")).toBe(full.headers.get("etag"));
    }
  });

  it("an unsatisfiable range is a 416 with `bytes */len`", async () => {
    for (const range of ["bytes=10-", "bytes=10-20", "bytes=-0", "bytes=99-"]) {
      const res = await first({ range });
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe("bytes */10");
    }
  });

  it("several ranges, another unit and noise get the whole file with 200", async () => {
    for (const range of ["bytes=0-1,4-5", "items=0-1", "bytes=", "bytes=-", "bytes=5-2", "garbage", "bytes=a-b"]) {
      const res = await first({ range });
      expect(res.status, range).toBe(200);
      expect(await res.text(), range).toBe("0123456789");
    }
  });

  it("If-Range: honoured with the ETag, the whole file when it is not ours", async () => {
    const etag = (await first()).headers.get("etag")!;
    expect((await first({ range: "bytes=0-1", "if-range": etag })).status).toBe(206);
    expect((await first({ range: "bytes=0-1", "if-range": '"other"' })).status).toBe(200);
    expect((await first({ range: "bytes=0-1", "if-range": "Wed, 21 Oct 2015 07:28:00 GMT" })).status).toBe(200);
  });

  it("HEAD reports what GET would, with no body", async () => {
    const plain = await first({}, "HEAD");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-length")).toBe("10");
    expect(plain.headers.get("accept-ranges")).toBe("bytes");
    expect(await plain.text()).toBe("");
    const ranged = await first({ range: "bytes=2-4" }, "HEAD");
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(ranged.headers.get("content-length")).toBe("3");
    expect(await ranged.text()).toBe("");
  });

  it("an empty file satisfies no range", () => {
    expect(byteRange("bytes=0-", null, '"x"', 0)).toBe("unsatisfiable");
    expect(byteRange("bytes=-5", null, '"x"', 0)).toBe("unsatisfiable");
  });

  it("If-None-Match still wins over a range (304)", async () => {
    const etag = (await first()).headers.get("etag")!;
    expect((await first({ range: "bytes=0-1", "if-none-match": etag })).status).toBe(304);
  });
});

describe("singleFlight", () => {
  it("shares one in-flight promise per key, cleans up on success AND failure, and never remembers a failure", async () => {
    const { singleFlight } = await import("../../src/upstream.js");
    const flights = new Map<string, Promise<number>>();
    let runs = 0;
    const ok = () => (runs++, delay(10).then(() => 7));
    const results = await Promise.all(Array.from({ length: 20 }, () => singleFlight(flights, "k", ok)));
    expect(new Set(results)).toEqual(new Set([7]));
    expect(runs).toBe(1);
    expect(flights.size).toBe(0);
    const boom = () => (runs++, delay(5).then(() => Promise.reject(new Error("boom"))));
    await Promise.all([singleFlight(flights, "k", boom).catch(() => 0), singleFlight(flights, "k", boom).catch(() => 0)]);
    expect(flights.size).toBe(0);
    expect(await singleFlight(flights, "k", async () => 9)).toBe(9); // the failure was not remembered
  });

  it("is bounded: past the limit the work simply runs unshared", async () => {
    const { singleFlight } = await import("../../src/upstream.js");
    const flights = new Map<string, Promise<number>>();
    let runs = 0;
    const work = () => (runs++, delay(10).then(() => 1));
    const pending = [singleFlight(flights, "a", work, 1), singleFlight(flights, "b", work, 1), singleFlight(flights, "b", work, 1)];
    await Promise.all(pending);
    expect(runs).toBe(3);
    expect(flights.size).toBe(0);
  });
});
