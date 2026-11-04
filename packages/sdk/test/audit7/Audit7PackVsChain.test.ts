/**
 * Audit 7, item 1: differential test. Every tree the SDK packs is put on a REAL anvil deployment of the ABX FS stores,
 * and the CIDs/roots the contracts return must equal the ones computed locally. Edge cases: unsigned-byte ordering
 * of astral / BMP-high / NUL names, NFC vs NFD, 255-byte names, exact-full leaves, content-defined chunk leaves with
 * varying chunk sizes (each size verified by the store), branches over many one-entry leaves, and `locateByte` against
 * the locally computed offsets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, type Hex } from "viem";

import { chunkStoreAbi, directoryStoreAbi, fileStoreAbi } from "../../src/abi.js";
import { ZERO_HASH, chunkId } from "../../src/cid.js";
import { nameKey } from "../../src/node-gas.js";
import { packChunkTree, packEntryTree, fileCid, directoryCid, nodeBlobHex, type PackedNode } from "../../src/nodes.js";
import type { AbxfsCid, DirectoryEntry } from "../../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => {
  h = await startAnvilWithAbxfs();
}, 180_000);
afterAll(async () => h?.stop());

const GAS = { gas: 28_000_000n };

async function multicall(address: Hex, abi: readonly unknown[], calls: Hex[]) {
  const tx = await h.walletClient.writeContract({
    address,
    abi: [...(abi as never[]), { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "r", type: "bytes[]" }] }] as never,
    functionName: "multicall",
    args: [calls],
    chain: undefined,
    account: h.account,
    ...GAS,
  } as never);
  const r = await h.publicClient.waitForTransactionReceipt({ hash: tx });
  if (r.status !== "success") throw new Error("multicall reverted");
}

const chunkCache = new Map<number, AbxfsCid>();
/** Chunk `i` is 5 + (i % 4) bytes, so sizes vary and the store's size check is exercised on every leaf. */
const chunkData = (i: number) => new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255, 7, 7, 7, 7].slice(0, 5 + (i % 4)));
const chunkSizes = (n: number) => Array.from({ length: n }, (_, i) => 5 + (i % 4));
async function ensureChunks(n: number): Promise<AbxfsCid[]> {
  const out: AbxfsCid[] = [];
  const toWrite: Hex[] = [];
  for (let i = 0; i < n; i++) {
    const data = chunkData(i);
    const dh = keccak256(data);
    const hh = chunkId(h.addresses.sstore2Backend!, dh, dh, data.length);
    out.push(hh);
    if (!chunkCache.has(i)) {
      chunkCache.set(i, hh);
      toWrite.push(
        encodeFunctionData({
          abi: chunkStoreAbi,
          functionName: "write",
          args: [h.addresses.sstore2Backend!, ("0x" + Buffer.from(data).toString("hex")) as Hex, dh, data.length],
        }),
      );
    }
  }
  for (let o = 0; o < toWrite.length; o += 150) await multicall(h.addresses.chunkStore!, chunkStoreAbi, toWrite.slice(o, o + 150));
  return out;
}

async function putNodes(kind: "chunks" | "entries", nodes: PackedNode[], perTx: number) {
  const store = (kind === "chunks" ? h.addresses.fileStore : h.addresses.directoryStore) as Hex;
  const abi = kind === "chunks" ? fileStoreAbi : directoryStoreAbi;
  const fn = kind === "chunks" ? "putChunkNode" : "putEntryNode";
  // children first: one tx per level
  const levels = [...new Set(nodes.map((n) => n.level))].sort();
  for (const lv of levels) {
    const lvl = nodes.filter((n) => n.level === lv);
    const per = lv === 0 ? perTx : 4; // a 128-child branch is 3-5M gas: never batch past the block limit
    for (let o = 0; o < lvl.length; o += per) {
      await multicall(store, abi, lvl.slice(o, o + per).map((n) => encodeFunctionData({ abi: abi as never, functionName: fn, args: [nodeBlobHex(n)] } as never) as Hex));
    }
  }
  for (const n of nodes) {
    const ex = await h.publicClient.readContract({ address: store, abi: abi as never, functionName: "nodeExists", args: [n.id] } as never);
    if (!ex) throw new Error(`node ${n.id} (level ${n.level}) not on chain`);
  }
}

