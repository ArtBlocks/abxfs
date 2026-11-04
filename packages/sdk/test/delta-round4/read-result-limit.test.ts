/**
 * Delta audit round 4, L1: a node's result-length refusal.
 *
 * Erigon refuses any `eth_call` result longer than its `--rpc.returndata.limit`, 100,000 bytes by default, with
 * `-32000 "call returned result on length N exceeding --rpc.returndata.limit 100000"`. Round 3 stopped reading that as
 * a gas refusal (it is not one), so a planned slice of 8 to 10 FastLZ chunks was refused and read by halves for the
 * whole read, and a FastLZ file from 1.5 MB failed its call budget. Raw chunks never fitted: they are cheap in gas, so
 * halving the gas could not shorten their calls, and a raw file from 0.44 MB failed before round 3 as well.
 *
 * Now the read plans within the limit the node names ({@link resultLimitOf}): one refused call, then every call fits.
 * The errors are viem's own: a local JSON-RPC server answers the reader's `eth_call`s as Erigon does.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  http,
  type Hex,
  type PublicClient,
} from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { ZERO_HASH } from "../../src/cid.js";
import { isChunkReadGasRefusal, multicallReadHomogeneous, resultLimitOf } from "../../src/multicall.js";
import { ChunkUnavailableError, defaultMaxChunkReadCalls, planChunkReadSlices, readChunkSlices } from "../../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";

const RAW = "0x00000000000000000000000000000000000000b1";
const FASTLZ = "0x00000000000000000000000000000000000000b2";
const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: RAW,
  fastLzBackend: FASTLZ,
} as ContractAddresses;
const FULL = 24_575;
const TYPICAL = 18_431;
const ERIGON_DEFAULT = 100_000;
const MULTICALL = [
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
const byteOf = (chunk: Hex) => Number(BigInt(chunk) % 251n);

let size = FULL;
let backend: string = FASTLZ;
let limit = ERIGON_DEFAULT;
/** The length the node actually refuses past, when it is not the limit it names (a node that misstates it). */
let enforce: number | undefined;
/** Read calls (by their 1-based number) the node answers with a load balancer's transient `-32603 internal error`. */
let blips = new Set<number>();
/** Read calls (by their 1-based number) that revert with {@link revertData}, as a chunk the chain cannot serve does. */
let reverts = new Set<number>();
let revertData: Hex = "0x";
/** Read calls (by their 1-based number) the node refuses in its own words for running out of gas (anvil's). */
let outOfGas = new Set<number>();
/** A node that refuses EVERY read, naming the limit this gives for the call's own length (a node that lies). */
let naming: ((len: number) => number) | undefined;
/** Revert data the node answers a call that is not a multicall with, instead of an empty revert. */
let revertReason: Hex | undefined;
/** Calls that are not a multicall: the explanation of a chunk that failed alone. */
let direct = 0;
let reads = 0;
let refused = 0;
let longest = 0;
let server: Server;
let url = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Array<{ data: Hex }> };
      res.setHeader("content-type", "application/json");
      if (m.method === "eth_chainId") return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0x1" }));
      if (!m.params[0]!.data.startsWith("0xac9650d8")) {
        // Anything but a multicall (the explanation of a chunk that failed alone): no record, so the error stands.
        direct++;
        if (revertReason) {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted: exceeding --rpc.returndata.limit 10", data: revertReason } }));
        }
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted", data: "0x" } }));
      }
      const inner = (decodeFunctionData({ abi: MULTICALL, data: m.params[0]!.data }).args[0] as Hex[]).map((data) =>
        decodeFunctionData({ abi: chunkStoreAbi, data }),
      );
      let result: Hex;
      if (inner[0]!.functionName === "recordOf") {
        const rec = encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: [backend, size, ZERO_HASH, ZERO_HASH] as never });
        result = encodeFunctionResult({ abi: MULTICALL, functionName: "multicall", result: inner.map(() => rec) });
      } else {
        reads++;
        result = encodeFunctionResult({
          abi: MULTICALL,
          functionName: "multicall",
          result: inner.map((c) => {
            const b = byteOf((c.args as [Hex])[0]).toString(16).padStart(2, "0");
            return encodeAbiParameters([{ type: "bytes" }], [`0x${b.repeat(size)}` as Hex]);
          }),
        });
      }
      const len = (result.length - 2) / 2;
      if (inner[0]!.functionName === "read" && blips.has(reads)) {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "internal error" } }));
      }
      if (inner[0]!.functionName === "read" && reverts.has(reads)) {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted", data: revertData } }));
      }
      if (inner[0]!.functionName === "read" && outOfGas.has(reads)) {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "EVM error OutOfGas" } }));
      }
      if (inner[0]!.functionName === "read" && naming) {
        refused++;
        const message = `call returned result on length ${len} exceeding --rpc.returndata.limit ${naming(len)}`;
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } }));
      }
      if (len > (enforce ?? limit)) {
        refused++;
        const message = `call returned result on length ${len} exceeding --rpc.returndata.limit ${limit}`;
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message } }));
      }
      if (inner[0]!.functionName === "read") longest = Math.max(longest, len);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
