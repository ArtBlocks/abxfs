/**
 * Delta audit round 2, M1: the default chunk-read call budget made legitimate files unreadable on nodes that cap
 * `eth_call` near 2^24 (Ethereum Sepolia's publicnode measured 16,762,214).
 *
 * A full FastLZ chunk of CSV, hex, DNA or SVG paths costs 92-105 gas a data byte to read, so the 8-chunk calls the
 * reader planned (sized for 25M) needed 18-21M: a 2^24 node refused every one, each was halved (3 calls for 8
 * chunks), and the budget of one call per 8 chunks ran out. A 1.5 MB DNA file (65 chunks) needed 27 calls against a
 * budget of 18. Now a planned call that is refused and read by halves re-plans the rest at half the gas, and the
 * default budget is sized for that: `ceil(n / 4) + ceil(n / 256) + 8`. A chunk whose record could not be read is
 * priced at FastLZ's worst stream, not as a full raw chunk.
 *
 * The round-1 guarantee stands: a backend whose multi-chunk calls always fail is refused at the budget, far below one
 * call per chunk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex, type PublicClient } from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { planFile } from "../../src/plan.js";
import { buildContentStages, runContentStages } from "../../src/content-write.js";
import { defaultMaxChunkReadCalls, planChunkReadSlices, readChunkSlices, readFile } from "../../src/read.js";
import { LimitExceededError } from "../../src/limits.js";
import { ZERO_HASH } from "../../src/cid.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
} as ContractAddresses;
const OWN_BACKEND = "0x00000000000000000000000000000000000000e7";
const FULL = 24_575;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i));
const enc = (b: Uint8Array) => encodeAbiParameters([{ type: "bytes" }], [`0x${Buffer.from(b).toString("hex")}` as Hex]);

/**
 * A ChunkStore whose chunks are full FastLZ chunks (by record), and whose `read` multicalls of more than `maxPerCall`
 * chunks fail, as a node does when a call needs more gas than it simulates. Each chunk reads as one byte (its index).
 * `records` answers the record pages: `ok`, `revert` (a missing chunk reverts the whole multicall) or `short` (one
 * result too few). Counts every call.
 */
