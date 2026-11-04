/**
 * Delta audit round 3, L1: one transient RPC error permanently halved a read's gas budget.
 *
 * `readChunkSlices` re-plans the rest of a read at half the gas once a planned call is refused and its halves are read
 * (round 2, M1). It took ANY failure for that refusal, so a load-balanced RPC's HTTP 200 `-32603 internal error` on one
 * call had the effect of a gas refusal: two such blips made an honest 1,000-chunk FastLZ read on a 50M node spend its
 * call budget (8 chunks a call became 2), and the gateway remembers that refusal for a minute.
 *
 * Now only the gas shape halves the budget ({@link isChunkReadGasRefusal}): a revert whose data is ChunkStore's
 * `RetrieveFailed` (how a backend that runs out of gas surfaces, measured below on anvil with a 2^24 cap), a revert
 * with no data, or the node's own "out of gas" words. A JSON-RPC error that is not a revert, and a malformed answer,
 * are read around by halves and leave the budget alone.
 *
 * The errors here are viem's own: a local JSON-RPC server answers the reader's `eth_call`s exactly as a node does.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BaseError,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionResult,
  http,
  toFunctionSelector,
  type Hex,
  type PublicClient,
} from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { ZERO_HASH } from "../../src/cid.js";
import { planFile } from "../../src/plan.js";
import { buildContentStages, runContentStages } from "../../src/content-write.js";
import { isChunkReadGasRefusal, isTransportFailure, multicallReadHomogeneous, RETRIEVE_FAILED_SELECTOR } from "../../src/multicall.js";
import { defaultMaxChunkReadCalls, readChunkSlices } from "../../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
} as ContractAddresses;
const FULL = 24_575;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
const enc = (b: Uint8Array) => encodeAbiParameters([{ type: "bytes" }], [`0x${Buffer.from(b).toString("hex")}` as Hex]);
const MULTICALL = [
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;

type RpcError = { code: number; message: string; data?: string };
const retrieveFailed = (chunk: Hex): Hex =>
  encodeErrorResult({ abi: chunkStoreAbi, errorName: "RetrieveFailed", args: [chunk, ADDRS.fastLzBackend!] } as never);
const reasonData = (reason: string): Hex => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}` as Hex;

/** How the server answers a `read` multicall: `n` is its 1-based number among read calls, `chunks` the ids it asks for. */
let readPolicy: (n: number, chunks: Hex[]) => RpcError | undefined = () => undefined;
let ethCalls = 0;
let reads: number[] = [];
let server: Server;
let url = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: Array<{ data: Hex }> } | Array<{ id: number; method: string; params: Array<{ data: Hex }> }>;
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const out = msgs.map((m) => {
        if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x1" };
        ethCalls++;
        const inner = (decodeFunctionData({ abi: MULTICALL, data: m.params[0]!.data }).args[0] as Hex[]).map((data) =>
          decodeFunctionData({ abi: chunkStoreAbi, data }),
        );
        if (inner[0]!.functionName === "recordOf") {
          const rec = encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: [ADDRS.fastLzBackend, FULL, ZERO_HASH, ZERO_HASH] as never });
          return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: MULTICALL, functionName: "multicall", result: inner.map(() => rec) }) };
        }
        reads.push(inner.length);
        const chunks = inner.map((x) => x.args![0] as Hex);
        const error = readPolicy(reads.length, chunks);
        if (error) return { jsonrpc: "2.0", id: m.id, error };
        const results = chunks.map((c) => enc(Uint8Array.of(Number(BigInt(c) & 0xffn))));
        return { jsonrpc: "2.0", id: m.id, result: encodeFunctionResult({ abi: MULTICALL, functionName: "multicall", result: results }) };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** viem with no retries, so every answer reaches the reader as the node gave it. */
const client = () => createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;

/**
 * A node that refuses any read of more than `maxPerCall` chunks as a 2^24 node does (a code-3 revert with
 * `RetrieveFailed` for the chunk whose backend ran out), and answers the read calls numbered in `blips` with `blip`.
 */
function node(maxPerCall: number, blips: number[] = [], blip: RpcError = { code: -32603, message: "internal error" }) {
  ethCalls = 0;
  reads = [];
  readPolicy = (n, chunks) => {
    if (blips.includes(n)) return blip;
    if (chunks.length > maxPerCall) return { code: 3, message: "execution reverted", data: retrieveFailed(chunks[maxPerCall]!) };
    return undefined;
  };
}