async function sendFile(chunkHashes: AbxfsCid[], mime = "text/plain") {
  const tree = packChunkTree(chunkHashes, chunkSizes(chunkHashes.length));
  await putNodes("chunks", tree.nodes, 6);
  const cid = fileCid(tree.root, mime);
  const sim = await h.publicClient.simulateContract({ address: h.addresses.fileStore as Hex, abi: fileStoreAbi, functionName: "createFile", args: [tree.root, mime, ZERO_HASH, ZERO_HASH], account: h.account } as never);
  expect((sim.result as string).toLowerCase()).toBe(cid.toLowerCase());
  await multicall(h.addresses.fileStore as Hex, fileStoreAbi, [encodeFunctionData({ abi: fileStoreAbi, functionName: "createFile", args: [tree.root, mime, ZERO_HASH, ZERO_HASH] })]);
  expect(await h.publicClient.readContract({ address: h.addresses.fileStore as Hex, abi: fileStoreAbi, functionName: "fileExists", args: [cid] } as never)).toBe(true);
  return { cid, tree };
}

async function sendDir(entries: DirectoryEntry[], leafGasCap?: number, perTx = 40) {
  const tree = packEntryTree(entries, leafGasCap !== undefined ? { leafGasCap } : {});
  await putNodes("entries", tree.nodes, perTx);
  const cid = directoryCid(tree.root);
  const sim = await h.publicClient.simulateContract({ address: h.addresses.directoryStore as Hex, abi: directoryStoreAbi, functionName: "createDirectory", args: [tree.root], account: h.account } as never);
  expect((sim.result as string).toLowerCase()).toBe(cid.toLowerCase());
  await multicall(h.addresses.directoryStore as Hex, directoryStoreAbi, [encodeFunctionData({ abi: directoryStoreAbi, functionName: "createDirectory", args: [tree.root] })]);
  expect(await h.publicClient.readContract({ address: h.addresses.directoryStore as Hex, abi: directoryStoreAbi, functionName: "directoryExists", args: [cid] } as never)).toBe(true);
  return { cid, tree };
}

let leafFile: AbxfsCid;
let leafDir: AbxfsCid;

describe("pack vs chain: files", () => {
  it("the empty file: no nodes, root zero, and the contract computes the same CID", async () => {
    const { cid, tree } = await sendFile([]);
    expect(tree.nodes).toEqual([]);
    const info = (await h.publicClient.readContract({ address: h.addresses.fileStore as Hex, abi: fileStoreAbi, functionName: "getFileInfo", args: [cid] } as never)) as { chunkCount: bigint; size: bigint };
    expect([Number(info.chunkCount), Number(info.size)]).toEqual([0, 0]);
  }, 120_000);

  it("1 chunk", async () => {
    const cs = await ensureChunks(1);
    leafFile = (await sendFile(cs)).cid;
  }, 120_000);
  for (const n of (process.env.A7_BIG ? [] : [32, 512, 1200, 6000])) {
    it(`${n} chunks`, async () => {
      const cs = await ensureChunks(n);
      const { cid, tree } = await sendFile(cs);
      expect(tree.count).toBe(n);
      // the contract agrees about the chunk count, the level and the byte total
      const info = (await h.publicClient.readContract({ address: h.addresses.fileStore as Hex, abi: fileStoreAbi, functionName: "getFileInfo", args: [cid] } as never)) as { chunkCount: bigint; size: bigint; rootLevel: number };
      const sizes = chunkSizes(n);
      expect(Number(info.chunkCount)).toBe(n);
      expect(Number(info.rootLevel)).toBe(tree.rootLevel);
      expect(Number(info.size)).toBe(sizes.reduce((a, b) => a + b, 0));
      // locateByte agrees with the local offsets at a spread of chunks (first byte, last byte)
      let start = 0;
      const starts = sizes.map((s) => ((start += s), start - s));
      for (const i of [0, 1, Math.floor(n / 3), Math.floor(n / 2), n - 2, n - 1].filter((i) => i >= 0 && i < n)) {
        for (const off of [starts[i]!, starts[i]! + sizes[i]! - 1]) {
          const r = (await h.publicClient.readContract({ address: h.addresses.fileStore as Hex, abi: fileStoreAbi, functionName: "locateByte", args: [cid, BigInt(off)] } as never)) as readonly [bigint, bigint, Hex, bigint];
          expect([Number(r[0]), Number(r[1]), r[2].toLowerCase(), Number(r[3])]).toEqual([i, starts[i], cs[i]!.toLowerCase(), sizes[i]]);
        }
      }
    }, 900_000);
  }
});

