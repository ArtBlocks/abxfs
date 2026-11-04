/**
 * Delta audit M-1 (inverted), and the chunk reader's answer checks.
 *
 * `readChunkSlices` priced a chunk on any backend outside the address book at `Infinity`, so each such chunk was read
 * in an `eth_call` of its own: anyone can write chunks through their own backend, and a file of N of them cost N
 * sequential calls per read (16,384 for a gateway read). Such a chunk is now priced at FastLZ's worst stream, a call
 * that turns out too costly is halved like any other, and every read has a call budget (`maxCalls`).
 *
 * The reader also took a multicall's result count at face value: a reply with more results than ids appended a chunk
 * that was never asked for; one with fewer left a hole. Both are now a failed call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex, type PublicClient } from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { planChunk } from "../../src/plan.js";
import { packFile } from "../../src/nodes.js";
import { buildContentStages, runContentStages } from "../../src/content-write.js";
import {
  MAX_CHUNKS_PER_CALL,
  defaultMaxChunkReadCalls,
  planChunkReadSlices,
  readChunkSlices,
  readFile,
} from "../../src/read.js";
import { LimitExceededError } from "../../src/limits.js";
import { ZERO_HASH } from "../../src/cid.js";
import { CODEC_NONE } from "../../src/compression.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";
import { deployCoreArtifact, startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
} as ContractAddresses;
const OWN_BACKEND = "0x00000000000000000000000000000000000000e7";
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const enc = (b: Uint8Array) => encodeAbiParameters([{ type: "bytes" }], [`0x${Buffer.from(b).toString("hex")}` as Hex]);

/**
 * A ChunkStore whose chunks are all on `backend` (100 bytes each, byte = index), and whose `read` multicalls of more
 * than `maxPerCall` chunks fail. Counts every `eth_call`.
 */
function store(opts: { backend: string; maxPerCall: number }) {
  let calls = 0;
  const reads: number[] = [];
  const client = {
    async simulateContract({ args }: { args: [Hex[]] }) {
      calls++;
      const inner = args[0].map((data) => decodeFunctionData({ abi: chunkStoreAbi, data }));
      if (inner[0]!.functionName === "recordOf") {
        return {
          result: inner.map(() =>
            encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: [opts.backend as Hex, 100, ZERO_HASH as Hex, ZERO_HASH as Hex] as never }),
          ),
        };
      }
      reads.push(inner.length);
      if (inner.length > opts.maxPerCall) throw new Error("execution reverted");
      return { result: inner.map((x) => enc(new Uint8Array(100).fill(Number(BigInt(x.args![0] as Hex) & 0xffn)))) };
    },
    async readContract() {
      calls++;
      throw new Error("execution reverted");
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls, reads };
}

