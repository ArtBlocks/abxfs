/**
 * Delta audit round 6: the arms of a chunk read's planning that no test took (`readChunkSlices`, `read.ts`).
 *
 *  - A gas refusal inside a range read within a result limit (`readWithin`) halves the rest of the read's gas budget,
 *    as one anywhere else does.
 *  - A chunk whose record could not be read counts as a full chunk in a call's result length, so a limit is taken and
 *    planned within for it too.
 *
 * A local JSON-RPC node answers the reader's `eth_call`s: a result limit (Erigon's `--rpc.returndata.limit`), a gas cap
 * that refuses a call with ChunkStore's `RetrieveFailed` (as a backend that runs out of gas does), per-chunk sizes and
 * backends, and injected errors on chosen calls.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, decodeFunctionData, encodeErrorResult, encodeFunctionResult, http, type Hex, type PublicClient } from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { defaultMaxChunkReadCalls, readChunkSlices } from "../../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";

const RAW = "0x00000000000000000000000000000000000000b1";
const FASTLZ = "0x00000000000000000000000000000000000000b2";
/** A backend outside the address book: the reader prices its chunks like the costliest FastLZ ones. */
const OTHER = "0x00000000000000000000000000000000000000b9";
const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: RAW,
  fastLzBackend: FASTLZ,
} as ContractAddresses;
const MULTICALL = [
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;
const FULL = 24_575;
const TYPICAL = 18_431;
const BLIP = { code: -32603, message: "internal error" };
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
const indexOf = (h: Hex) => Number(BigInt(h));
const ZERO = `0x${"00".repeat(32)}` as Hex;

const node = {
  chunks: [] as Array<{ size: number; backend: string }>,
  /** The length past which the node refuses a result, naming it. */
  limit: Infinity,
  /** The gas the node simulates per call, and what each chunk costs it (a backend outside the book costs the most). */
  gasCap: Infinity,
  gasOf: (c: { size: number; backend: string }) => 30_000 + (c.backend === RAW ? 5 : c.backend === FASTLZ ? 100 : 250) * c.size,
  /** Read calls, and record calls, by 1-based number, answered with a load balancer's `-32603`. */
  readBlips: new Set<number>(),
  recordBlips: new Set<number>(),
  reads: 0,
  records: 0,
  gasRefusals: 0,
  limitRefusals: 0,
  longest: 0,
};

function setup(n: number, size: number, backendOf: (i: number) => string, o: { limit?: number; gasCap?: number; readBlips?: number[]; recordBlips?: number[] } = {}) {
  node.chunks = Array.from({ length: n }, (_, i) => ({ size, backend: backendOf(i) }));
  node.limit = o.limit ?? Infinity;
  node.gasCap = o.gasCap ?? Infinity;
  node.readBlips = new Set(o.readBlips ?? []);
  node.recordBlips = new Set(o.recordBlips ?? []);
  node.reads = node.records = node.gasRefusals = node.limitRefusals = node.longest = 0;
}

/** One chunk's `read` return: its first byte is its index mod 251. */
function readReturn(i: number, size: number): Hex {
  const data = (i % 251).toString(16).padStart(2, "0") + "ab".repeat(size - 1);
  return encodeFunctionResult({ abi: chunkStoreAbi, functionName: "read", result: `0x${data}` as Hex });
}

let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = JSON.parse(body) as { id: number; method: string; params: Array<{ data: Hex }> };
      const reply = (o: object) => res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }));
      res.setHeader("content-type", "application/json");
      if (m.method === "eth_chainId") return reply({ result: "0x1" });
      // Anything but a multicall (the explanation of a chunk that failed alone): no record, so the error stands.
      if (!m.params[0]!.data.startsWith("0xac9650d8")) return reply({ error: { code: 3, message: "execution reverted", data: "0x" } });
      const inner = (decodeFunctionData({ abi: MULTICALL, data: m.params[0]!.data }).args[0] as Hex[]).map((data) => decodeFunctionData({ abi: chunkStoreAbi, data }));
      const is = inner.map((c) => indexOf((c.args as [Hex])[0]));
      if (inner[0]!.functionName === "recordOf") {
        if (node.recordBlips.has(++node.records)) return reply({ error: BLIP });
        const recs = is.map((i) => encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: [node.chunks[i]!.backend, node.chunks[i]!.size, ZERO, ZERO] as never }));
        return reply({ result: encodeFunctionResult({ abi: MULTICALL, functionName: "multicall", result: recs }) });
      }
      if (node.readBlips.has(++node.reads)) return reply({ error: BLIP });
      const gas = is.reduce((g, i) => g + node.gasOf(node.chunks[i]!), 0);
      if (gas > node.gasCap) {
        node.gasRefusals++;
        const data = encodeErrorResult({ abi: chunkStoreAbi, errorName: "RetrieveFailed", args: [id(is[0]!), node.chunks[is[0]!]!.backend] } as never);
        return reply({ error: { code: 3, message: "execution reverted", data } });
      }
      const result = encodeFunctionResult({ abi: MULTICALL, functionName: "multicall", result: is.map((i) => readReturn(i, node.chunks[i]!.size)) });
      const len = (result.length - 2) / 2;
      if (len > node.limit) {
        node.limitRefusals++;
        return reply({ error: { code: -32000, message: `call returned result on length ${len} exceeding --rpc.returndata.limit ${node.limit}` } });
      }
      node.longest = Math.max(node.longest, len);
      reply({ result });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function read(n: number, maxCalls?: number) {
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;
  const parts = await readChunkSlices(client, ADDRS, id(1), ids(n), 1e12, maxCalls === undefined ? {} : { maxCalls });
  expect(parts).toHaveLength(n);
  for (let i = 0; i < n; i++) {
    expect(parts[i]).toHaveLength(node.chunks[i]!.size);
    expect(parts[i]![0]).toBe(i % 251);
  }
  return { reads: node.reads, calls: node.reads + node.records };
}