/** The error viem throws for one read multicall the node answers with `error`. */
async function wireError(error: RpcError): Promise<unknown> {
  readPolicy = () => error;
  return multicallReadHomogeneous(client(), chunkStoreAbi as never, ADDRS.chunkStore!, "read", [[id(1)]]).then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("a transient JSON-RPC error never halves the read's gas budget", () => {
  it("1,000 full FastLZ chunks on a 50M node (8 a call), reads #5 and #10 answered -32603 internal error: read in 133 calls", async () => {
    node(8, [5, 10]);
    const parts = await readChunkSlices(client(), ADDRS, id(1), ids(1000), 1e12);
    expect(parts.map((p) => p[0])).toEqual(ids(1000).map((_, i) => i & 0xff));
    // 4 pages of records, 125 calls of 8, and each blip read as 4 + 4: 4 + 125 + 2 * 2.
    expect(ethCalls).toBe(133);
    expect(ethCalls).toBeLessThanOrEqual(133);
    // Every planned call after the blips is still 8 chunks: the budget was never halved.
    expect(reads.slice(12).every((r) => r === 8)).toBe(true);
    // Before, the first blip halved it to 4 a call and the second to 2: 4 + 3 + 3 + ~495 calls, past the budget (262).
  });

  it("the same with -32000 header not found, -32603 header not found, and a -32603 that quotes no words at all", async () => {
    for (const blip of [
      { code: -32000, message: "header not found" },
      { code: -32603, message: "header not found" },
      { code: -32603, message: "" },
    ]) {
      node(8, [5, 10], blip);
      await readChunkSlices(client(), ADDRS, id(1), ids(1000), 1e12);
      expect(ethCalls).toBe(133);
    }
  });

  it("blips on a 50M node (2, 4, spread out) stay within the default budget", async () => {
    // Each blip lands on a planned call (a blip's halves are the two read calls after it).
    for (const blips of [[5, 120], [5, 10, 15, 20], [1, 4, 7, 10, 13, 16, 19, 22]]) {
      node(8, blips);
      await readChunkSlices(client(), ADDRS, id(1), ids(1000), 1e12);
      expect(ethCalls).toBe(4 + 125 + 2 * blips.length);
      expect(ethCalls).toBeLessThanOrEqual(defaultMaxChunkReadCalls(1000));
    }
  });

  it("a malformed answer (one result too few) is read around and does not halve the budget either", async () => {
    node(8);
    let n = 0;
    // Read #5 is answered one result short.
    const c = client();
    const short = new Proxy(c, {
      get(t, p, r) {
        if (p !== "simulateContract") return Reflect.get(t, p, r);
        return async (args: { args: [Hex[]] }) => {
          const out = (await (Reflect.get(t, p, r) as (a: unknown) => Promise<{ result: Hex[] }>).call(t, args)) as { result: Hex[] };
          const isRead = decodeFunctionData({ abi: chunkStoreAbi, data: args.args[0][0]! }).functionName === "read";
          return isRead && ++n === 5 ? { ...out, result: out.result.slice(1) } : out;
        };
      },
    }) as PublicClient;
    await readChunkSlices(short, ADDRS, id(1), ids(1000), 1e12);
    expect(ethCalls).toBe(4 + 125 + 2);
  });
});

describe("a gas refusal still halves it (round 2, M1)", () => {
  it("a 2^24 node (4 a call) that answers RetrieveFailed: one refused 8, then 4 a call, within the budget, even with a blip", async () => {
    node(4);
    await readChunkSlices(client(), ADDRS, id(1), ids(1000), 1e12);
    // 4 pages of records; the first 8 refused and read as 4 + 4; then 248 calls of 4.
    expect(reads.slice(0, 3)).toEqual([8, 4, 4]);
    expect(reads.slice(3).every((r) => r === 4)).toBe(true);
    expect(ethCalls).toBe(4 + 3 + 248);
    node(4, [10]);
    await readChunkSlices(client(), ADDRS, id(1), ids(1000), 1e12);
    expect(ethCalls).toBe(4 + 3 + 248 + 2);
    expect(ethCalls).toBeLessThanOrEqual(defaultMaxChunkReadCalls(1000));
  });

  for (const [label, refusal] of [
    ["an empty revert (code 3, no data)", { code: 3, message: "execution reverted" }],
    ["an empty revert (code 3, data 0x)", { code: 3, message: "execution reverted", data: "0x" }],
    ["geth's -32000 execution reverted, no data", { code: -32000, message: "execution reverted" }],
    ["the node's own -32000 out of gas", { code: -32000, message: "out of gas" }],
    ["gas required exceeds allowance", { code: -32000, message: "gas required exceeds allowance (16777216)" }],
  ] as Array<[string, RpcError]>) {
    it(`${label} halves it too`, async () => {
      ethCalls = 0;
      reads = [];
      readPolicy = (_, chunks) => (chunks.length > 4 ? refusal : undefined);
      await readChunkSlices(client(), ADDRS, id(1), ids(200), 1e12);
      expect(reads.slice(0, 3)).toEqual([8, 4, 4]);
      expect(reads.slice(3).every((r) => r === 4)).toBe(true);
    });
  }
});

describe("isChunkReadGasRefusal, on errors as viem builds them from the wire", () => {
  it("RETRIEVE_FAILED_SELECTOR is ChunkStore's RetrieveFailed(bytes32,address)", () => {
    const err = (chunkStoreAbi as readonly { type: string; name?: string; inputs?: readonly { type: string }[] }[]).find(
      (x) => x.type === "error" && x.name === "RetrieveFailed",
    )!;
    expect(toFunctionSelector(`RetrieveFailed(${err.inputs!.map((i) => i.type).join(",")})`)).toBe(RETRIEVE_FAILED_SELECTOR);
    expect(RETRIEVE_FAILED_SELECTOR).toBe("0x93daf644");
  });

  it("the gas shapes", async () => {
    for (const error of [
      { code: 3, message: "execution reverted: custom error 0x93daf644", data: retrieveFailed(id(7)) },
      { code: 3, message: "execution reverted" },
      { code: 3, message: "execution reverted", data: "0x" },
      { code: -32000, message: "execution reverted" },
      { code: -32000, message: "out of gas" },
      { code: -32003, message: "Out of gas: gas required exceeds allowance: 16777216" },
      { code: -32015, message: "VM execution error.", data: "OutOfGas" },
    ]) {
      const err = await wireError(error);
      expect(err, JSON.stringify(error)).toBeInstanceOf(BaseError);
      expect(isChunkReadGasRefusal(err), JSON.stringify(error)).toBe(true);
    }
  });

  it("never a JSON-RPC error that is not a revert, other revert data, or the connection", async () => {
    for (const error of [
      { code: -32603, message: "internal error" },
      { code: -32603, message: "header not found" },
      { code: -32000, message: "header not found" },
      { code: -32603, message: "" },
      { code: -32603, message: "internal error", data: "upstream unavailable" },
      { code: -32601, message: "the method eth_call does not exist" },
      { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: chunkStoreAbi, errorName: "DataMismatch", args: [id(7)] } as never) },
      { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: chunkStoreAbi, errorName: "ChunkNotFound", args: [id(7)] } as never) },
      // A revert REASON that says "out of gas" is the contract's words, not the node's.
      { code: 3, message: "execution reverted: out of gas", data: reasonData("out of gas") },
      // Transport: a rate limit or a timeout in a JSON-RPC error's words.
      { code: -32603, message: "request timed out" },
      { code: -32005, message: "limit exceeded" },
    ]) {
      const err = await wireError(error);
      expect(isChunkReadGasRefusal(err), JSON.stringify(error)).toBe(false);
    }
  });

  it("an error that is not viem's: by code 3 or revert data on it or its cause, then by its words", () => {
    expect(isChunkReadGasRefusal(new Error("execution reverted"))).toBe(true);
    expect(isChunkReadGasRefusal(Object.assign(new Error("call failed"), { code: 3 }))).toBe(true);
    expect(isChunkReadGasRefusal(Object.assign(new Error("call failed"), { cause: { code: 3, data: retrieveFailed(id(1)) } }))).toBe(true);
    expect(isChunkReadGasRefusal(Object.assign(new Error("call failed"), { data: retrieveFailed(id(1)) }))).toBe(true);
    expect(isChunkReadGasRefusal(new Error("out of gas"))).toBe(true);
    expect(isChunkReadGasRefusal(new Error("wrapped", { cause: new Error("gas required exceeds allowance (0)") }))).toBe(true);

    expect(isChunkReadGasRefusal(new Error("RPC error -32603: internal error"))).toBe(false);
    expect(isChunkReadGasRefusal(Object.assign(new Error("execution reverted"), { data: reasonData("out of gas") }))).toBe(false);
    expect(isChunkReadGasRefusal(Object.assign(new Error("out of gas"), { cause: { data: reasonData("nope") } }))).toBe(false);
    expect(isChunkReadGasRefusal(Object.assign(new Error("out of gas"), { status: 429 }))).toBe(false);
    expect(isChunkReadGasRefusal(new Error("fetch failed"))).toBe(false);
    for (const odd of [null, undefined, "execution reverted", 3, {}, { cause: null }]) expect(isChunkReadGasRefusal(odd)).toBe(false);
  });
});

