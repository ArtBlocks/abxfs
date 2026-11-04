/**
 * Canonical packing for ABX FS (`src/nodes.ts`): golden vectors cross-checked against the contracts, packing edge
 * cases, and an independent reimplementation of the CID formulas.
 *
 * The golden literals below are the ones asserted by `packages/contracts-core/test/GoldenVectors.t.sol`, where the
 * contracts rebuild the same blobs independently and must produce the same ids: if either side changes, one of the two
 * suites fails. Regenerate with `node scripts/golden-vectors.mjs` after `pnpm build`.
 */
import { keccak256, toBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  BRANCH_MAX_CHILDREN,
  CHUNK_LEAF_MAX_HASHES,
  ENTRY_LEAF_GAS_CAP,
  NODE_MAX_BYTES,
  NODE_MAX_LEVEL,
  assertEntryName,
  assertTreeLevels,
  EMPTY_DIRECTORY,
  compareNameBytes,
  directoryCid,
  fileCid,
  packChunkTree,
  packDirectory,
  packEntryTree,
  packFile,
} from "../src/nodes.js";
import { PlanTooLargeError, fitsSingleCall, resolveSingleCallLimits } from "../src/gas.js";
import { EIP8037_GAS_SCHEDULE, LEGACY_GAS_SCHEDULE } from "../src/gas-schedule.js";
import {
  BRANCH_BOUNDARY_ODDS,
  CHUNK_LEAF_MIN_HASHES,
  ENTRY_LEAF_MIN_BYTES,
  NODE_GAS,
  branchGroupSizes,
  branchLevelsNeeded,
  entryLeafPackingCost,
  nameKey,
  nodeGasEstimate,
  partitionChunkLeaves,
  partitionEntryLeaves,
} from "../src/node-gas.js";
import { ZERO_HASH, chunkId } from "../src/cid.js";
import { codecLabel } from "../src/compression.js";
import type { AbxfsCid, DirectoryEntry } from "../src/types.js";
import { concatBytes, fromHex } from "../src/util.js";

const h = (i: number): Hex => keccak256(toBytes(`chunk-${i}`));
/** The same hash with its top byte 0xff: never a content-defined boundary. */
const high = (i: number): Hex => `0xff${h(i).slice(4)}` as Hex;
const hashes = (n: number): Hex[] => Array.from({ length: n }, (_, i) => h(i));
const size = (i: number): number => 1000 + 100 * (i % 7);
const sizes = (n: number): number[] => Array.from({ length: n }, (_, i) => size(i));
/** Pack `n` golden chunks (packing needs only ids and sizes, so these ids are arbitrary hashes). */
const chunks = (n: number, hs: Hex[] = hashes(n)) => packChunkTree(hs, sizes(n));
const cid = (n: number): AbxfsCid => keccak256(toBytes(`child-${n}`)) as AbxfsCid;
const entry = (name: string, n = 0, isDirectory = false): DirectoryEntry => ({ name, cid: cid(n), isDirectory });

/** Parse a leaf's records back out of its blob, to check the layout byte for byte. */
function parseEntryLeaf(blob: Uint8Array): Array<{ name: string; isDirectory: boolean; cid: string }> {
  expect(blob[0]).toBe(0);
  const count = (blob[1]! << 8) | blob[2]!;
  const recStart = 3 + 2 * count;
  const out: Array<{ name: string; isDirectory: boolean; cid: string }> = [];
  let pos = recStart;
  for (let i = 0; i < count; i++) {
    const off = (blob[3 + 2 * i]! << 8) | blob[4 + 2 * i]!;
    expect(off).toBe(pos - recStart);
    const nameLen = blob[pos]!;
    out.push({
      name: new TextDecoder().decode(blob.slice(pos + 1, pos + 1 + nameLen)),
      isDirectory: blob[pos + 1 + nameLen] === 1,
      cid: "0x" + Buffer.from(blob.slice(pos + 2 + nameLen, pos + 2 + nameLen + 32)).toString("hex"),
    });
    pos += 1 + nameLen + 1 + 32;
  }
  expect(pos).toBe(blob.length); // consumed exactly, no trailing bytes
  return out;
}

function parseBranch(
  blob: Uint8Array,
  withBytes = false,
): { level: number; children: Array<{ id: string; cumulative: number; cumulativeBytes: number }> } {
  const n = (blob[1]! << 8) | blob[2]!;
  const stride = withBytes ? 42 : 36;
  expect(blob.length).toBe(3 + stride * n);
  const children = [];
  for (let i = 0; i < n; i++) {
    const o = 3 + stride * i;
    let cumulativeBytes = 0;
    if (withBytes) for (let k = 0; k < 6; k++) cumulativeBytes = cumulativeBytes * 256 + blob[o + 36 + k]!;
    children.push({
      id: "0x" + Buffer.from(blob.slice(o, o + 32)).toString("hex"),
      cumulative: ((blob[o + 32]! << 24) | (blob[o + 33]! << 16) | (blob[o + 34]! << 8) | blob[o + 35]!) >>> 0,
      cumulativeBytes,
    });
  }
  return { level: blob[0]!, children };
}