describe("a gas refusal inside a read within a result limit", () => {
  // The first planned call meets a `-32603`, so the limit is learned from its halves and they are read within it; the
  // chunks past the 16th cost the node 250 gas a byte, so four of them fit 100,000 bytes but not 2^24 gas, and the
  // first such call is refused for gas inside that read. The rest of the read is then planned at half the gas, and
  // half again, until two such chunks a call fit: each later call is not refused and split in turn.
  it.each([
    [64, 35, 4],
    [128, 66, 3],
    [300, 152, 3],
  ])("%i full chunks, past the 16th on a backend outside the book, on a 2^24-gas Erigon: %i reads, %i refused for gas", async (n, reads, gasRefusals) => {
    setup(n, FULL, (i) => (i < 16 ? RAW : OTHER), { limit: 100_000, gasCap: 16_777_216, readBlips: [1] });
    const got = await read(n, Infinity);
    expect(node.limitRefusals).toBe(1);
    expect(node.gasRefusals).toBe(gasRefusals);
    expect(got.reads).toBe(reads);
  });
});

describe("a records page that could not be read", () => {
  // The first page of records meets a `-32603`, so those chunks are planned unknown: for gas, like the costliest FastLZ
  // chunk; for length, like a full chunk. A limit refused for a call of them is taken, and the read planned within it.
  it.each([
    [1_000, 33, 0],
    [TYPICAL, 74, 1],
  ])("%i-byte raw chunks: %i reads, %i refused for length", async (size, reads, limitRefusals) => {
    setup(300, size, () => RAW, { limit: 100_000, recordBlips: [1] });
    const got = await read(300);
    expect(node.limitRefusals).toBe(limitRefusals);
    expect(got.reads).toBe(reads);
    expect(got.calls).toBeLessThanOrEqual(defaultMaxChunkReadCalls(300));
  });
});

describe("FastLZ, a limit learned from a part, on a node that simulates all of a call or 2^24", () => {
  // Within the limit, a call is planned by length alone (the planned call it is part of was sized for gas already), and
  // a limit says nothing about gas: the rest of the read keeps its gas budget.
  it("a limit learned from a part does not halve the gas budget: later FastLZ calls are still planned at full gas", async () => {
    // 64 raw chunks first, whose halves are refused for length (a node that returns 200,000 bytes), then 64 FastLZ ones,
    // 8 a call at 25M gas (197,696 bytes). Halving the gas for the limit would plan them 4 a call.
    setup(128, FULL, (i) => (i < 64 ? RAW : FASTLZ), { limit: 200_000, readBlips: [1] });
    const got = await read(128);
    expect(node.limitRefusals).toBe(1);
    expect(node.longest).toBe(197_696);
    // The first planned call, its first half (refused for length), 8 calls of 8 raw chunks within the limit, then 8 calls
    // of 8 FastLZ: were the gas halved, 16 calls of 4 FastLZ.
    expect(got.reads).toBe(18);
  });

  it.each([
    [FULL, Infinity, 27, 1, 0],
    [TYPICAL, Infinity, 22, 1, 0],
    [FULL, 16_777_216, 27, 0, 1],
    [TYPICAL, 16_777_216, 22, 0, 1],
  ])("%i-byte chunks, %s gas: %i reads, %i refused for length, %i for gas", async (size, gasCap, reads, limitRefusals, gasRefusals) => {
    setup(100, size, () => FASTLZ, { limit: 100_000, gasCap, readBlips: [1] });
    const got = await read(100);
    expect(node.limitRefusals).toBe(limitRefusals);
    expect(node.gasRefusals).toBe(gasRefusals);
    expect(got.reads).toBe(reads);
  });
});
