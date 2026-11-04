/**
 * The planner's per-chunk backend choice, and planning of empty content. Pure: no chain.
 *
 * A chunk goes to the FastLZ backend only when FastLZ makes its input SMALLER, and to the raw backend otherwise; a file
 * with a file codec sends every chunk raw (its data is already compressed, and the codec, not the chain, decodes it).
 * The choice is part of the chunk id (backend and input hash are in the preimage), so getting it wrong is not a
 * storage inefficiency: it is a different CID from every other client's for the same bytes.
 */
import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";

import { EMPTY_DIRECTORY, fileCid } from "../src/nodes.js";
import { ZERO_HASH, chunkId, ipfsDirectoryCid, ipfsFileCid } from "../src/cid.js";
import { CODEC_GZIP, CODEC_NONE, autoRegisterNodeCodecs, codecLabel, registerFileCodec } from "../src/compression.js";
import { flzCompress } from "../src/fastlz.js";
import { planChunk, planDirectoryTree, planFile, planUploadOffline, type PlanBackends } from "../src/plan.js";
import { fromHex } from "../src/util.js";

await autoRegisterNodeCodecs();

const BACKENDS: PlanBackends = {
  raw: "0x00000000000000000000000000000000000000Aa",
  fastLz: "0x00000000000000000000000000000000000000Bb",
};

const text = (s: string) => new TextEncoder().encode(s);

/** Bytes FastLZ cannot shrink (a keccak stream). */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let h = keccak256(toBytes("noise"));
  for (let o = 0; o < n; o += 32) {
    out.set(fromHex(h).slice(0, Math.min(32, n - o)), o);
    h = keccak256(h);
  }
  return out;
}

/** A codec that does nothing: its "encoded" data is as compressible as the content, so only the rule keeps it raw. */
const IDENTITY = codecLabel("x-identity-test");
registerFileCodec({ label: IDENTITY, name: "x-identity-test", encode: (b) => b, decode: (b) => b });