describe("golden vectors (cross-checked against contracts-core/test/GoldenVectors.t.sol)", () => {
  it("f1: a three-chunk file is one leaf, and its CID binds the mime", () => {
    const t = chunks(3);
    expect(t.root).toBe("0xb170625499033c6e6a4fbf0a701456ef5091abe18322e5e1c648f8501d862dd7");
    expect(t.rootLevel).toBe(0);
    expect(fileCid(t.root, "text/plain")).toBe("0xc46016b13ec4f99a586c66c08ff0f0e5550b725a710c92c6b3da70be6de5dcd6");
  });

  it("f2: 1,200 chunks fall into content-defined leaves under one branch; the CID binds a file codec and outputHash", () => {
    const t = chunks(1200);
    expect(t.nodes.map((n) => [n.id, n.level, n.count, n.size])).toEqual([
      ["0xce52c55dd1f21d4770b839ce4fadd55149dcbba87d8e2a1107d59288bf9cc360", 0, 167, 216800],
      ["0x49aae6cadd23785bbdb53a9dfcecebeff10e4dd40943b33c42f5f1d1e9a69f28", 0, 108, 140200],
      ["0xc823f2e7d333d9b9b5fe95bd3c0a9fc70da91b612ce13344b560c6c5d8efd449", 0, 81, 105500],
      ["0x93ce0888ffcc6822f961133f5dfbd865f5aaaa54a5c6c9ca88b6908128d729bf", 0, 43, 56200],
      ["0xeb2e4b20f22c11bcd4f4bd4bc7081f6a03fd966dc41e8625fc87528b1a4fb855", 0, 246, 319500],
      ["0x1ba606b18c8ca2d455bb9f4e298d5eec77c0da4b25edec793462fab6e3a66dbb", 0, 39, 50500],
      ["0x3e722cb8291ef2a1a885aaa998dc9c51ad133b16b4f88474e01ea1a55535e21c", 0, 114, 148700],
      ["0x807cafd186caadf3bdc6862da336656037bc1faa75d352864a618e467d4815d5", 0, 105, 136500],
      ["0xf159e287cf9cf306df73642134d6d80867bde6918b04b45fbebb78b028a1fce2", 0, 67, 86500],
      ["0xaccae74745af3d22ac92432262368813ee27ecf6339943f1dfe4e9056445d2c3", 0, 230, 299000],
      ["0x4f1d830e2e965adfc3b13177f08110b30cdc5a74ceaf2d834915d38dbb9cc0a5", 1, 1200, 1559400],
    ]);
    expect(fileCid(t.root, "application/octet-stream", codecLabel("gzip"), keccak256(toBytes("logical")))).toBe(
      "0x4edc30c0530e45806c0b4c1fdc35cfb098790ed5a7d7a1f1bd50fd1010ee56da",
    );
  });

  it("f3: with no natural boundary, leaves are forced at the 512 maximum", () => {
    const t = chunks(1100, Array.from({ length: 1100 }, (_, i) => high(i)));
    expect(t.nodes.map((n) => [n.id, n.level, n.count, n.size])).toEqual([
      ["0xd593f82a87fbf7e623cef76af879df00010a8ac15034c3e7cc805133b6dba55d", 0, 512, 665300],
      ["0x9a8b7be880e5a12012548d28a2bfd3278daaf5ab463252d32fe8f86d6eb33b66", 0, 512, 665400],
      ["0xc3967e31c2e3ee8c577a6e368bf75011eb479b0cde376565d7a7a5ede541e1b4", 0, 76, 99000],
      ["0x2ba7ce3377c4ad0a7ac266b3a955ac64c95c1fbae22547164aa1760d2406a5c7", 1, 1100, 1429700],
    ]);
    expect(fileCid(t.root, "video/mp4")).toBe("0xd182ab0e89e37caa4bab2c6bddbbaa3be1c97d543f8c58f9d145b18580697c72");
  });

  it("f4: 132 minimum-size leaves fall into content-defined BRANCHES (23, 30, 41, 35, 3) under a level-2 root", () => {
    const low = Array.from({ length: 4200 }, (_, i) => `0x00${h(i).slice(4)}` as Hex);
    const t = chunks(4200, low);
    expect(t.nodes.filter((n) => n.level === 0)).toHaveLength(132);
    expect(t.nodes.filter((n) => n.level >= 1).map((n) => [n.level, n.childIds.length])).toEqual([[1, 23], [1, 30], [1, 41], [1, 35], [1, 3], [2, 5]]);
    expect(t.root).toBe("0x5dea3369c24cd5a309625df419d6b93630a21d7ca9a60244d1a9e1745bdf9254");
    expect(fileCid(t.root, "application/octet-stream")).toBe("0xb94533e7761c324c06b2989d07814a05d535e2e137edaa5c4c2bc2fc638d4f01");
  });

  it("f5: real chunk ids (raw backend 0x…aa, data \"real-i\") pin the chunk-id formula on both sides", () => {
    const backend = "0x00000000000000000000000000000000000000aa";
    const real = [0, 1, 2].map((i) => {
      const data = toBytes(`real-${i}`);
      const dh = keccak256(data);
      return { id: chunkId(backend, dh, dh, data.length), size: data.length };
    });
    expect(real.map((c) => c.id)).toEqual([
      "0x5f4138159122e3e2f096288735e7f2a295a3ccb16d43610ad3f16fc2a5d2ae9e",
      "0xc079884f8615532266b183f3c06265a0e20231de6d025db6c3a4ac62802e720f",
      "0x15b8b14a8840bef55602c78e751738a08e345a9f1f0e939b1e4d213bdd6c56c1",
    ]);
    const t = packChunkTree(real.map((c) => c.id), real.map((c) => c.size));
    expect(t.root).toBe("0xb24b7c3349eebbbde38096f0db1f4da38a3d162a2a5bfbf4066e1ed886454546");
    expect(fileCid(t.root, "text/plain")).toBe("0xd351693ccf47f7351a75a2629e91c1281c6ad9e0a530d4ebaa6d8a833e41b47d");
  });

  it("empty: the empty file (root zero) and the empty directory", () => {
    expect(fileCid(ZERO_HASH, "text/plain")).toBe("0x706e21029ca1aed7fba562e7975e12fb5327ef0c517c1687df062d8dd2ad0200");
    expect(EMPTY_DIRECTORY).toBe("0xcbe207ab59076db4a264371e3417d6936ea6321bc7c2654a4146cd2bc9d6dd4c");
    expect(directoryCid(ZERO_HASH)).toBe(EMPTY_DIRECTORY);
  });

  const f1cid = fileCid(chunks(3).root, "text/plain");

  it("d1: a one-entry directory is one leaf", () => {
    const t = packEntryTree([{ name: "x", cid: f1cid, isDirectory: false }]);
    expect(t.root).toBe("0xe9ebf724ad6c9093494267ab21b5083be76042fd2afbb5119a38acaa34388608");
    expect(directoryCid(t.root)).toBe("0x19cf8bdcb8f3c347a8c675f1e42f1a712b5a2d1974a2ace61b2ed9d2be69d82b");
  });

  it("d2: unicode names sort by UNSIGNED BYTES (not UTF-16), in one leaf", () => {
    const d1cid = directoryCid(packEntryTree([{ name: "x", cid: f1cid, isDirectory: false }]).root);
    const names = ["a", "z", "é", "Ａ", "😀", "日本"].map((name) => ({ name, cid: f1cid, isDirectory: false }));
    // Fed in the order JS would sort them (UTF-16), which is NOT the contract's order.
    const t = packEntryTree([...names, { name: "dir", cid: d1cid, isDirectory: true }]);
    expect(t.root).toBe("0xac929b2e8ca844e7c9e84037e6185ae1f13be204672ee41d1357f17e64d0633a");
    expect(directoryCid(t.root)).toBe("0xf010c270a3de3a878f5534e13182ab16251d321bca928046cd2412d1ae6b92fa");
    expect(parseEntryLeaf(t.nodes[0]!.blob).map((e) => e.name)).toEqual(["a", "dir", "z", "é", "日本", "Ａ", "😀"]);
  });

  it("d3: 400 entries fall into content-defined leaves (215 + 185) under a branch", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `e${String(i).padStart(3, "0")}`, cid: f1cid, isDirectory: false }));
    const t = packEntryTree(many);
    expect(t.nodes.filter((n) => n.level === 0).map((n) => n.count)).toEqual([215, 185]);
    expect(t.root).toBe("0xb91f959eb73d1a8c18382fd4c12e2b9ea6c7696d7196a7bdc32d8cea01087cbd");
    expect(directoryCid(t.root)).toBe("0xc355923ea89474f100f2962c3c69e2803f495c1766acedc37032c37441ec8a68");
  });

  it("d4: a directory holding the empty file and the empty directory", () => {
    const t = packEntryTree([
      { name: ".nojekyll", cid: fileCid(ZERO_HASH, "text/plain"), isDirectory: false },
      { name: "e", cid: EMPTY_DIRECTORY, isDirectory: true },
    ]);
    expect(t.root).toBe("0xf49f91388b85f5420e969f3185809b23834d66d8dea0078e5ef9a06b74d0c9f6");
    expect(directoryCid(t.root)).toBe("0xd1a913d15f9da7e67605314b479f309a5940b633c4ed7115ff6653f9a85b552b");
  });
});

