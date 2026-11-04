/**
 * Audit 8: canonical packing (content-defined boundaries) against an INDEPENDENT, spec-literal reimplementation.
 *
 * The reference below is written from `specs/abx-fs.md` §5 and the Solidity restatement in
 * `contracts-core/test/GoldenVectors.t.sol`, using only BigInt arithmetic and its own byte encoders (no SDK u16 /
 * u32 / u48, no `Math.floor`, no `parseInt`). The SDK's node ids must equal it byte for byte, in particular where the
 * golden vectors never reach: content-defined BRANCH boundaries, the trailing-one-child rule (merge and 127 + 2),
 * multi-level trees, entry leaves forced by the 24,575-byte limit and by the frozen 7M packing cost, and cumulative
 * bytes above 2^32 (the u48 field), and chunk records carrying u48 sizes.
 */
import { keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { assertTreeLevels, packChunkTree, packEntryTree, packFile } from "../../src/nodes.js";
import { PlanTooLargeError } from "../../src/gas.js";
import { branchGroupSizes, hashKey, partitionEntryLeaves } from "../../src/node-gas.js";

// ---- deterministic randomness -------------------------------------------------------------------------------
let seed = 0x8badf00dn;
function rnd(): number {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return Number(seed >> 33n) / 2 ** 31;
}
function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

// ---- the reference --------------------------------------------------------------------------------------------
const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}` as Hex;
const be = (v: bigint, bytes: number): string => v.toString(16).padStart(bytes * 2, "0");
const refKey = (h: string): bigint => BigInt(`0x${h.slice(2, 66)}`) >> 224n;
const id = (prefix: number, blobHex: string): Hex => keccak256(`0x${be(BigInt(prefix), 1)}${blobHex}` as Hex);

function refGroups(keys: bigint[]): number[] {
  const sizes: number[] = [];
  let cur = 0;
  for (const k of keys) {
    cur++;
    if (cur === 128 || (cur >= 2 && k < (1n << 32n) / 32n)) {
      sizes.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) sizes.push(cur);
  const n = sizes.length;
  if (n > 1 && sizes[n - 1] === 1) {
    if (sizes[n - 2]! < 128) {
      sizes[n - 2]! += 1;
      sizes.pop();
    } else {
      sizes[n - 2] = 127;
      sizes[n - 1] = 2;
    }
  }
  return sizes;
}

interface RefNode {
  id: Hex;
  count: bigint;
  bytes: bigint;
}

function refStack(prefix: number, leaves: RefNode[], isFile: boolean): { root: Hex; levels: number } {
  let cur = leaves;
  let level = 0;
  while (cur.length > 1) {
    level++;
    const next: RefNode[] = [];
    let at = 0;
    for (const g of refGroups(cur.map((n) => refKey(n.id)))) {
      let blob = be(BigInt(level), 1) + be(BigInt(g), 2);
      let run = 0n;
      let runBytes = 0n;
      for (let k = 0; k < g; k++) {
        const c = cur[at + k]!;
        run += c.count;
        runBytes += c.bytes;
        blob += c.id.slice(2) + be(run, 4) + (isFile ? be(runBytes, 6) : "");
      }
      next.push({ id: id(prefix, blob), count: run, bytes: isFile ? runBytes : 0n });
      at += g;
    }
    cur = next;
  }
  return { root: cur[0]!.id, levels: level };
}

function refFile(hashes: Hex[], sizes: number[]): { root: Hex; levels: number; leaves: number } {
  const leaves: RefNode[] = [];
  let start = 0;
  for (let i = 0; i < hashes.length; i++) {
    const cur = i + 1 - start;
    const last = i + 1 === hashes.length;
    if (cur === 512 || (cur >= 32 && refKey(hashes[i]!) < (1n << 32n) / 128n) || last) {
      let blob = "00";
      let bytes = 0n;
      for (let k = start; k <= i; k++) {
        blob += hashes[k]!.slice(2).toLowerCase() + be(BigInt(sizes[k]!), 6);
        bytes += BigInt(sizes[k]!);
      }
      leaves.push({ id: id(0x41, blob), count: BigInt(i + 1 - start), bytes });
      start = i + 1;
    }
  }
  return { ...refStack(0x41, leaves, true), leaves: leaves.length };
}

const utf8 = new TextEncoder();
function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
function refDir(entries: Array<{ name: string; cid: Hex; isDirectory: boolean }>): { root: Hex; leafCounts: number[] } {
  const es = entries.map((e) => ({ ...e, nb: utf8.encode(e.name) })).sort((a, b) => cmp(a.nb, b.nb));
  const cost = (count: bigint, nameBytes: bigint) => {
    const blob = 3n + 36n * count + nameBytes;
    return { blob, cost: 75_000n + 205n * blob + 11_000n * count + 170n * nameBytes };
  };
  const leafBlob = (from: number, to: number) => {
    let offs = "";
    let recs = "";
    for (let i = from; i < to; i++) {
      offs += be(BigInt(recs.length / 2), 2);
      recs += be(BigInt(es[i]!.nb.length), 1) + Buffer.from(es[i]!.nb).toString("hex") + (es[i]!.isDirectory ? "01" : "00") + es[i]!.cid.slice(2);
    }
    return "00" + be(BigInt(to - from), 2) + offs + recs;
  };
  const leaves: RefNode[] = [];
  const leafCounts: number[] = [];
  const emit = (from: number, to: number) => {
    leaves.push({ id: id(0x42, leafBlob(from, to)), count: BigInt(to - from), bytes: 0n });
    leafCounts.push(to - from);
  };
  let start = 0;
  let nameBytes = 0n;
  for (let i = 0; i < es.length; i++) {
    const len = BigInt(es[i]!.nb.length);
    const w = cost(BigInt(i + 1 - start), nameBytes + len);
    if (i > start && (w.blob > 24_575n || w.cost > 7_000_000n)) {
      emit(start, i);
      start = i;
      nameBytes = 0n;
    }
    nameBytes += len;
    const { blob } = cost(BigInt(i + 1 - start), nameBytes);
    const recordBytes = 2n + 1n + len + 1n + 32n;
    if (blob >= 4096n && refKey(keccak256(es[i]!.nb)) < (recordBytes << 32n) / 4096n) {
      emit(start, i + 1);
      start = i + 1;
      nameBytes = 0n;
    }
  }
  if (start < es.length) emit(start, es.length);
  return { root: refStack(0x42, leaves, false).root, leafCounts };
}

// ---- generators -----------------------------------------------------------------------------------------------
/** A chunk hash whose boundary key is forced low (always a boundary once allowed) or high (never one). */
function chunkHashWith(kind: "low" | "high" | "any"): Hex {
  const b = randBytes(32);
  if (kind === "low") b[0] = 0;
  if (kind === "high") b[0] = 0xff;
  return hex(b);
}
function nameWithKey(prefix: string, i: number, wantHigh: boolean): string {
  for (let salt = 0; ; salt++) {
    const n = `${prefix}${i}.${salt}`;
    const k = refKey(keccak256(utf8.encode(n)));
    if (!wantHigh || k >= 1n << 29n) return n; // >= 2^29 is above every entry threshold (max 291 * 2^20)
  }
}

describe("audit8 canonical packing vs an independent BigInt reference", () => {
  it("P1 the entry threshold: Math.floor(r * 2^32 / 4096) equals (r << 32) / 4096 for every legal record size", () => {
    for (let r = 37; r <= 2 + 1 + 255 + 1 + 32; r++) {
      expect(BigInt(Math.floor((r * 2 ** 32) / 4096))).toBe((BigInt(r) << 32n) / 4096n);
    }
  });

  it("P2 hashKey equals the top 32 bits for edge and random hashes, either hex case", () => {
    const edges = ["ff".repeat(32), "80" + "00".repeat(31), "7fffffff" + "ff".repeat(28), "00".repeat(32), "0000000" + "1" + "ab".repeat(28)];
    for (let i = 0; i < 2000; i++) edges.push(Buffer.from(randBytes(32)).toString("hex"));
    for (const e of edges) {
      expect(BigInt(hashKey(`0x${e}`))).toBe(refKey(`0x${e}`));
      expect(BigInt(hashKey(`0x${e.toUpperCase()}`))).toBe(refKey(`0x${e}`));
    }
  });

  it("P3 branchGroupSizes equals the reference, including 128-forced-then-one and boundary-before-last", () => {
    const LOW = 0;
    const HIGH = 2 ** 32 - 1;
    const cases: number[][] = [
      [HIGH, HIGH], // two children, no boundary
      Array(129).fill(HIGH), // forced 128, then one -> 127 + 2
      Array(257).fill(HIGH), // 128, 128, 1 -> 128, 127, 2
      [HIGH, LOW, HIGH], // natural boundary right before the last child -> one group of 3
      [HIGH, LOW, HIGH, LOW, HIGH], // 2, 2, 1 -> 2, 3
      [...Array(127).fill(HIGH), LOW, HIGH], // a natural boundary AT 128 then one -> 127 + 2
      Array(7).fill(LOW), // 2, 2, 2, 1 -> 2, 2, 3
    ];
    for (let t = 0; t < 3000; t++) {
      const n = 2 + Math.floor(rnd() * 600);
      const pLow = [0.01, 0.03, 0.2, 0.9][t % 4]!;
      cases.push(Array.from({ length: n }, () => (rnd() < pLow ? Math.floor(rnd() * 2 ** 27) : 2 ** 27 + Math.floor(rnd() * (2 ** 32 - 2 ** 27)))));
    }
    for (const keys of cases) {
      const got = branchGroupSizes(keys);
      expect(got).toEqual(refGroups(keys.map(BigInt)));
      expect(got.reduce((a, b) => a + b, 0)).toBe(keys.length);
      for (const g of got) {
        expect(g).toBeGreaterThanOrEqual(2);
        expect(g).toBeLessThanOrEqual(128);
      }
    }
    expect(branchGroupSizes(Array(129).fill(HIGH))).toEqual([127, 2]);
  });

  it("P4 file trees equal the reference: min/max leaves, many leaves (content-defined branches, trailing rule), two levels", () => {
    const shapes: Array<{ n: number; kind: "low" | "high" | "any" }> = [
      ...[1, 2, 31, 32, 33, 160, 511, 512, 513, 1100, 5000].map((n) => ({ n, kind: "any" as const })),
      ...[512 * 129, 512 * 128 + 1].map((n) => ({ n, kind: "high" as const })), // 129 full leaves: 127 + 2 if no natural cut
    ];
    // Leaves of exactly 32 chunks: k leaves for many k, so the branch level sees every trailing shape.
    for (let k = 2; k <= 300; k += 7) shapes.push({ n: 32 * k + (k % 3 === 0 ? 1 : 0), kind: "low" });
    // Enough 32-chunk leaves (avg branch 34) to need two branch levels.
    shapes.push({ n: 32 * 2500, kind: "low" });
    let sawTwoLevels = false;
    for (const { n, kind } of shapes) {
      const hashes = Array.from({ length: n }, () => chunkHashWith(kind));
      const sizes = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 24_575));
      const t = packChunkTree(hashes, sizes);
      const ref = refFile(hashes, sizes);
      expect(t.root, `n=${n} ${kind}`).toBe(ref.root);
      expect(t.rootLevel).toBe(ref.levels);
      if (ref.levels >= 2) sawTwoLevels = true;
    }
    expect(sawTwoLevels).toBe(true);
  });

  it("P5 cumulative bytes above 2^32 (u48) match the reference, and so does the CID", () => {
    const n = 70_000; // 70,000 x 65,535 = 4.59e9 bytes > 2^32
    const hashes = Array.from({ length: n }, () => chunkHashWith("any"));
    const sizes = Array(n).fill(65_535);
    const { tree } = packFile({ chunkIds: hashes, chunkSizes: sizes, mimeType: "video/mp4" });
    expect(tree.root).toBe(refFile(hashes, sizes).root);
    expect(tree.nodes.at(-1)!.size).toBe(n * 65_535);
  });

  it("P5b chunk records carry u48 sizes: sizes past 65,535 (a FastLZ chunk's data) and up to 2^48 - 1 match the reference", () => {
    const hashes = Array.from({ length: 40 }, () => chunkHashWith("any"));
    const sizes = hashes.map((_, i) => (i === 39 ? 2 ** 48 - 1 - 39 * 1_000_000 : 1_000_000));
    const t = packChunkTree(hashes, sizes);
    expect(t.root).toBe(refFile(hashes, sizes).root);
    expect(t.nodes.at(-1)!.size).toBe(2 ** 48 - 1);
  });

  it("P6 directory trees equal the reference: random names, unicode, forced by the byte limit and by the 7M cost cap, any input order", () => {
    const cid = (): Hex => hex(randBytes(32));
    const sets: Array<Array<{ name: string; cid: Hex; isDirectory: boolean }>> = [];
    // Random names of every length class.
    for (const n of [1, 70, 200, 400, 1500, 6000]) {
      sets.push(
        Array.from({ length: n }, (_, i) => {
          const len = 1 + Math.floor(rnd() * 40);
          return { name: `f${i}-${"x".repeat(len)}`, cid: cid(), isDirectory: rnd() < 0.2 };
        }),
      );
    }
    // Short names that can never hit a content boundary: every leaf is ended by the frozen 7M packing cost.
    sets.push(Array.from({ length: 2000 }, (_, i) => ({ name: nameWithKey("s", i, true), cid: cid(), isDirectory: false })));
    // 255-byte names that can never hit a content boundary: every leaf is ended by the 24,575-byte limit.
    sets.push(
      Array.from({ length: 400 }, (_, i) => {
        const base = nameWithKey("L", i, true);
        // pad to 255 bytes, then re-grind the suffix so the padded name's key stays high
        let name = base.padEnd(255, "z");
        for (let s = 0; refKey(keccak256(utf8.encode(name))) < 1n << 29n; s++) name = `${base}.${s}`.padEnd(255, "z");
        return { name, cid: cid(), isDirectory: false };
      }),
    );
    // Unicode (byte order differs from UTF-16 order) and a mixture of 1..255-byte names.
    sets.push(
      Array.from({ length: 900 }, (_, i) => ({
        name: `${["Ａ", "😀", "é", "日本", "a", "Z"][i % 6]}${i}${"é".repeat(Math.floor(rnd() * 100))}`,
        cid: cid(),
        isDirectory: i % 2 === 0,
      })),
    );
    for (const es of sets) {
      const ref = refDir(es);
      const t = packEntryTree(es as never);
      expect(t.root).toBe(ref.root);
      // Order independence: a shuffled input packs to the same root.
      const shuffled = [...es].sort(() => rnd() - 0.5);
      expect(packEntryTree(shuffled as never).root).toBe(ref.root);
    }
    // The forced shapes did happen.
    const capSet = refDir(sets[6]!).leafCounts;
    expect(capSet.length).toBeGreaterThan(3);
    const longSet = refDir(sets[7]!).leafCounts;
    expect(Math.max(...longSet)).toBeLessThanOrEqual(84);
    expect(
      partitionEntryLeaves(sets[6]!.map((e) => ({ nameLength: utf8.encode(e.name).length, key: hashKey(keccak256(utf8.encode(e.name))) }))).length,
    ).toBeGreaterThan(0);
  });

  it("P7 the level cap: 128^3 leaves pass the precheck, one more is refused; no 4-level tree is produced", () => {
    expect(() => assertTreeLevels(128 ** 3, "file", "f", 0)).not.toThrow();
    expect(() => assertTreeLevels(128 ** 3 + 1, "file", "f", 0)).toThrow(PlanTooLargeError);
  });

  it("P8 NOTE: packFile accepts any chunk size up to 2^48 - 1, past the backend's 24,575-byte INPUT cap", () => {
    const h = chunkHashWith("any");
    // A recorded size is the chunk's DATA size, which for a FastLZ chunk exceeds its stored input. The chain checks
    // every size against the chunk's record (`ChunkSizeMismatch`), so a wrong size cannot be created, only computed;
    // internal callers take sizes from the planned chunk.
    expect(() => packFile({ chunkIds: [h], chunkSizes: [30_000], mimeType: "x/y" })).not.toThrow();
    expect(() => packFile({ chunkIds: [h], chunkSizes: [2 ** 48], mimeType: "x/y" })).toThrow(/2\^48 - 1/);
  });
});