/** A FASTA-like DNA file: what FastLZ stores in ~60% and costs ~100 gas a byte to read (see read-budget.test.ts). */
function dna(bytes: number): Uint8Array {
  let seed = 7;
  const rnd = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 2 ** 32;
  };
  return Uint8Array.from({ length: bytes }, (_, i) => ((i + 1) % 61 === 0 ? 0x0a : "ACGT".charCodeAt(Math.floor(rnd() * 4))));
}

describe("on anvil with a 2^24 eth_call cap (--gas-limit 16777216): the rule stays tied to the contract", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", "16777216"] });
  }, 300_000);
  afterAll(async () => h?.stop());

  it("a refused 8-chunk FastLZ read is a code-3 revert whose data is RetrieveFailed, and reads as a gas refusal", async () => {
    const data = dna(300_000);
    const f = await planFile({ backends: { raw: h.addresses.sstore2Backend!, fastLz: h.addresses.fastLzBackend! }, bytes: data, mimeType: "text/plain" });
    expect(f.chunks.length).toBeGreaterThanOrEqual(8);
    expect(f.chunks.every((c) => c.backend.toLowerCase() === h.addresses.fastLzBackend!.toLowerCase())).toBe(true);
    await runContentStages(
      { publicClient: h.publicClient as never, walletClient: h.walletClient as never },
      h.addresses,
      buildContentStages(h.addresses, {
        chunksToWrite: f.chunks,
        chunkNodesToCreate: f.tree.nodes,
        filesToCreate: [{ cid: f.cid, chunkIds: f.chunkIds, mimeType: f.mimeType, codec: f.codec, outputHash: f.outputHash, root: f.tree.root as never }],
        entryNodesToCreate: [],
        dirsToCreate: [],
      }),
      12_000_000,
      [],
    );

    // The refusal itself, as the reader gets it.
    const err = await multicallReadHomogeneous(h.publicClient as never, chunkStoreAbi as never, h.addresses.chunkStore!, "read", f.chunkIds.slice(0, 8).map((c) => [c])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaseError);
    const rpc = (err as BaseError).walk((x) => (x as { code?: unknown }).code === 3) as { code: number; data?: unknown } | null;
    expect(rpc).not.toBeNull();
    expect(typeof rpc!.data).toBe("string");
    expect((rpc!.data as string).slice(0, 10)).toBe(RETRIEVE_FAILED_SELECTOR);
    expect(isTransportFailure(err)).toBe(false);
    expect(isChunkReadGasRefusal(err)).toBe(true);

    // And the reader halves its budget on it: the first planned call refused and read by halves, then every later
    // call at most half of it. Each read call's size, and whether the node refused it, in order.
    const log: Array<{ size: number; refused: boolean }> = [];
    const counting = new Proxy(h.publicClient, {
      get(t, p, r) {
        if (p !== "simulateContract") return Reflect.get(t, p, r);
        const fn = Reflect.get(t, p, r) as unknown as (a: { args: [Hex[]] }) => Promise<unknown>;
        return async (a: { args: [Hex[]] }) => {
          if (decodeFunctionData({ abi: chunkStoreAbi, data: a.args[0][0]! }).functionName !== "read") return fn.call(t, a);
          const entry = { size: a.args[0].length, refused: false };
          log.push(entry);
          return fn.call(t, a).catch((e: unknown) => {
            entry.refused = true;
            throw e;
          });
        };
      },
    }) as PublicClient;
    const n = f.chunkIds.length;
    const parts = await readChunkSlices(counting, h.addresses, f.cid, f.chunkIds, 1e9);
    expect(Buffer.concat(parts)).toEqual(Buffer.from(data));
    // A file of up to 64 chunks is tried as one call first (refused), then read in slices sized from its records.
    const sized = log.slice(n <= 64 ? 1 : 0);
    const first = sized[0]!;
    expect(first.refused).toBe(true);
    expect(sized.slice(1, 3).map((x) => x.size)).toEqual([Math.ceil(first.size / 2), Math.floor(first.size / 2)]);
    expect(sized.slice(3).every((x) => !x.refused && x.size <= Math.ceil(first.size / 2))).toBe(true);
  }, 900_000);
});