describe("an independent reimplementation of the CID formulas", () => {
  const k = (b: Uint8Array): Uint8Array => fromHex(keccak256(b));
  it("file CID = keccak(0x31 || root || keccak(mime) || codec:32 || outputHash)", () => {
    const root = chunks(5).root;
    const out = keccak256(toBytes("logical"));
    for (const [mime, codec, outHash] of [
      ["text/plain", ZERO_HASH, ZERO_HASH],
      ["image/png", codecLabel("gzip"), out],
      ["application/x-é", codecLabel("br"), out],
    ] as const) {
      const expected = keccak256(
        Buffer.concat([
          Buffer.from([0x31]),
          Buffer.from(fromHex(root)),
          Buffer.from(k(new TextEncoder().encode(mime))),
          Buffer.from(fromHex(codec)),
          Buffer.from(fromHex(outHash)),
        ]),
      );
      expect(fileCid(root, mime, codec, outHash)).toBe(expected);
    }
  });
  it("directory CID = keccak(0x32 || root); node id = keccak(prefix || blob) with 0x42 entry / 0x41 chunk nodes", () => {
    const t = packEntryTree([entry("a"), entry("b")]);
    expect(directoryCid(t.root)).toBe(keccak256(Buffer.concat([Buffer.from([0x32]), Buffer.from(fromHex(t.root))])));
    expect(t.root).toBe(keccak256(Buffer.concat([Buffer.from([0x42]), Buffer.from(t.nodes[0]!.blob)])));
    const c = chunks(2);
    expect(c.root).toBe(keccak256(Buffer.concat([Buffer.from([0x41]), Buffer.from(c.nodes[0]!.blob)])));
  });
  it("a chunk leaf is exactly 0x00 || (chunkId || size:6) x n, and records its byte total", () => {
    const t = chunks(4);
    const hex = (n: number) => n.toString(16).padStart(12, "0");
    expect(Buffer.from(t.nodes[0]!.blob).toString("hex")).toBe(
      "00" + hashes(4).map((x, i) => x.slice(2) + hex(size(i))).join(""),
    );
    expect(t.nodes[0]!.size).toBe(1000 + 1100 + 1200 + 1300);
  });
  it("rejects what the contract would revert: mime bounds, codec/outputHash pairing, a codec on the empty file", () => {
    const root = chunks(1).root;
    const out = keccak256("0x01");
    expect(() => fileCid(root, "")).toThrow(/mime/);
    expect(() => fileCid(root, "x".repeat(128))).toThrow(/mime/);
    expect(() => fileCid(root, "x".repeat(127))).not.toThrow();
    expect(() => fileCid(root, "text/plain", ZERO_HASH, out)).toThrow(/both zero or both set/);
    expect(() => fileCid(root, "text/plain", codecLabel("gzip"), ZERO_HASH)).toThrow(/both zero or both set/);
    expect(() => fileCid(root, "text/plain", codecLabel("gzip"), out)).not.toThrow();
    expect(() => fileCid(ZERO_HASH, "text/plain", codecLabel("gzip"), out)).toThrow(/empty file has no codec/);
    expect(() => fileCid(root, "text/plain", "0x01" as Hex)).toThrow(/codec/);
  });
});