function store(opts: { maxPerCall: number; backend?: string; size?: number; records?: "ok" | "revert" | "short" }) {
  let calls = 0;
  const reads: number[] = [];
  const client = {
    async simulateContract({ args }: { args: [Hex[]] }) {
      calls++;
      const inner = args[0].map((data) => decodeFunctionData({ abi: chunkStoreAbi, data }));
      if (inner[0]!.functionName === "recordOf") {
        if (opts.records === "revert") throw new Error("execution reverted");
        const rec = encodeFunctionResult({
          abi: chunkStoreAbi,
          functionName: "recordOf",
          result: [(opts.backend ?? ADDRS.fastLzBackend) as Hex, opts.size ?? FULL, ZERO_HASH as Hex, ZERO_HASH as Hex] as never,
        });
        return { result: inner.slice(opts.records === "short" ? 1 : 0).map(() => rec) };
      }
      reads.push(inner.length);
      if (inner.length > opts.maxPerCall) throw new Error("execution reverted");
      return { result: inner.map((x) => enc(Uint8Array.of(Number(BigInt(x.args![0] as Hex) & 0xffn)))) };
    },
    async readContract() {
      calls++;
      throw new Error("execution reverted");
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls, reads };
}

describe("the default budget tolerates a node that refuses the planned calls", () => {
  it("is ceil(n / 4) + ceil(n / 256) + 8", () => {
    for (const n of [1, 8, 65, 200, 1000, 200_000]) {
      expect(defaultMaxChunkReadCalls(n)).toBe(Math.ceil(n / 4) + Math.ceil(n / 256) + 8);
    }
    expect(defaultMaxChunkReadCalls(65)).toBe(26); // the 1.5 MB DNA file: it needed 27 calls against 18 before
    expect(defaultMaxChunkReadCalls(1000)).toBe(262);
  });

  it("a refused 8-chunk call read by halves re-plans the rest at 4 a call: 65 full FastLZ chunks in 19 calls", async () => {
    const s = store({ maxPerCall: 4 });
    const parts = await readChunkSlices(s.client, ADDRS, id(1), ids(65), 1e9);
    expect(parts.map((p) => p[0])).toEqual(ids(65).map((_, i) => i));
    // One page of records; the first planned call (8) refused and read as 4 + 4; then 57 chunks, 4 a call.
    expect(s.reads).toEqual([8, 4, 4, ...Array.from({ length: 14 }, () => 4), 1]);
    expect(s.calls()).toBe(1 + 3 + 15);
    expect(s.calls()).toBeLessThanOrEqual(defaultMaxChunkReadCalls(65));
    // Without the re-plan every 8-chunk call is refused and halved: 1 + 9 * 3 = 28 calls.
  });

  it("a node that refuses again re-plans again (2 a call), within a caller's own budget", async () => {
    const s = store({ maxPerCall: 2 });
    const parts = await readChunkSlices(s.client, ADDRS, id(1), ids(40), 1e9, { maxCalls: Infinity });
    expect(parts).toHaveLength(40);
    // The one-call try (40) refused; then 8 refused, 4 refused, 2 + 2, 4 refused, 2 + 2; then 4 refused, 2 + 2 (the
    // budget halved once); then 2 a call (halved twice).
    expect(s.reads.slice(0, 10)).toEqual([40, 8, 4, 2, 2, 4, 2, 2, 4, 2]);
    expect(s.reads.slice(10)).toEqual(Array.from({ length: 15 }, () => 2));
    // The default budget is sized for one halving: a node this tight needs the caller's own `maxCalls`.
    const t = store({ maxPerCall: 2 });
    await expect(readChunkSlices(t.client, ADDRS, id(1), ids(400), 1e9)).rejects.toMatchObject({ limit: "calls" });
  });

  it("a chunk whose record could not be read is priced as the costliest chunk (8 a call), not as a raw one (64)", () => {
    expect(planChunkReadSlices(Array.from({ length: 64 }, () => undefined), ADDRS)).toEqual(
      Array.from({ length: 8 }, (_, i) => [i * 8, i * 8 + 8]),
    );
    const fastLz = Array.from({ length: 64 }, () => ({ backend: ADDRS.fastLzBackend!, size: FULL }));
    expect(planChunkReadSlices(Array.from({ length: 64 }, () => undefined), ADDRS)).toEqual(planChunkReadSlices(fastLz, ADDRS));
  });

  it("records that cannot be read (a reverting page, or one result short) leave every chunk priced at the worst", async () => {
    for (const records of ["revert", "short"] as const) {
      // Small raw chunks by record would be read 64 a call; unknown ones are read 8 a call.
      const s = store({ maxPerCall: 64, backend: ADDRS.sstore2Backend!, size: 100, records });
      const parts = await readChunkSlices(s.client, ADDRS, id(1), ids(100), 1e9);
      expect(parts).toHaveLength(100);
      expect(s.reads.every((r) => r <= 8)).toBe(true);
      const known = store({ maxPerCall: 64, backend: ADDRS.sstore2Backend!, size: 100 });
      await readChunkSlices(known.client, ADDRS, id(1), ids(100), 1e9);
      expect(known.reads).toEqual([64, 36]);
    }
  });
});

describe("the round-1 guarantee: a backend whose multi-chunk calls always fail", () => {
  it("1,000 chunks: refused at the budget (262 calls), far below one call per chunk", async () => {
    const s = store({ maxPerCall: 1, backend: OWN_BACKEND, size: 100 });
    const err = await readChunkSlices(s.client, ADDRS, id(1), ids(1000), 1e9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect((err as LimitExceededError).limit).toBe("calls");
    expect(s.calls()).toBe(262);
    expect(s.calls()).toBeLessThan(1000 / 3);
  });
});

describe("maxCalls is a positive integer or Infinity", () => {
  it("NaN, 0, a negative and a fraction are a RangeError before any call", async () => {
    for (const maxCalls of [Number.NaN, 0, -1, 1.5, -Infinity]) {
      const s = store({ maxPerCall: 64 });
      await expect(readChunkSlices(s.client, ADDRS, id(1), ids(4), 1e9, { maxCalls })).rejects.toThrow(RangeError);
      await expect(readChunkSlices(s.client, ADDRS, id(1), ids(4), 1e9, { maxCalls })).rejects.toThrow(
        /maxCalls must be a positive integer or Infinity/,
      );
      await expect(readFile(s.client, ADDRS, id(1), { maxCalls })).rejects.toThrow(RangeError);
      expect(s.calls()).toBe(0);
    }
  });

  it("Infinity and a positive integer are accepted", async () => {
    const s = store({ maxPerCall: 64 });
    expect(await readChunkSlices(s.client, ADDRS, id(1), ids(4), 1e9, { maxCalls: Infinity })).toHaveLength(4);
    expect(await readChunkSlices(s.client, ADDRS, id(1), ids(4), 1e9, { maxCalls: 1 })).toHaveLength(4);
  });
});

describe("readFile passes maxCalls on to the chunk reader", () => {
  /** A file of `n` full FastLZ chunks behind getFileInfo and getChunkIds, over {@link store}. */
  function fileClient(n: number, maxPerCall: number) {
    const s = store({ maxPerCall });
    const client = {
      ...s.client,
      simulateContract: s.client.simulateContract,
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        if (functionName === "getFileInfo") {
          return { root: id(9), rootLevel: 1, chunkCount: BigInt(n), size: BigInt(n), mimeType: "text/plain", codec: ZERO_HASH, outputHash: ZERO_HASH };
        }
        if (functionName === "getChunkIds") return ids(n).slice(Number(args[1]), Number(args[2]));
        throw new Error(`unexpected ${functionName}`);
      },
    } as unknown as PublicClient;
    return { client, reads: s.reads };
  }

  it("a budget smaller than the read needs stops it there", async () => {
    const f = fileClient(20, 1);
    const err = await readFile(f.client, ADDRS, id(1), { maxCalls: 3 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect((err as LimitExceededError).limit).toBe("calls");
    expect((err as LimitExceededError).message).toMatch(/limit of 3 eth_calls/);
    expect(f.reads).toEqual([20, 8]); // the one-call try, the first sized slice; the third call was the record page
  });

  it("and the default lets the same file read on a node that takes 4 full FastLZ chunks a call", async () => {
    const f = fileClient(20, 4);
    const out = await readFile(f.client, ADDRS, id(1));
    expect(out.bytes).toEqual(Uint8Array.from({ length: 20 }, (_, i) => i));
  });
});

/** A FASTA-like DNA file (ACGT, a newline every 60): what FastLZ stores in ~60% and costs ~100 gas a byte to read. */
function dna(bytes: number): Uint8Array {
  let seed = 0x5eed;
  const rnd = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 2 ** 32;
  };
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i + 1) % 61 === 0 ? 0x0a : "ACGT".charCodeAt(Math.floor(rnd() * 4));
  return out;
}

describe("on anvil with a 2^24 eth_call cap (--gas-limit 16777216)", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", "16777216"] });
  }, 300_000);
  afterAll(async () => h?.stop());

  it("a 1.5 MB DNA file the SDK uploaded (all FastLZ) reads back with readFile's defaults", async () => {
    const data = dna(1_500_000);
    const f = await planFile({ backends: { raw: h.addresses.sstore2Backend!, fastLz: h.addresses.fastLzBackend! }, bytes: data, mimeType: "text/plain" });
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
    let calls = 0;
    const counting = new Proxy(h.publicClient, {
      get(t, p, r) {
        if (p === "simulateContract") {
          const fn = Reflect.get(t, p, r) as (...a: unknown[]) => unknown;
          return (...a: unknown[]) => (calls++, fn.apply(t, a));
        }
        return Reflect.get(t, p, r);
      },
    }) as PublicClient;
    const n = f.chunks.length;
    const out = await readFile(counting, h.addresses, f.cid);
    expect(out.bytes).toEqual(data);
    // The one-call try (a file of up to 64 chunks), one record page, the first 8-chunk call refused and read as
    // 4 + 4, then 4 a call: inside the budget. Before, every 8-chunk call was refused and halved (27 calls, budget 18).
    expect(calls).toBeLessThanOrEqual((n <= 64 ? 1 : 0) + 1 + 3 + Math.ceil((n - 8) / 4));
    expect(calls).toBeLessThanOrEqual(defaultMaxChunkReadCalls(n));
  }, 900_000);
});
