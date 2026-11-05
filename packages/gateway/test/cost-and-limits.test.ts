/**
 * Re-audit round 2 fixes in the handler: what a request for a nonexistent project costs, the per-file
 * size cap, and the extra headers on a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generation: { projectHook: "0x00000000000000000000000000000000000000f1" } as unknown,
  generationCalls: 0,
  projectCalls: 0,
  projectThrows: false,
  cid: `0x${"11".repeat(32)}` as string | null,
  readOptions: null as unknown,
  readError: null as unknown,
  readCalls: 0,
}));

vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
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
    isOrg: async () => {
      state.generationCalls++;
      return state.generation !== null;
    },
    readProject: async () => {
      state.projectCalls++;
      if (state.projectThrows) throw missingTokenError();
      return { cid: state.cid, kind: real.ProjectKind.File, versionCount: 1, preferredGateway: null, owner: "0x0000000000000000000000000000000000000001" };
    },
    readFile: async (_c: unknown, _a: unknown, _cid: unknown, options: unknown) => {
      state.readOptions = options;
      state.readCalls++;
      if (state.readError) throw state.readError;
      return { bytes: new TextEncoder().encode("x"), mimeType: "text/plain" };
    },
  };
});

import { LimitExceededError } from "@abxfs/sdk";
import { createGateway } from "../src/handler.js";
import { missingTokenError } from "./helpers.js";
import { __resetResolveCaches } from "../src/resolve.js";
import { chunkBudget } from "../src/resolve.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const label = (id: number) => `84532-${ORG.slice(2)}-${id}`;
// A fresh client per test: the caches are keyed under it.
const mkChain = () => ({ id: 84532, contracts: { chunkStore: "0x00000000000000000000000000000000000000c1", directoryStore: "0x00000000000000000000000000000000000000d2", sstore2Backend: "0x00000000000000000000000000000000000000b1", fastLzBackend: "0x00000000000000000000000000000000000000b2", fileStore: ORG, orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" } as never, client: {} as never });

function gateway(extra: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const chain = mkChain();
  const gw = createGateway({ chains: [chain], hostMode: { baseHost: BASE }, onError: () => {}, ...extra });
  return (id = 1, path = "/") => {
    const host = `${label(id)}.${BASE}`;
    return gw(new Request(`http://${host}${path}`, { headers: { host } }));
  };
}

beforeEach(() => {
  __resetResolveCaches();
  state.generation = { projectHook: "0x00000000000000000000000000000000000000f1" };
  state.generationCalls = 0;
  state.projectCalls = 0;
  state.projectThrows = false;
  state.cid = `0x${"11".repeat(32)}`;
  state.readOptions = null;
  state.readError = null;
  state.readCalls = 0;
});
afterEach(() => vi.useRealTimers());

describe("cost of a request for something that is not there", () => {
  it("a registered org is looked up ONCE however many projects are asked for", async () => {
    const get = gateway();
    for (let id = 1; id <= 5; id++) expect((await get(id)).status).toBe(200);
    expect(state.generationCalls).toBe(1);
  });

  it("an address that is not an org is a 404 with a short s-maxage, and is remembered for ~5s only", async () => {
    vi.useFakeTimers();
    state.generation = null;
    const get = gateway();
    const first = await get(1);
    expect(first.status).toBe(404);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=5, stale-while-revalidate=0");
    await get(2);
    await get(1);
    expect(state.generationCalls).toBe(1);
    vi.advanceTimersByTime(6_000);
    state.generation = { projectHook: "0x00000000000000000000000000000000000000f1" };
    expect((await get(1)).status).toBe(200);
    expect(state.generationCalls).toBe(2);
  });

  it("a token that does not exist is a short-cached 404 (5s) and costs one read per window", async () => {
    state.projectThrows = true;
    const get = gateway();
    for (let i = 0; i < 4; i++) {
      const res = await get(9);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toContain("s-maxage=5,");
    }
    expect(state.projectCalls).toBe(1);
    await get(10);
    expect(state.projectCalls).toBe(2);
  });

  it("a project that has published nothing is a 404 that a shared cache must NOT hold, and is re-read within seconds", async () => {
    vi.useFakeTimers();
    state.cid = null;
    const get = gateway();
    const res = await get(1);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await get(1);
    expect(state.projectCalls).toBe(1);
    // Published a moment later: visible after the (short) negative entry lapses.
    state.cid = `0x${"11".repeat(32)}`;
    vi.advanceTimersByTime(6_000);
    expect((await get(1)).status).toBe(200);
  });

  it("notFoundTtl: 0 turns the edge hold off", async () => {
    state.generation = null;
    const res = await gateway({ notFoundTtl: 0 })(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("two gateways (two clients) never share an answer", async () => {
    const a = gateway();
    expect((await a(1)).status).toBe(200);
    state.generation = null;
    const b = gateway();
    expect((await b(1)).status).toBe(404);
  });
});

describe("per-file cap", () => {
  it("passes an explicit stored and inflate cap to readFile (default 64 MiB, configurable)", async () => {
    await gateway()(1);
    const big = 64 * 1024 * 1024;
    expect(state.readOptions).toEqual({ maxInflateBytes: big, maxStoredBytes: big, maxChunks: chunkBudget(big) });
    await gateway({ maxFileBytes: 1000 })(1);
    expect(state.readOptions).toEqual({ maxInflateBytes: 1000, maxStoredBytes: 1000, maxChunks: chunkBudget(1000) });
  });

  it("answers 413 when the SDK reports the limit, or a codec reports its own", async () => {
    for (const err of [
      new LimitExceededError("bytes", 10, "file"),
      new LimitExceededError("inflate", 10, "file"),
      new Error("fastlz: output exceeds 10 bytes; refusing to inflate"),
      Object.assign(new RangeError("Cannot create a Buffer larger than 10 bytes"), { code: "ERR_BUFFER_TOO_LARGE" }),
    ]) {
      state.readError = err;
      const res = await gateway()(1);
      expect(res.status).toBe(413);
      // A fact about immutable bytes, so shared caches may keep it (briefly for a project URL, which can be republished).
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=0");
    }
  });

  it("a spent call budget is a remembered 502 with a short s-maxage, never the oversize 413: two requests, one readFile", async () => {
    // The SDK spends its call budget only on calls the node answered (reverts, out-of-gas, malformed replies) and
    // rethrows a transport failure, so a spent budget repeats on every request: it is remembered per CID, briefly.
    vi.useFakeTimers({ toFake: ["Date"] });
    state.readError = new LimitExceededError("calls", 17, "chunk read");
    const get = gateway();
    for (let i = 0; i < 2; i++) {
      const res = await get(1);
      expect(res.status).toBe(502);
      expect(await res.text()).toMatch(/^this file's chunks could not be read within the gateway's call budget/);
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=0");
      expect(res.headers.get("retry-after")).toBeNull();
    }
    expect(state.readCalls).toBe(1);
    // Briefly: a node's cap can change, so after a minute the file is read again.
    state.readError = null;
    vi.advanceTimersByTime(61_000);
    expect((await get(1)).status).toBe(200);
    expect(state.readCalls).toBe(2);
  });

  it("any other read failure is still a generic 502", async () => {
    state.readError = new Error("boom https://rpc.example/KEY");
    const res = await gateway()(1);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("upstream error");
  });
});

describe("refusal headers", () => {
  it("adds the operator's headers to a 451 (and only to a 451)", async () => {
    const get = gateway({ filter: () => ({ allow: false }), refusalHeaders: { "clear-site-data": '"cache", "storage"' } });
    const res = await get(1);
    expect(res.status).toBe(451);
    expect(res.headers.get("clear-site-data")).toBe('"cache", "storage"');
    const ok = await gateway({ refusalHeaders: { "clear-site-data": '"cache"' } })(1);
    expect(ok.headers.get("clear-site-data")).toBeNull();
  });
});