describe("chunk trees", () => {
  it("a single chunk is a one-record leaf; a leaf never passes 512 records", () => {
    expect(chunks(1).nodes).toHaveLength(1);
    const forced = chunks(512, Array.from({ length: 512 }, (_, i) => high(i)));
    expect(forced.nodes).toHaveLength(1);
    expect(forced.nodes[0]!.blob.length).toBe(1 + 38 * 512);
    const over = chunks(513, Array.from({ length: 513 }, (_, i) => high(i)));
    expect(over.nodes.map((n) => [n.level, n.count])).toEqual([[0, 512], [0, 1], [1, 513]]);
  });

  it("no content-defined boundary before 32 records", () => {
    // Every key is a boundary candidate (top byte 0x00): leaves are exactly the minimum.
    const low = Array.from({ length: 100 }, (_, i) => `0x00${h(i).slice(4)}` as Hex);
    expect(chunks(100, low).nodes.filter((n) => n.level === 0).map((n) => n.count)).toEqual([32, 32, 32, 4]);
    expect(CHUNK_LEAF_MIN_HASHES).toBe(32);
  });

  it("file branches carry cumulative counts AND bytes", () => {
    const t = chunks(1200);
    const root = t.nodes[t.nodes.length - 1]!;
    const b = parseBranch(root.blob, true);
    const leaves = t.nodes.filter((n) => n.level === 0);
    let c = 0;
    let bytes = 0;
    b.children.forEach((child, i) => {
      c += leaves[i]!.count;
      bytes += leaves[i]!.size;
      expect(child.id).toBe(leaves[i]!.id);
      expect(child.cumulative).toBe(c);
      expect(child.cumulativeBytes).toBe(bytes);
    });
    expect(root.size).toBe(sizes(1200).reduce((x, y) => x + y, 0));
  });

  it("no chunks is the empty tree: root zero, no nodes (the empty file)", () => {
    expect(packChunkTree([], [])).toEqual({ kind: "chunks", root: ZERO_HASH, rootLevel: 0, count: 0, nodes: [] });
    expect(packFile({ chunkIds: [], chunkSizes: [], mimeType: "text/plain" }).cid).toBe(fileCid(ZERO_HASH, "text/plain"));
  });

  it("refuses a missing size and sizes outside 1..2^48 - 1; a chunk past 65,535 bytes is fine (u48 sizes)", () => {
    expect(() => packChunkTree(hashes(2), [1])).toThrow(/one size per chunk/);
    expect(() => packChunkTree(hashes(1), [0])).toThrow(/sizes are 1 to 2\^48 - 1/);
    expect(() => packChunkTree(hashes(1), [2 ** 48])).toThrow(/sizes are 1 to 2\^48 - 1/);
    expect(() => packChunkTree(hashes(1), [1.5])).toThrow(/sizes are 1 to 2\^48 - 1/);
    const big = packChunkTree(hashes(2), [65_536, 2 ** 48 - 1 - 65_536]);
    expect(big.nodes[0]!.size).toBe(2 ** 48 - 1);
    expect(Buffer.from(big.nodes[0]!.blob.slice(33, 39)).toString("hex")).toBe("000000010000");
  });

  it("every node is children-first and every branch's children are exactly one level below", () => {
    const t = chunks(20_000);
    const level = new Map(t.nodes.map((n) => [n.id, n.level]));
    const seen = new Set<string>();
    for (const n of t.nodes) {
      for (const c of n.childIds) {
        expect(seen.has(c)).toBe(true); // created before its parent
        expect(level.get(c)).toBe(n.level - 1);
      }
      seen.add(n.id);
    }
    expect(t.rootLevel).toBeGreaterThanOrEqual(1);
  });
});