// Every switch back to an honest Erigon, so that no test depends on the order the tests run in.
beforeEach(() => {
  size = FULL;
  backend = FASTLZ;
  limit = ERIGON_DEFAULT;
  enforce = undefined;
  blips = new Set();
  reverts = new Set();
  revertData = "0x";
  outOfGas = new Set();
  naming = undefined;
  revertReason = undefined;
  direct = reads = refused = longest = 0;
});

const client = () => createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;

type NodeOpts = { size: number; backend: string; limit?: number; enforce?: number; maxCalls?: number; blips?: number[]; reverts?: number[]; revertData?: Hex; outOfGas?: number[]; naming?: (len: number) => number };
async function read(n: number, opts: NodeOpts) {
  size = opts.size;
  backend = opts.backend;
  limit = opts.limit ?? ERIGON_DEFAULT;
  enforce = opts.enforce;
  blips = new Set(opts.blips ?? []);
  reverts = new Set(opts.reverts ?? []);
  revertData = opts.revertData ?? "0x";
  outOfGas = new Set(opts.outOfGas ?? []);
  naming = opts.naming;
  direct = 0;
  reads = 0;
  refused = 0;
  longest = 0;
  const parts = await readChunkSlices(client(), ADDRS, id(1), ids(n), 1e12, { maxCalls: opts.maxCalls });
  return { parts, reads, refused, longest };
}