describe("per-chunk backend choice", () => {
  it("FastLZ when it shrinks the chunk: input is the FastLZ output, the id commits to backend, input and data", () => {
    const data = text("abcabcabc ".repeat(500));
    const c = planChunk(data, BACKENDS);
    expect(c.backend).toBe(BACKENDS.fastLz);
    expect(c.input).toEqual(flzCompress(data));
    expect(c.input.length).toBeLessThan(data.length);
    expect(c.size).toBe(data.length);
    expect(c.dataHash).toBe(keccak256(data));
    expect(c.inputHash).toBe(keccak256(c.input));
    expect(c.id).toBe(chunkId(BACKENDS.fastLz!, c.inputHash, c.dataHash, data.length));
  });

  it("raw when FastLZ does not shrink it: the input is the data, and its hash is both hashes", () => {
    const data = noise(4000);
    expect(flzCompress(data).length).toBeGreaterThanOrEqual(data.length);
    const c = planChunk(data, BACKENDS);
    expect(c.backend).toBe(BACKENDS.raw);
    expect(c.input).toBe(data);
    expect(c.inputHash).toBe(c.dataHash);
    expect(c.id).toBe(chunkId(BACKENDS.raw, c.dataHash, c.dataHash, data.length));
  });

  it("raw for a chunk FastLZ grows (a single byte)", () => {
    const one = new Uint8Array([7]);
    expect(flzCompress(one).length).toBeGreaterThan(1);
    expect(planChunk(one, BACKENDS).backend).toBe(BACKENDS.raw);
  });

  it("raw when FastLZ is switched off, or when the address book has no FastLZ backend", () => {
    const data = text("abcabcabc ".repeat(500));
    expect(planChunk(data, BACKENDS, { fastLz: false }).backend).toBe(BACKENDS.raw);
    expect(planChunk(data, { raw: BACKENDS.raw }).backend).toBe(BACKENDS.raw);
  });

  it("refuses an empty chunk and an input past the backend's cap", () => {
    expect(() => planChunk(new Uint8Array(0), BACKENDS)).toThrow(/at least one byte/);
    expect(() => planChunk(noise(100), { ...BACKENDS, maxInputSize: 50 })).toThrow(/exceeds the backend's 50/);
  });

  it("a file mixes backends chunk by chunk", async () => {
    const bytes = new Uint8Array([...noise(40_000), ...text("compress me ".repeat(5000))]);
    const p = await planFile({ backends: BACKENDS, bytes, mimeType: "application/octet-stream" });
    const used = new Set(p.chunks.map((c) => c.backend));
    expect(used).toEqual(new Set([BACKENDS.raw, BACKENDS.fastLz]));
    // Each chunk's choice is the rule applied to that chunk alone: a raw chunk's input is its data, and FastLZ does not
    // shrink it; a FastLZ chunk's input is smaller than its data.
    for (const c of p.chunks) {
      if (c.backend === BACKENDS.raw) expect(planChunk(c.input, BACKENDS).backend).toBe(BACKENDS.raw);
      else expect(c.input.length).toBeLessThan(c.size);
    }
  });

  it("never FastLZ under a file codec, even when the codec's output would compress", async () => {
    const bytes = text("very compressible ".repeat(4000));
    const viaCodec = await planFile({ backends: BACKENDS, bytes, mimeType: "text/plain", codec: IDENTITY });
    expect(viaCodec.chunks.length).toBeGreaterThan(1);
    for (const c of viaCodec.chunks) {
      expect(c.backend).toBe(BACKENDS.raw);
      expect(c.input.length).toBe(c.size);
    }
    expect(viaCodec.outputHash).toBe(keccak256(bytes));
    // The same bytes with no codec do go through FastLZ, so it was the codec that kept them raw.
    const noCodec = await planFile({ backends: BACKENDS, bytes, mimeType: "text/plain" });
    expect(noCodec.chunks.every((c) => c.backend === BACKENDS.fastLz)).toBe(true);
    // And through gzip, a real codec.
    const gz = await planFile({ backends: BACKENDS, bytes, mimeType: "text/plain", codec: CODEC_GZIP });
    expect(gz.chunks.every((c) => c.backend === BACKENDS.raw)).toBe(true);
  });
});

describe("empty content", () => {
  it("the empty file has no chunks, root zero and no codec, whatever codec was asked for", async () => {
    for (const codec of [undefined, CODEC_GZIP]) {
      const p = await planFile({ backends: BACKENDS, bytes: new Uint8Array(0), mimeType: "text/plain", ...(codec ? { codec } : {}) });
      expect(p.chunks).toEqual([]);
      expect(p.tree.root).toBe(ZERO_HASH);
      expect(p.tree.nodes).toEqual([]);
      expect(p.codec).toBe(CODEC_NONE);
      expect(p.outputHash).toBe(ZERO_HASH);
      expect(p.cid).toBe(fileCid(ZERO_HASH, "text/plain"));
      expect(p.storedSize).toBe(0);
    }
  });

  it("the empty file's IPFS CID is the spec's vector", async () => {
    expect(await ipfsFileCid(new Uint8Array(0))).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("the empty directory's IPFS CID is the spec's vector (block 0a020801)", async () => {
    const { cid, encoded } = await ipfsDirectoryCid([]);
    expect(cid).toBe("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
    expect(Buffer.from(encoded).toString("hex")).toBe("0a020801");
  });

  it("an upload of an empty file and an empty directory plans both, with no node for either", async () => {
    const plan = await planUploadOffline([{ path: ".nojekyll", bytes: new Uint8Array(0), mimeType: "text/plain" }], {
      backends: BACKENDS,
      emptyDirectories: ["assets"],
      ipfsCids: true,
    });
    expect(plan.files[0]!.cid).toBe(fileCid(ZERO_HASH, "text/plain"));
    expect(plan.directories.find((d) => d.path === "assets")!.cid).toBe(EMPTY_DIRECTORY);
    expect(plan.uniqueChunks).toBe(0);
    expect(plan.storedBytes).toBe(0);
    expect(plan.ipfsCids![".nojekyll"]).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(plan.rootCid).toBe(
      planDirectoryTree([{ path: ".nojekyll", cid: fileCid(ZERO_HASH, "text/plain") }], { emptyDirectories: ["assets"] }).rootCid,
    );
  });
});