describe("branches", () => {
  const LOW = 0; // a boundary key
  const HIGH = 0xffffffff; // never a boundary
  it("a branch ends after a low-keyed child once it has two; always at 128", () => {
    expect(branchGroupSizes([HIGH, HIGH])).toEqual([2]);
    expect(branchGroupSizes([LOW, LOW, LOW, LOW])).toEqual([2, 2]);
    expect(branchGroupSizes([HIGH, HIGH, LOW, HIGH, HIGH])).toEqual([3, 2]);
    expect(branchGroupSizes(Array(128).fill(HIGH))).toEqual([128]);
    expect(branchGroupSizes(Array(129 + 2).fill(HIGH))).toEqual([128, 3]);
    expect(() => branchGroupSizes([HIGH])).toThrow();
  });
  it("never a trailing group of one: it joins the group before, or takes one from a full one", () => {
    expect(branchGroupSizes([HIGH, LOW, HIGH])).toEqual([3]);
    expect(branchGroupSizes([HIGH, HIGH, LOW, HIGH, LOW, HIGH])).toEqual([3, 3]);
    expect(branchGroupSizes(Array(129).fill(HIGH))).toEqual([127, 2]);
    for (let n = 2; n < 600; n += 7) {
      const keys = Array.from({ length: n }, (_, i) => parseInt(h(i).slice(2, 10), 16));
      const got = branchGroupSizes(keys);
      expect(got.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.min(...got)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...got)).toBeLessThanOrEqual(BRANCH_MAX_CHILDREN);
    }
    expect(BRANCH_BOUNDARY_ODDS).toBe(32);
  });
});

