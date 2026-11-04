/**
 * Golden vectors for the protocol-critical code that runs off chain: nothing here may run for the first time in
 * production, and none of it may drift, because each is part of every CID.
 *
 *   - `flzCompress`: the SDK's compressor output is part of every FastLZ chunk id (its input hash). Each vector was
 *     produced by Solady's `LibZip.flzCompress` (the pinned commit) on chain and matched byte for byte when generated.
 *   - `GEAR_TABLE` and FastCDC at the production parameters (minimum 12,287, target 18,431, maximum 24,575): chunk
 *     boundaries are part of every file CID.
 *   - Bytes to file CID, end to end: chunking, the backend chosen per chunk, the compressed input, chunk ids, the node
 *     tree and the CID. Each file was uploaded to the real stores on anvil when generated and the chain agreed. The
 *     backends are the addresses `Deploy.s.sol` pins: every chunk id commits to its backend's address, so a re-pin of
 *     a backend moves these CIDs by design, and they are regenerated with it.
 *
 * `test/fixtures/golden-vectors.json` holds the expected values; inputs come from `helpers/golden-corpus.ts`, and the
 * fixture's input hashes catch a change to a generator before any algorithm is blamed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { concat, keccak256, toHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { flzCompress } from "../../src/fastlz.js";
import { chunkBytes, GEAR_TABLE } from "../../src/chunking/index.js";
import { planFile } from "../../src/plan.js";
import { cdcCorpus, e2eCorpus, flzCorpus } from "../helpers/golden-corpus.js";

interface Fixture {
  backends: { raw: Address; fastLz: Address };
  gearTableKeccak: Hex;
  flz: Array<{ name: string; inputLength: number; inputKeccak: Hex; outputLength: number; outputKeccak: Hex; output?: Hex }>;
  cdc: Array<{ name: string; inputKeccak: Hex; chunks: number[] }>;
  e2e: Array<{
    name: string;
    mimeType: string;
    inputKeccak: Hex;
    cid: Hex;
    root: Hex;
    rootLevel: number;
    chunkCount: number;
    fastLzChunks: number;
    storedSize: number;
    chunkIdsKeccak: Hex;
    inputsKeccak: Hex;
  }>;
}

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/golden-vectors.json"), "utf8")) as Fixture;

describe("flzCompress matches Solady's LibZip.flzCompress byte for byte", () => {
  const corpus = flzCorpus();
  it("covers the whole corpus", () => {
    expect(corpus.map((c) => c.name)).toEqual(FIXTURE.flz.map((v) => v.name));
  });
  for (const v of FIXTURE.flz) {
    it(v.name, () => {
      const input = corpus.find((c) => c.name === v.name)!.bytes;
      expect(input.length).toBe(v.inputLength);
      expect(keccak256(input)).toBe(v.inputKeccak);
      const out = flzCompress(input);
      expect(out.length).toBe(v.outputLength);
      expect(keccak256(out)).toBe(v.outputKeccak);
      if (v.output) expect(toHex(out)).toBe(v.output);
    });
  }
});

describe("chunk boundaries", () => {
  it("GEAR_TABLE is pinned, and frozen", () => {
    expect(GEAR_TABLE.length).toBe(256);
    expect(keccak256(concat(GEAR_TABLE.map((v) => toHex(v, { size: 4 }))))).toBe(FIXTURE.gearTableKeccak);
    expect(Object.isFrozen(GEAR_TABLE)).toBe(true);
    expect(() => {
      (GEAR_TABLE as number[])[0] = 0;
    }).toThrow(TypeError);
    // Still pinned after the attempt: nothing a caller does can move a boundary.
    expect(keccak256(concat(GEAR_TABLE.map((v) => toHex(v, { size: 4 }))))).toBe(FIXTURE.gearTableKeccak);
  });

  const corpus = cdcCorpus();
  for (const v of FIXTURE.cdc) {
    it(`FastCDC at the production parameters: ${v.name}`, () => {
      const input = corpus.find((c) => c.name === v.name)!.bytes;
      expect(keccak256(input)).toBe(v.inputKeccak);
      const lengths = chunkBytes(input, { backendMax: 24_575 }).map((c) => c.length);
      expect(lengths).toEqual(v.chunks);
      // The bounds the spec states: no chunk over 24,575, and none but the last under 12,288.
      for (const n of lengths.slice(0, -1)) {
        expect(n).toBeGreaterThanOrEqual(12_288);
        expect(n).toBeLessThanOrEqual(24_575);
      }
    });
  }
  it("the cut includes the matching byte: the shortest a non-final chunk can be here is 12,289", () => {
    expect(FIXTURE.cdc.find((v) => v.name === "shortest-cut")!.chunks[0]).toBe(12_289);
    expect(FIXTURE.cdc.find((v) => v.name === "random-12287")!.chunks).toEqual([12_287]);
  });
});

describe("bytes to file CID, end to end", () => {
  const backends = FIXTURE.backends;
  const corpus = e2eCorpus();
  for (const v of FIXTURE.e2e) {
    it(v.name, async () => {
      const f = corpus.find((c) => c.name === v.name)!;
      expect(keccak256(f.bytes)).toBe(v.inputKeccak);
      const p = await planFile({ backends, bytes: f.bytes, mimeType: f.mimeType, path: f.name });
      expect(p.chunks.length).toBe(v.chunkCount);
      expect(p.chunks.filter((c) => c.backend === backends.fastLz).length).toBe(v.fastLzChunks);
      expect(keccak256(concat(p.chunks.map((c) => keccak256(c.input))))).toBe(v.inputsKeccak);
      expect(keccak256(concat(p.chunkIds))).toBe(v.chunkIdsKeccak);
      expect(p.storedSize).toBe(v.storedSize);
      expect(p.tree.root).toBe(v.root);
      expect(p.tree.rootLevel).toBe(v.rootLevel);
      expect(p.cid).toBe(v.cid);
    }, 120_000);
  }
  it("one file is past a single leaf (more than 512 chunks), so a branch is in its CID", () => {
    expect(FIXTURE.e2e.some((v) => v.chunkCount > 512 && v.rootLevel >= 1)).toBe(true);
    expect(FIXTURE.e2e.some((v) => v.fastLzChunks > 0 && v.fastLzChunks < v.chunkCount)).toBe(true);
  });
});