describe("a node that names the most bytes it returns from one call (Erigon's --rpc.returndata.limit)", () => {
  it.each([
    ["FastLZ, full chunks", FULL, FASTLZ, 1000],
    ["FastLZ, typical chunks", TYPICAL, FASTLZ, 1000],
    ["raw, full chunks", FULL, RAW, 1000],
    ["raw, typical chunks", TYPICAL, RAW, 100],
    ["raw, typical chunks, one call's worth (tried as one call first)", TYPICAL, RAW, 30],
    ["FastLZ, full chunks, a blind read (no records)", FULL, FASTLZ, 8],
  ])("%s: %i bytes a chunk, %s, %i chunks: read within the default call budget", async (_label, s, b, n) => {
    const got = await read(n, { size: s, backend: b });
    expect(got.parts).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(got.parts[i]).toHaveLength(s);
      expect(got.parts[i]![0]).toBe(byteOf(id(i)));
    }
    // One refused call, then every call fits: a planned read re-plans within the limit, a blind one reads halves.
    expect(got.refused).toBe(1);
    expect(got.longest).toBeLessThanOrEqual(ERIGON_DEFAULT);
    // Every call made is within the default budget (the budget throws past it, so reaching here proves it).
    expect(got.reads).toBeLessThanOrEqual(defaultMaxChunkReadCalls(n));
  });

  it("a limit that changes nothing (every planned call fits) costs nothing", async () => {
    const got = await read(200, { size: 1_000, backend: RAW });
    expect(got.refused).toBe(0);
    expect(got.reads).toBe(Math.ceil(200 / 64));
  });

  it("a limit shorter than one chunk fails loudly within the budget, never loops", async () => {
    await expect(read(100, { size: FULL, backend: RAW, limit: 20_000 })).rejects.toThrow(/returndata\.limit 20000/);
    expect(reads).toBeLessThanOrEqual(defaultMaxChunkReadCalls(100));
  });

  it("a slice still refused once planned within the limit is read by halves: a node that misstates it cannot loop the read", async () => {
    // The node names 100,000 bytes and refuses past 80,000: the read re-plans once, then reads each slice by halves.
    const lying = { size: TYPICAL, backend: RAW, limit: ERIGON_DEFAULT, enforce: 80_000 };
    await expect(read(100, lying)).rejects.toMatchObject({ limit: "calls" });
    const got = await read(100, { ...lying, maxCalls: Infinity });
    expect(got.parts).toHaveLength(100);
    for (let i = 0; i < 100; i++) expect(got.parts[i]![0]).toBe(byteOf(id(i)));
    expect(got.longest).toBeLessThanOrEqual(80_000);
  });

  // Delta round 5, L1: only a planned call learned the limit, so one transient error at the first planned call left
  // its halves (32, 16, 8 chunks) each refused for length, and a raw read spent its budget.
  it.each([
    ["raw, typical chunks", TYPICAL, RAW, 100],
    ["raw, full chunks", FULL, RAW, 1000],
    ["FastLZ, full chunks", FULL, FASTLZ, 1000],
  ])("%s, %i chunks: a transient error at the first planned call, then the limit is learned from its parts", async (_l, s, b, n) => {
    const got = await read(n, { size: s, backend: b, blips: [1] });
    expect(got.parts).toHaveLength(n);
    for (let i = 0; i < n; i++) expect(got.parts[i]![0]).toBe(byteOf(id(i)));
    expect(got.refused).toBe(1);
    expect(got.reads).toBeLessThanOrEqual(defaultMaxChunkReadCalls(n));
  });

  it("a transient error on a call already planned within the limit is read by halves, and the read goes on", async () => {
    const got = await read(100, { size: TYPICAL, backend: RAW, blips: [3, 7] });
    expect(got.parts).toHaveLength(100);
    expect(got.reads).toBeLessThanOrEqual(defaultMaxChunkReadCalls(100));
  });

  // Delta round 5, L2: a node that named a new limit on every refusal kept a read with no call cap re-planning forever.
  it("a node that refuses every read and names a limit above the call's length: never taken, the read ends where it would", async () => {
    let k = 0;
    await expect(read(100, { size: TYPICAL, backend: RAW, maxCalls: Infinity, naming: () => 10_000_000 - ++k })).rejects.toThrow(/returndata\.limit/);
    // The first planned call, then halves down to one chunk, which fails alone: 64, 32, 16, 8, 4, 2, 1.
    expect(reads).toBe(7);
  });

  it("a node that refuses every read and names a limit just below each call's length: each one shortens the next call", async () => {
    await expect(read(100, { size: TYPICAL, backend: RAW, maxCalls: Infinity, naming: (len) => len - 1 })).rejects.toThrow(/returndata\.limit/);
    // One chunk shorter each time, from the 64-chunk call down to one chunk, which fails alone.
    expect(reads).toBe(64);
  });

  it("one chunk longer than the node returns is the node's refusal, not a chunk the chain cannot serve", async () => {
    const err = await read(10, { size: FULL, backend: RAW, limit: 20_000 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/exceeding --rpc\.returndata\.limit 20000/);
    expect(direct).toBe(0);
  });

  // Delta round 6: a limit learned from a part of the first planned call (a `-32603` there, so it is read in halves).
  it("a limit of exactly four full chunks, learned from a part: calls of exactly that length are asked, never split again", async () => {
    const got = await read(100, { size: FULL, backend: RAW, limit: 98_880, blips: [1] });
    expect(got.parts).toHaveLength(100);
    for (let i = 0; i < 100; i++) expect(got.parts[i]![0]).toBe(byteOf(id(i)));
    expect(got.longest).toBe(98_880);
    expect(got.refused).toBe(1);
    expect(got.reads).toBe(27);
  });

  it("a limit shorter than one chunk, learned from a part: the one chunk is asked, and the node's refusal stands", async () => {
    const err = await read(100, { size: FULL, backend: RAW, limit: 20_000, blips: [1] }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/returndata\.limit 20000/);
    // The first planned call (the `-32603`), its first half (refused for length), then its first chunk (refused alone).
    expect(reads).toBe(3);
  });

  it("a node that refuses every read naming the call's own length: a limit the call is within is never taken", async () => {
    await expect(read(100, { size: TYPICAL, backend: RAW, naming: (len) => len })).rejects.toThrow(/returndata\.limit/);
    expect(reads).toBe(7);
  });

  // Delta round 6, I-3: a load balancer's `-32603` on one chunk was explained as a chunk the chain cannot serve.
  it("a transient error on one chunk alone is the node's error: only a revert is explained", async () => {
    // Two chunks, read blind: the call of both and its first half (one chunk) each meet a `-32603 internal error`.
    const err = await read(2, { size: TYPICAL, backend: RAW, blips: [1, 2] }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/internal error/);
    expect(reads).toBe(2);
    expect(direct).toBe(0);
  });

  it("a revert on one chunk alone is still explained: its record is asked for", async () => {
    const err = await read(2, { size: TYPICAL, backend: RAW, reverts: [1, 2] }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/execution reverted/);
    expect(reads).toBe(2);
    // This node has no record for it, so the revert stands; a backend with a record is `content-reads.test.ts`'s.
    expect(direct).toBe(1);
  });

  // Delta round 7: a revert and a gas refusal are told apart by their own rules. A revert that is not a gas refusal
  // (ChunkStore's own `ChunkNotFound`) is explained; the node's own out-of-gas words, which are not a revert, are not.
  it("a revert that is not a gas refusal, on one chunk alone, is explained", async () => {
    const notFound = encodeErrorResult({ abi: chunkStoreAbi, errorName: "ChunkNotFound", args: [id(0)] });
    const err = await read(2, { size: TYPICAL, backend: RAW, reverts: [1, 2], revertData: notFound }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/ChunkNotFound/);
    expect(direct).toBe(1);
  });

  it("the node's own out-of-gas words, on one chunk alone, are its error: never explained", async () => {
    const err = await read(2, { size: TYPICAL, backend: RAW, outOfGas: [1, 2] }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/OutOfGas/);
    expect(direct).toBe(0);
  });
});