describe("the level cap", () => {
  it("the fewest levels n leaves can need: 1 = 0; 128 = 1; 129 = 2; 128^3 = 3; 128^3+1 = 4", () => {
    expect(branchLevelsNeeded(1)).toBe(0);
    expect(branchLevelsNeeded(128)).toBe(1);
    expect(branchLevelsNeeded(129)).toBe(2);
    expect(branchLevelsNeeded(128 ** 2)).toBe(2);
    expect(branchLevelsNeeded(128 ** 2 + 1)).toBe(3);
    expect(branchLevelsNeeded(128 ** 3)).toBe(3);
    expect(branchLevelsNeeded(128 ** 3 + 1)).toBe(4);
  });

  it("thousands of one-entry leaves stack into a three-level tree whose root counts every entry", () => {
    const entries = Array.from({ length: 5000 }, (_, i) => entry(`n${String(i).padStart(6, "0")}`, i));
    // A 100k gas cap puts exactly one record in each leaf.
    const t = packEntryTree(entries, { leafGasCap: 100_000 });
    expect(t.nodes.filter((n) => n.level === 0)).toHaveLength(5000);
    expect(t.rootLevel).toBe(3);
    expect(t.count).toBe(5000);
    const root = parseBranch(t.nodes[t.nodes.length - 1]!.blob);
    expect(root.children[root.children.length - 1]!.cumulative).toBe(5000);
  }, 60_000);

  it("a tree past the cap is refused with PlanTooLargeError before anything is built", () => {
    expect(() => assertTreeLevels(128 ** 3, "file", "a.bin", 1)).not.toThrow();
    let err: unknown;
    try {
      assertTreeLevels(128 ** 3 + 1, "directory", "big", 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlanTooLargeError);
    const e = err as PlanTooLargeError;
    expect(e.reason).toBe("levels");
    expect(e.levelsNeeded).toBe(4);
    expect(e.levelCap).toBe(NODE_MAX_LEVEL);
    expect(e.path).toBe("big");
    expect(e.message).toMatch(/Nothing was written/);
  });

  it("the packed tree itself is checked: a content-defined tree that needs a fourth level is refused", () => {
    // One record per leaf and every node id a boundary would be the worst case; here, force it with the gas cap and
    // enough leaves that even 128-wide branches need four levels is too big to build in a test, so check the error
    // path through stackBranches with the cap lowered by a tiny tree instead: 40k one-entry leaves at ~34 per branch.
    const entries = Array.from({ length: 40_000 }, (_, i) => entry(`n${String(i).padStart(6, "0")}`, i));
    let err: unknown;
    try {
      packEntryTree(entries, { leafGasCap: 100_000, path: "deep" });
    } catch (e) {
      err = e;
    }
    // 40,000 leaves need 4 levels at the expected 34 children per branch, though 3 at 128.
    expect(err).toBeInstanceOf(PlanTooLargeError);
    expect((err as PlanTooLargeError).reason).toBe("levels");
    expect((err as PlanTooLargeError).path).toBe("deep");
  }, 120_000);
});

describe("entry trees", () => {
  it("a single entry is one leaf at level 0", () => {
    const t = packEntryTree([entry("only.txt")]);
    expect(t.nodes).toHaveLength(1);
    expect(t.rootLevel).toBe(0);
    expect(t.count).toBe(1);
    expect(parseEntryLeaf(t.nodes[0]!.blob)).toEqual([{ name: "only.txt", isDirectory: false, cid: cid(0) }]);
  });

  it("no entries is the empty directory: root zero, no nodes", () => {
    expect(packEntryTree([])).toEqual({ kind: "entries", root: ZERO_HASH, rootLevel: 0, count: 0, nodes: [] });
    expect(packDirectory([]).cid).toBe(EMPTY_DIRECTORY);
  });

  it("the typical case is unchanged: a directory under 4 KB of records is ONE leaf", () => {
    // 60 entries with 20-byte names: 60 x 56 = 3,360 bytes + header.
    const typical = Array.from({ length: 60 }, (_, i) => entry(`asset-${String(i).padStart(4, "0")}-abcdefghi`, i));
    expect(new TextEncoder().encode(typical[0]!.name).length).toBe(20);
    const t = packEntryTree(typical);
    expect(t.nodes).toHaveLength(1);
    expect(t.rootLevel).toBe(0);
    expect(ENTRY_LEAF_MIN_BYTES).toBe(4096);
  });

  it("is deterministic and order-independent: any input order packs to the same root", () => {
    const a = Array.from({ length: 500 }, (_, i) => entry(`file-${i}.txt`, i));
    const shuffled = [...a].reverse().sort((x, y) => (x.name.length % 7) - (y.name.length % 7));
    expect(packEntryTree(shuffled).root).toBe(packEntryTree(a).root);
    expect(packDirectory(a).cid).toBe(packDirectory([...a].reverse()).cid);
  });

  it("an entry that is a directory and one that is a file are different leaves", () => {
    expect(packEntryTree([entry("x", 1, true)]).root).not.toBe(packEntryTree([entry("x", 1, false)]).root);
  });

  it("names: sorted by unsigned bytes, not UTF-16 code units", () => {
    // "Ａ" is U+FF21 (ef bc a1); "😀" is U+1F600 (f0 9f 98 80, UTF-16 surrogates d83d de00).
    expect(["Ａ", "😀"].sort()).toEqual(["😀", "Ａ"]); // JS default (UTF-16) order: the emoji first
    const bytes = new TextEncoder();
    expect(compareNameBytes(bytes.encode("Ａ"), bytes.encode("😀"))).toBeLessThan(0); // bytes: Ａ first
    const t = packEntryTree([entry("😀"), entry("Ａ"), entry("b"), entry("B"), entry("é"), entry("e")]);
    expect(parseEntryLeaf(t.nodes[0]!.blob).map((e) => e.name)).toEqual(["B", "b", "e", "é", "Ａ", "😀"]);
    // A shorter prefix sorts first.
    expect(compareNameBytes(bytes.encode("ab"), bytes.encode("abc"))).toBeLessThan(0);
  });

  it("rejects duplicate names, including after sorting", () => {
    expect(() => packEntryTree([entry("a", 1), entry("b", 2), entry("a", 3)])).toThrow(/duplicate entry name/);
  });

  it("name rules are the contract's: 1..255 bytes, not . or .., no / or backslash; NUL and control bytes are allowed", () => {
    expect(() => assertEntryName("")).toThrow();
    expect(() => assertEntryName(".")).toThrow();
    expect(() => assertEntryName("..")).toThrow();
    expect(() => assertEntryName("...")).not.toThrow();
    expect(() => assertEntryName("a/b")).toThrow();
    expect(() => assertEntryName("a\\b")).toThrow();
    expect(() => assertEntryName("n".repeat(255))).not.toThrow();
    expect(() => assertEntryName("n".repeat(256))).toThrow();
    expect(() => assertEntryName("é".repeat(128))).toThrow(); // 256 BYTES, 128 characters
    expect(() => assertEntryName("é".repeat(127))).not.toThrow(); // 254 bytes
    expect(() => assertEntryName("a\u0000b\u0001")).not.toThrow();
  });

  it("255-byte names: every leaf within the 24,575-byte limit and the frozen packing cap, and every node fits one call", () => {
    const entries = Array.from({ length: 2000 }, (_, i) => entry(String(i).padStart(4, "0") + "n".repeat(251), i));
    for (const cap of [Infinity, ENTRY_LEAF_GAS_CAP]) {
      const t = packEntryTree(entries, { leafGasCap: cap });
      for (const n of t.nodes) expect(n.blob.length).toBeLessThanOrEqual(NODE_MAX_BYTES);
      if (cap === Infinity) continue;
      for (const n of t.nodes.filter((x) => x.level === 0)) {
        let nameBytes = 0;
        const count = (n.blob[1]! << 8) | n.blob[2]!;
        for (let i = 0; i < count; i++) nameBytes += 251 + 4;
        expect(entryLeafPackingCost(count, nameBytes)).toBeLessThanOrEqual(ENTRY_LEAF_GAS_CAP);
      }
      // The packing cap bounds the FROZEN packing cost, not gas: such a leaf measured 9.8M under legacy pricing. What
      // matters is that every node still fits one transaction under either schedule.
      for (const s of [LEGACY_GAS_SCHEDULE, EIP8037_GAS_SCHEDULE]) {
        const ceiling = resolveSingleCallLimits({ schedule: s });
        for (const n of t.nodes) expect(fitsSingleCall(nodeGasEstimate(n, s), ceiling)).toBe(true);
      }
    }
  });

  it("a leaf that is EXACTLY 24,575 bytes is accepted as one leaf when no boundary falls inside it", () => {
    // 100 records whose names are never boundaries (filtered on their key): 3 + 36 x 100 + names = 24,575.
    const mk = (n: number, len: number, base: number): DirectoryEntry[] => {
      const out: DirectoryEntry[] = [];
      for (let i = base; out.length < n; i++) {
        const name = String(i).padStart(len, "n");
        if (nameKey(new TextEncoder().encode(name)) > 0x10000000) out.push(entry(name, i));
      }
      return out;
    };
    const entries = [...mk(72, 210, 100_000), ...mk(28, 209, 200_000)];
    const t = packEntryTree(entries, { leafGasCap: Infinity });
    expect(t.nodes).toHaveLength(1);
    expect(t.nodes[0]!.blob.length).toBe(NODE_MAX_BYTES);
    const more = packEntryTree([...entries, entry("a")], { leafGasCap: Infinity });
    expect(more.nodes.filter((n) => n.level === 0)).toHaveLength(2);
    expect(more.rootLevel).toBe(1);
  });

  it("unicode names pack and parse back byte for byte", () => {
    const names = ["日本語.txt", "ñandú", "emoji-😀.png", "Ａ", "ключ"];
    const t = packEntryTree(names.map((n) => entry(n)));
    expect(parseEntryLeaf(t.nodes[0]!.blob).map((e) => e.name).sort()).toEqual([...names].sort());
  });

  it("the gas cap is part of canonical packing: a different cap is a different tree", () => {
    const entries = Array.from({ length: 3000 }, (_, i) => entry(`f${String(i).padStart(4, "0")}`, i));
    expect(packEntryTree(entries).nodes.filter((n) => n.level === 0).length).toBeLessThan(
      packEntryTree(entries, { leafGasCap: 300_000 }).nodes.filter((n) => n.level === 0).length,
    );
  });
});

/**
 * The point of content-defined boundaries: an edit rewrites the nodes around it, not every node after it. Each case
 * packs the object, edits it, and counts the nodes of the edited tree that the original did not already have (what
 * an upload would actually send).
 */
describe("edits are local", () => {
  const newNodes = (before: { nodes: Array<{ id: string }> }, after: { nodes: Array<{ id: string; level: number }> }) => {
    const had = new Set(before.nodes.map((n) => n.id));
    const fresh = after.nodes.filter((n) => !had.has(n.id));
    return { leaves: fresh.filter((n) => n.level === 0).length, branches: fresh.filter((n) => n.level > 0).length };
  };
  const names = (n: number) => Array.from({ length: n }, (_, i) => entry(`file-${String(i * 2).padStart(6, "0")}.txt`, i));

  it("adding one entry to a 20,000-entry directory rewrites at most two leaves and one branch per level", () => {
    const before = packEntryTree(names(20_000));
    expect(before.nodes.filter((n) => n.level === 0).length).toBeGreaterThan(50);
    for (const at of [1, 5_000, 10_001, 19_999]) {
      const after = packEntryTree([...names(20_000), entry(`file-${String(at * 2 - 1).padStart(6, "0")}.txt`, 99_999)]);
      const d = newNodes(before, after);
      expect(d.leaves).toBeLessThanOrEqual(2);
      expect(d.branches).toBeLessThanOrEqual(2 * after.rootLevel);
    }
  });

  it("changing one file's CID rewrites one leaf (names, not CIDs, decide boundaries)", () => {
    const before = packEntryTree(names(20_000));
    const edited = names(20_000);
    edited[7_777] = { ...edited[7_777]!, cid: cid(123_456) };
    const d = newNodes(before, packEntryTree(edited));
    expect(d.leaves).toBe(1);
  });

  it("removing one entry rewrites at most two leaves", () => {
    const before = packEntryTree(names(20_000));
    const removed = names(20_000).filter((_, i) => i !== 12_345);
    expect(newNodes(before, packEntryTree(removed)).leaves).toBeLessThanOrEqual(2);
  });

  it("inserting one chunk in the middle of a 20,000-chunk file rewrites at most two leaves", () => {
    const hs = hashes(20_000);
    const before = packChunkTree(hs, sizes(20_000));
    const ins = [...hs.slice(0, 10_000), h(999_999), ...hs.slice(10_000)];
    const insSizes = [...sizes(20_000).slice(0, 10_000), 1234, ...sizes(20_000).slice(10_000)];
    const d = newNodes(before, packChunkTree(ins, insSizes));
    expect(d.leaves).toBeLessThanOrEqual(2);
    expect(d.branches).toBeLessThanOrEqual(4);
  });

  it("for contrast: the old greedy fill would have rewritten every leaf after the edit", () => {
    // Front-to-back leaves of 160: inserting one item at the start shifts every boundary.
    const greedy = (n: number) => Array.from({ length: Math.ceil(n / 160) }, (_, i) => Math.min(160, n - 160 * i));
    expect(greedy(20_001)).not.toEqual(greedy(20_000));
    const before = partitionChunkLeaves(hashes(20_000).map((x) => parseInt(x.slice(2, 10), 16)));
    const after = partitionChunkLeaves([h(999_999), ...hashes(20_000)].map((x) => parseInt(x.slice(2, 10), 16)));
    // Content-defined: after the first leaf, the partitions are identical.
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

describe("file and directory packing together", () => {
  it("packFile / packDirectory return the CIDs of their formulas", () => {
    const f = packFile({ chunkIds: hashes(10), chunkSizes: sizes(10), mimeType: "text/css" });
    expect(f.cid).toBe(fileCid(f.tree.root, "text/css"));
    const d = packDirectory([entry("a.css", 0), entry("sub", 1, true)]);
    expect(d.cid).toBe(directoryCid(d.tree.root));
    // A different mime is a different file CID over the same chunks.
    expect(packFile({ chunkIds: hashes(10), chunkSizes: sizes(10), mimeType: "text/plain" }).cid).not.toBe(f.cid);
    // A different recorded size is a different file.
    expect(packFile({ chunkIds: hashes(10), chunkSizes: sizes(10).map((x) => x + 1), mimeType: "text/css" }).cid).not.toBe(f.cid);
    // A codec is part of the CID.
    const out = keccak256(toBytes("logical"));
    const gz = packFile({ chunkIds: hashes(10), chunkSizes: sizes(10), mimeType: "text/css", codec: codecLabel("gzip"), outputHash: out });
    expect(gz.cid).toBe(fileCid(f.tree.root, "text/css", codecLabel("gzip"), out));
    expect(gz.cid).not.toBe(f.cid);
  });

  it("concatBytes sanity: the SDK's byte helpers are what the packer used", () => {
    expect(Buffer.from(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))).toString("hex")).toBe("010203");
  });
});

describe("canonical packing is frozen, and independent of the gas ESTIMATE model", () => {
  /**
   * These splits decide the CID of every directory over ~4 KB. They come from the content-defined rule and the FROZEN
   * packing cost (`ENTRY_LEAF_PACKING`), not from `NODE_GAS`, which is a tunable estimate. If this test fails, packing
   * changed and so did every large directory's CID: a protocol-level fork of the content-address space.
   */
  const items = (n: number, len: number) =>
    Array.from({ length: n }, (_, i) => {
      const name = new TextEncoder().encode(String(i).padStart(len, "0"));
      return { nameLength: name.length, key: nameKey(name) };
    });
  it("pins the leaf splits for representative directories", () => {
    expect(partitionEntryLeaves(items(300, 9))).toEqual(PINNED_9);
    expect(partitionEntryLeaves(items(1000, 20))).toEqual(PINNED_20);
    expect(partitionEntryLeaves(items(200, 255))).toEqual(PINNED_255);
  });

  it("re-tuning the estimate model does not move a leaf boundary", () => {
    const before = partitionEntryLeaves(items(1000, 10));
    const mutable = NODE_GAS as unknown as Record<string, number>;
    const saved = mutable.nodeBase!;
    mutable.nodeBase = saved * 3;
    try {
      expect(partitionEntryLeaves(items(1000, 10))).toEqual(before);
    } finally {
      mutable.nodeBase = saved;
    }
  });
});

const PINNED_9 = [147, 126, 27];
const PINNED_20 = [112, 179, 116, 138, 267, 118, 70];
const PINNED_255 = [29, 47, 22, 30, 25, 28, 19];
