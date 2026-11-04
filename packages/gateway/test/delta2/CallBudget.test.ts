/**
 * DELTA-2 L2: 9db20c7 made a spent chunk-read call budget (`LimitExceededError`, limit `calls`) a retryable 503 that
 * nothing remembered, on the theory that it was transient. It is not: the SDK spends that budget only on calls the node
 * ANSWERED (a revert, an out-of-gas result, a malformed reply) and rethrows a transport failure at once, so a file whose
 * backend refuses multi-chunk reads fails the same way on every attempt, and every request spent the whole budget again.
 *
 * Now it is remembered per CID (and per range) for a minute, a 502 that says what happened, with a short `s-maxage`:
 * never the oversize 413.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ readCalls: 0, locateCalls: 0, readError: null as unknown, locateError: null as unknown }));

vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
  return {
    ...real,
    getFileInfo: async () => ({
      root: `0x${"55".repeat(32)}`,
      rootLevel: 0,
      chunkCount: 7,
      size: 70,
      mimeType: "video/mp4",
      codec: `0x${"00".repeat(32)}`,
      outputHash: `0x${"00".repeat(32)}`,
    }),
    isOrg: async () => true,
    readProject: async () => ({ cid: `0x${"11".repeat(32)}`, kind: real.ProjectKind.File, versionCount: 1, preferredGateway: null, owner: "0x0000000000000000000000000000000000000001" }),
    readFile: async () => {
      state.readCalls++;
      if (state.readError) throw state.readError;
      return { bytes: new Uint8Array(70), mimeType: "video/mp4" };
    },
    // The ranged path's first read: where it fails, the range fails.
    locateByte: async () => {
      state.locateCalls++;
      if (state.locateError) throw state.locateError;
      throw new Error("not under test");
    },
  };
});

import { LimitExceededError, readChunkSlices } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const host = `84532-${ORG.slice(2)}-1.${BASE}`;
const mkChain = () => ({
  id: 84532,
  contracts: {
    chunkStore: "0x00000000000000000000000000000000000000c1",
    directoryStore: "0x00000000000000000000000000000000000000d2",
    sstore2Backend: "0x00000000000000000000000000000000000000b1",
    fastLzBackend: "0x00000000000000000000000000000000000000b2",
    fileStore: "0x00000000000000000000000000000000000000f1",
    orgFactory: "0x00000000000000000000000000000000000000e1",
    projectHook: "0x00000000000000000000000000000000000000f1",
  } as never,
  client: {} as never,
});
function gateway() {
  const gw = createGateway({ chains: [mkChain()], defaultChainId: 84532, hostMode: { baseHost: BASE }, onError: () => {} });
  return (headers: Record<string, string> = {}) => gw(new Request(`http://${host}/`, { headers: { host, ...headers } }));
}

beforeEach(() => {
  __resetResolveCaches();
  state.readCalls = 0;
  state.locateCalls = 0;
  state.readError = null;
  state.locateError = null;
});

describe("the premise: a spent call budget is a property of the file, not of the moment", () => {
  it("a file whose chunks read only one at a time fails with limit 'calls' on every attempt", async () => {
    const addresses = {
      chunkStore: "0x00000000000000000000000000000000000000c1",
      sstore2Backend: "0x00000000000000000000000000000000000000b1",
      fastLzBackend: "0x00000000000000000000000000000000000000b2",
      fileStore: "0x00000000000000000000000000000000000000f1",
      directoryStore: "0x00000000000000000000000000000000000000d1",
    } as never;
    let calls = 0;
    const client = {
      simulateContract: async ({ args }: { args: [string[]] }) => {
        calls++;
        // A backend whose read is too costly in company (or reverts unless alone): the node ANSWERS, with a revert.
        if (args[0].length > 1) throw new Error("execution reverted: out of gas");
        return { result: [`0x${"00".repeat(64)}${"00".repeat(31)}01ab${"00".repeat(31)}`] };
      },
    } as never;
    const ids = Array.from({ length: 7 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`) as never;
    const spent: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      calls = 0;
      const err = await readChunkSlices(client, addresses, `0x${"31".repeat(32)}` as never, ids, 1 << 20).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LimitExceededError);
      expect((err as LimitExceededError).limit).toBe("calls");
      spent.push(calls);
    }
    // The same failure after the same number of calls, every time.
    expect(new Set(spent).size).toBe(1);
  });
});

describe("L2: the gateway remembers it", () => {
  it("five requests cost one readFile; each is the honest 502, briefly cacheable, never a 413 or a 503", async () => {
    state.readError = new LimitExceededError("calls", 10, "reading file 0x.. (7 chunks)");
    const get = gateway();
    for (let i = 0; i < 5; i++) {
      const res = await get();
      expect(res.status).toBe(502);
      expect(await res.text()).toMatch(/could not be read within the gateway's call budget/);
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=0");
      expect(res.headers.get("retry-after")).toBeNull();
    }
    expect(state.readCalls).toBe(1);
  });

  it("the 'bytes' refusal is still the remembered 413", async () => {
    state.readError = new LimitExceededError("bytes", 10, "file");
    const get = gateway();
    expect((await get()).status).toBe(413);
    expect((await get()).status).toBe(413);
    expect(state.readCalls).toBe(1);
  });

  it("any other read failure (the SDK rethrows a transport failure as it is) is still the generic 502 nothing remembers", async () => {
    state.readError = Object.assign(new Error("fetch failed https://rpc.example/KEY"), { name: "HttpRequestError" });
    const get = gateway();
    const first = await get();
    expect(first.status).toBe(502);
    expect(await first.text()).toBe("upstream error");
    expect(first.headers.get("cache-control") ?? "").not.toMatch(/s-maxage=[1-9]/);
    await get();
    expect(state.readCalls).toBe(2);
  });

  it("a ranged read's refusal is remembered for that range only: the whole file, or another range, is still read", async () => {
    state.locateError = new LimitExceededError("calls", 10, "reading file 0x.. (7 chunks)");
    const get = gateway();
    const first = await get({ range: "bytes=0-9" });
    expect(first.status).toBe(502);
    expect(first.headers.get("vary")).toMatch(/Range/i);
    expect((await get({ range: "bytes=0-9" })).status).toBe(502);
    expect(state.locateCalls).toBe(1);
    // Another range is another read.
    await get({ range: "bytes=10-19" });
    expect(state.locateCalls).toBe(2);
    // The whole file is not refused by a range's refusal.
    expect((await get()).status).toBe(200);
    expect(state.readCalls).toBe(1);
  });

  it("the whole file's refusal does not refuse a range (a few chunks may read where the whole file does not)", async () => {
    state.readError = new LimitExceededError("calls", 10, "reading file 0x.. (7 chunks)");
    const get = gateway();
    expect((await get()).status).toBe(502);
    await get({ range: "bytes=0-9" });
    expect(state.locateCalls).toBe(1);
  });
});