describe("planning within a result limit", () => {
  const records = (n: number, s: number, b: string) => Array.from({ length: n }, () => ({ backend: b as `0x${string}`, size: s }));

  it("counts the bytes a call returns exactly: four full chunks are 98,880 bytes", async () => {
    // multicall's offset and length, four element offsets, and per element read's offset, length and padded data.
    expect(planChunkReadSlices(records(8, FULL, RAW), ADDRS, undefined, 98_880)).toEqual([[0, 4], [4, 8]]);
    expect(planChunkReadSlices(records(8, FULL, RAW), ADDRS, undefined, 98_879)).toEqual([[0, 3], [3, 6], [6, 8]]);
    // ...and it is what a node returns for them.
    size = FULL;
    enforce = undefined;
    limit = Infinity;
    await multicallReadHomogeneous(client(), chunkStoreAbi as never, ADDRS.chunkStore, "read", ids(4).map((x) => [x]));
    expect(longest).toBe(98_880);
  });

  it("always plans at least one chunk a call, and no limit is no limit", () => {
    expect(planChunkReadSlices(records(3, FULL, RAW), ADDRS, undefined, 1)).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(planChunkReadSlices(records(3, FULL, RAW), ADDRS)).toEqual([[0, 3]]);
  });
});

describe("resultLimitOf", () => {
  const rpc = (code: number, message: string, data?: string) => {
    const e = new Error(message) as Error & { code: number; data?: string };
    e.code = code;
    if (data !== undefined) e.data = data;
    return e;
  };

  it("reads Erigon's limit from its words, and from a viem error that wraps them", async () => {
    expect(resultLimitOf(rpc(-32000, "call returned result on length 196480 exceeding --rpc.returndata.limit 100000"))).toBe(100_000);
    size = FULL;
    enforce = undefined;
    limit = 1_000;
    const err = await multicallReadHomogeneous(client(), chunkStoreAbi as never, ADDRS.chunkStore, "read", [[id(0)]]).catch((e: unknown) => e);
    expect(resultLimitOf(err)).toBe(1_000);
    // It is not a gas refusal: halving the gas would not shorten the call.
    expect(isChunkReadGasRefusal(err)).toBe(false);
  });

  it("is undefined for a revert, with data or without, whatever its words say", async () => {
    // The node's own words never follow `execution reverted`: those are the contract's.
    expect(resultLimitOf(rpc(3, "execution reverted: call returned result on length 1 exceeding --rpc.returndata.limit 10"))).toBeUndefined();
    expect(resultLimitOf(rpc(-32000, "execution reverted: exceeding --rpc.returndata.limit 10"))).toBeUndefined();
    // Through viem, where a decoded reason is in the message.
    const reason = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "r", type: "string" }] }], errorName: "Error", args: ["exceeding --rpc.returndata.limit 10"] });
    const viaViem = await client()
      .request({ method: "eth_call", params: [{ to: ADDRS.fileStore, data: "0x12345678" }, "latest"] } as never)
      .catch((e: unknown) => e);
    expect(resultLimitOf(viaViem)).toBeUndefined(); // the mock's plain revert
    revertReason = reason;
    const decoded = await client()
      .request({ method: "eth_call", params: [{ to: ADDRS.fileStore, data: "0x12345678" }, "latest"] } as never)
      .catch((e: unknown) => e);
    revertReason = undefined;
    expect(String(decoded)).toMatch(/returndata\.limit 10/);
    expect(resultLimitOf(decoded)).toBeUndefined();
  });

  it("is undefined for anything else: other words, a revert, a zero or absurd limit", () => {
    expect(resultLimitOf(rpc(-32000, "out of gas"))).toBeUndefined();
    expect(resultLimitOf(rpc(-32603, "internal error"))).toBeUndefined();
    expect(resultLimitOf(rpc(-32000, "exceeding --rpc.returndata.limit 0"))).toBeUndefined();
    expect(resultLimitOf(rpc(-32000, `exceeding --rpc.returndata.limit ${"9".repeat(30)}`))).toBeUndefined();
    // A contract's revert reason can say anything: revert data is never read as the node's limit.
    const reason = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "r", type: "string" }] }],
      errorName: "Error",
      args: ["exceeding --rpc.returndata.limit 10"],
    });
    expect(resultLimitOf(rpc(3, "execution reverted", reason))).toBeUndefined();
  });

  it("is undefined for a failure of the connection", () => {
    const e = new Error("exceeding --rpc.returndata.limit 100000") as Error & { status: number };
    e.status = 429;
    expect(resultLimitOf(e)).toBeUndefined();
  });
});
