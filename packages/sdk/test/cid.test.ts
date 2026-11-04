import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CHUNK_ID_PREFIX,
  MAX_CHUNK_DATA_SIZE,
  chunkId,
  ipfsDirectoryCid,
  ipfsFileCid,
  ipfsRawCid,
  keccak256Hex,
  sortDirectoryEntries,
} from "../src/cid.js";
import { fromHex, toHex } from "../src/util.js";
import { keccak256 } from "viem";
import type { AbxfsCid, IpfsCid } from "../src/types.js";

const FIXTURES_DIR = resolve(__dirname, "../../protobuf-sol/test/fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as T;
}

describe("keccak256Hex", () => {
  it("matches viem keccak256", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(keccak256Hex(bytes)).toBe(keccak256(bytes));
  });
});

describe("chunkId", () => {
  it("matches keccak256(0x30 ‖ backend:20 ‖ inputHash ‖ dataHash ‖ size:6), ChunkStore.chunkId's preimage", () => {
    const backend = "0x00000000000000000000000000000000000000bb" as `0x${string}`;
    const inputHash = keccak256(new TextEncoder().encode("input"));
    const dataHash = keccak256(new TextEncoder().encode("data"));
    const pre = new Uint8Array(1 + 20 + 32 + 32 + 6);
    pre[0] = 0x30;
    pre.set(fromHex(backend), 1);
    pre.set(fromHex(inputHash), 21);
    pre.set(fromHex(dataHash), 53);
    pre.set([0, 0, 0, 0x01, 0x00, 0x02], 85); // 65,538
    expect(chunkId(backend, inputHash, dataHash, 65_538)).toBe(keccak256(pre));
    expect(CHUNK_ID_PREFIX).toBe(0x30);
  });

  it("binds every part: backend, input, data hash and size", () => {
    const h = (s: string) => keccak256(new TextEncoder().encode(s));
    const base = chunkId("0x0000000000000000000000000000000000000001", h("i"), h("d"), 10);
    expect(chunkId("0x0000000000000000000000000000000000000002", h("i"), h("d"), 10)).not.toBe(base);
    expect(chunkId("0x0000000000000000000000000000000000000001", h("j"), h("d"), 10)).not.toBe(base);
    expect(chunkId("0x0000000000000000000000000000000000000001", h("i"), h("e"), 10)).not.toBe(base);
    expect(chunkId("0x0000000000000000000000000000000000000001", h("i"), h("d"), 11)).not.toBe(base);
  });

  it("refuses sizes outside 1 to 2^48 - 1 and malformed parts", () => {
    const z = keccak256(new Uint8Array(0));
    const b = "0x0000000000000000000000000000000000000001" as const;
    expect(() => chunkId(b, z, z, 0)).toThrow(/size/);
    expect(() => chunkId(b, z, z, MAX_CHUNK_DATA_SIZE + 1)).toThrow(/size/);
    expect(chunkId(b, z, z, MAX_CHUNK_DATA_SIZE)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => chunkId("0x01" as never, z, z, 1)).toThrow(/20-byte/);
    expect(() => chunkId(b, "0x01", z, 1)).toThrow(/32 bytes/);
  });
});

describe("sortDirectoryEntries", () => {
  it("sorts entries lexicographically by bytewise name", () => {
    const input = [
      { name: "b", cid: "0x00" as AbxfsCid, isDirectory: false },
      { name: "a", cid: "0x00" as AbxfsCid, isDirectory: false },
      { name: "ab", cid: "0x00" as AbxfsCid, isDirectory: false },
    ];
    const out = sortDirectoryEntries(input).map((e) => e.name);
    expect(out).toEqual(["a", "ab", "b"]);
  });
});

describe("IPFS raw leaves", () => {
  type RawLeaf = { name: string; input_hex: string; cid: string };
  const vectors = loadFixture<RawLeaf[]>("raw-leaves.json");

  for (const v of vectors) {
    it(`ipfsRawCid: ${v.name}`, async () => {
      const bytes = fromHex(v.input_hex);
      expect(await ipfsRawCid(bytes)).toBe(v.cid);
    });
    it(`ipfsFileCid (≤256KB -> raw): ${v.name}`, async () => {
      const bytes = fromHex(v.input_hex);
      expect(await ipfsFileCid(bytes)).toBe(v.cid);
    });
  }
});

describe("IPFS dag-pb directories", () => {
  type DirEntry = { name: string; cid: string; size: number };
  type Dir = { name: string; entries: DirEntry[]; cid: string; pbnode_hex: string };
  const vectors = loadFixture<Dir[]>("dag-pb-nodes.json");

  for (const d of vectors) {
    it(`ipfsDirectoryCid: ${d.name}`, async () => {
      const children = d.entries.map((e) => ({
        name: e.name,
        cid: e.cid as IpfsCid, // fixture strings: the vectors are the authority on their shape
        tsize: e.size,
      }));
      const { cid, encoded } = await ipfsDirectoryCid(children);
      expect(cid).toBe(d.cid);
      expect(toHex(encoded)).toBe(d.pbnode_hex.toLowerCase());
    });
  }
});

describe("IPFS multi-block files", () => {
  type MBFile = { name: string; size: number; input_seed: string; cid: string };
  let vectors: MBFile[] = [];
  try {
    vectors = loadFixture<MBFile[]>("multi-block-files.json");
  } catch {
    // fixture file not present — skip.
  }

  for (const v of vectors) {
    it(`ipfsFileCid: ${v.name}`, async () => {
      const bytes = deterministicBytes(v.size, v.input_seed);
      expect(await ipfsFileCid(bytes)).toBe(v.cid);
    });
  }
});

/** Matches `generate-fixtures.mjs#deterministicBytes`. Seeded LCG with string key. */
function deterministicBytes(len: number, seed: string): Uint8Array {
  const MASK = 0xffffffffn;
  let state = 0n;
  for (let i = 0; i < seed.length; i++) {
    state = (state * 31n + BigInt(seed.charCodeAt(i))) & MASK;
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (state * 1103515245n + 12345n) & MASK;
    out[i] = Number(state & 0xffn);
  }
  return out;
}