describe("pack vs chain: directories", () => {
  const e = (name: string, isDirectory = false): DirectoryEntry => ({ name, cid: (isDirectory ? leafDir : leafFile) as AbxfsCid, isDirectory });

  it("the empty directory: no nodes, and the contract's EMPTY_DIRECTORY", async () => {
    const { cid, tree } = await sendDir([]);
    expect(tree.nodes).toEqual([]);
    expect(await h.publicClient.readContract({ address: h.addresses.directoryStore as Hex, abi: directoryStoreAbi, functionName: "EMPTY_DIRECTORY" } as never)).toBe(cid);
  }, 120_000);

  it("directory containing a directory root, unicode/NUL/NFC/NFD/255-byte names", async () => {
    const d1 = await sendDir([e("only")]);
    leafDir = d1.cid;
    const names = [
      "a", "A", "z", "é", "é", "～", "", "\u{10000}", "\u{1F600}", "퟿",
      "a\u0000b", "a\u0000", "a\u0001", "x".repeat(255), "x".repeat(254), "€".repeat(85), "\u{1F600}".repeat(63) + "ab",
      "\u0001", "\u007f", "\u0080", "~", "name with space", "-", ".hidden", "..x", "a.", "​zw", "‮bidi",
    ];
    const entries = names.map((n, i) => e(n, i % 5 === 0));
    await sendDir(entries);
    // reversed insertion order must give the same root
    expect(packEntryTree([...entries].reverse()).root).toBe(packEntryTree(entries).root);
  }, 120_000);

  it("84 x 255-byte names: leaf at the byte limit (uncapped gas cap) is accepted by the contract", async () => {
    // Names chosen so none is a content-defined boundary: the leaf is then bounded only by the byte limit.
    const entries: DirectoryEntry[] = [];
    for (let i = 1000; entries.length < 84; i++) {
      const name = String(i) + "y".repeat(251);
      if (nameKey(new TextEncoder().encode(name)) > 0x20000000) entries.push(e(name));
    }
    const { tree } = await sendDir(entries, Infinity);
    expect(tree.nodes.length).toBe(1);
    expect(tree.nodes[0]!.blob.length).toBeLessThanOrEqual(24_575);
  }, 120_000);

  const mk = (n: number) => Array.from({ length: n }, (_, i) => e("n" + String(i).padStart(6, "0")));
  for (const leaves of [2, 31, 32, 33, 128, 129, 257, 2000]) {
    it(`${leaves} one-entry leaves`, async () => {
      const { tree } = await sendDir(mk(leaves), 0);
      expect(tree.count).toBe(leaves);
    }, 300_000);
  }
  for (const leaves of (process.env.A7_BIG ? [128 * 128 + 1] : [])) {
    it(`${leaves} one-entry leaves (${leaves > 16384 ? "three" : "two"} levels)`, async () => {
      const { tree } = await sendDir(mk(leaves), 0, 120);
      expect(tree.rootLevel).toBe(leaves > 16384 ? 3 : 2);
    }, 1_200_000);
  }
});