describe("a backend outside the address book", () => {
  it("is priced at FastLZ's worst stream, so its chunks share calls (64 a call for small chunks), never one call each", () => {
    const records = Array.from({ length: 1000 }, () => ({ backend: OWN_BACKEND as `0x${string}`, size: 3 }));
    const slices = planChunkReadSlices(records, ADDRS);
    expect(slices.length).toBe(Math.ceil(1000 / MAX_CHUNKS_PER_CALL));
    // A full chunk on it is planned like a full FastLZ chunk: a few to a call, not one.
    const full = planChunkReadSlices(Array.from({ length: 64 }, () => ({ backend: OWN_BACKEND as `0x${string}`, size: 24_575 })), ADDRS);
    const fastLz = planChunkReadSlices(Array.from({ length: 64 }, () => ({ backend: ADDRS.fastLzBackend!, size: 24_575 })), ADDRS);
    expect(full).toEqual(fastLz);
    expect(full[0]![1] - full[0]![0]).toBeGreaterThan(1);
  });

  it("a backend whose multi-chunk calls always fail is read singly until the call budget is spent, then refused", async () => {
    const s = store({ backend: OWN_BACKEND, maxPerCall: 1 });
    const n = 200;
    const budget = defaultMaxChunkReadCalls(n);
    expect(budget).toBe(Math.ceil(n / 4) + Math.ceil(n / 256) + 8);
    const err = await readChunkSlices(s.client, ADDRS, id(1), Array.from({ length: n }, (_, i) => id(i)), 1e9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect((err as LimitExceededError).limit).toBe("calls");
    expect((err as Error).message).toMatch(/eth_calls/);
    // It stopped at the budget: the old reader would have made 200 calls, a halving reader without a budget ~400.
    expect(s.calls()).toBe(budget);
  });

  it("a caller can pass its own budget (the gateway passes none: each read gets the default for its chunk count)", async () => {
    const s = store({ backend: OWN_BACKEND, maxPerCall: 1 });
    const ids = Array.from({ length: 20 }, (_, i) => id(i));
    await expect(readChunkSlices(s.client, ADDRS, id(1), ids, 1e9, { maxCalls: 5 })).rejects.toMatchObject({ limit: "calls" });
    expect(s.calls()).toBe(5);
    // And a generous one lets the same backend read, one chunk a call.
    const t = store({ backend: OWN_BACKEND, maxPerCall: 1 });
    const parts = await readChunkSlices(t.client, ADDRS, id(1), ids, 1e9, { maxCalls: 1000 });
    expect(parts.map((p) => p[0])).toEqual(ids.map((_, i) => i));
  });

  it("an honest backend outside the address book reads 1,000 chunks in a handful of calls", async () => {
    const s = store({ backend: OWN_BACKEND, maxPerCall: MAX_CHUNKS_PER_CALL });
    const ids = Array.from({ length: 1000 }, (_, i) => id(i));
    const parts = await readChunkSlices(s.client, ADDRS, id(1), ids, 1e9);
    expect(parts).toHaveLength(1000);
    // 4 pages of records and 16 slices of 64.
    expect(s.calls()).toBe(4 + 16);
  });
});

describe("a multicall answer without exactly one result per chunk is a failed call", () => {
  const counting = (results: (n: number, call: number) => Hex[]) => {
    let call = 0;
    const asked: number[] = [];
    const client = {
      async simulateContract({ args }: { args: [Hex[]] }) {
        const inner = args[0].map((data) => decodeFunctionData({ abi: chunkStoreAbi, data }));
        if (inner[0]!.functionName === "recordOf") throw new Error("execution reverted");
        asked.push(inner.length);
        return { result: results(inner.length, call++) };
      },
      async readContract() {
        throw new Error("no record");
      },
    } as unknown as PublicClient;
    return { client, asked };
  };

  it("an extra result is never taken as file data", async () => {
    const c = counting((n) => Array.from({ length: n + 1 }, (_, i) => enc(new Uint8Array([0x41 + i]))));
    const err = await readChunkSlices(c.client, ADDRS, id(1), [id(10), id(11)], 1_000_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/asked for 1 chunks .* got 2 results/);
  });

  it("a short answer leaves no hole: the call is halved and each half asked again", async () => {
    // The first (2-chunk) answer is short; the halves are answered properly.
    const c = counting((n, call) => (call === 0 ? [enc(new Uint8Array([0x41]))] : Array.from({ length: n }, () => enc(new Uint8Array([0x42])))));
    const parts = await readChunkSlices(c.client, ADDRS, id(1), [id(10), id(11)], 1_000_000);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p !== undefined)).toBe(true);
    expect(c.asked).toEqual([2, 1, 1]);
  });

  it("a short answer to a one-call read of up to 64 chunks falls back to the sized read", async () => {
    const c = counting((n, call) => (call === 0 ? [enc(new Uint8Array([0x41]))] : Array.from({ length: n }, () => enc(new Uint8Array([0x42])))));
    const ids = Array.from({ length: 20 }, (_, i) => id(i));
    const parts = await readChunkSlices(c.client, ADDRS, id(1), ids, 1_000_000);
    expect(parts).toHaveLength(20);
    expect(parts.every((p) => p?.[0] === 0x42)).toBe(true);
    expect(c.asked[0]).toBe(20);
  });
});

describe("on anvil: 1,000 tiny chunks through a second Sstore2Backend (one anyone could deploy)", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", "60000000"] });
  }, 300_000);
  afterAll(async () => h?.stop());

  async function makeFile(backend: `0x${string}`, n: number, salt: number): Promise<AbxfsCid> {
    const chunks = Array.from({ length: n }, (_, i) => planChunk(Uint8Array.of(salt, i & 0xff, i >> 8), { raw: backend }));
    const mimeType = "application/octet-stream";
    const { cid, tree } = packFile({ chunkIds: chunks.map((c) => c.id), chunkSizes: chunks.map((c) => c.size), mimeType });
    await runContentStages(
      { publicClient: h.publicClient as never, walletClient: h.walletClient as never },
      h.addresses,
      buildContentStages(h.addresses, {
        chunksToWrite: chunks,
        chunkNodesToCreate: tree.nodes,
        filesToCreate: [{ cid, chunkIds: chunks.map((c) => c.id), mimeType, codec: CODEC_NONE, outputHash: ZERO_HASH as never, root: tree.root as never }],
        entryNodesToCreate: [],
        dirsToCreate: [],
      }),
      12_000_000,
      [],
    );
    return cid;
  }

  function counting(): { client: PublicClient; calls: () => number } {
    let n = 0;
    const client = new Proxy(h.publicClient, {
      get(t, p, r) {
        if (p === "simulateContract" || p === "readContract" || p === "call") {
          const f = Reflect.get(t, p, r) as (...a: unknown[]) => unknown;
          return (...a: unknown[]) => (n++, f.apply(t, a));
        }
        return Reflect.get(t, p, r);
      },
    }) as PublicClient;
    return { client, calls: () => n };
  }

  it("reads as cheaply as the address book's own backend: about 30 calls, never one per chunk", async () => {
    const custom = await deployCoreArtifact(h, "Sstore2Backend.sol", "Sstore2Backend");
    const N = 1000;
    const std = await makeFile(h.addresses.sstore2Backend!, N, 1);
    const own = await makeFile(custom, N, 2);
    const counts: number[] = [];
    for (const cid of [std, own]) {
      const c = counting();
      const f = await readFile(c.client, h.addresses, cid);
      expect(f.bytes.length).toBe(3 * N);
      counts.push(c.calls());
    }
    // getFileInfo, 10 id pages, 4 record pages and 16 slices of 64: the same for both backends. The default budget
    // (262 for 1,000 chunks) is well clear of it; before the fix the own backend cost 1,015 calls.
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(140);
    expect(counts[1]).toBeLessThanOrEqual(1 + 10 + 4 + 16);
  }, 900_000);
});
