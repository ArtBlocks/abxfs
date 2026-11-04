/**
 * gzip and deflate through the Compression Streams API.
 *
 * `autoRegisterNodeCodecs` reaches for `node:zlib`, so gzip was unavailable in a browser — and the
 * web gateway registered no codec at all, which meant a gzip file could not be decoded there either.
 * `CompressionStream` is native in browsers and in Node, so one registration serves the client and
 * the server route.
 *
 * The property that actually matters is interoperability: a file gzipped by the CLI (node:zlib)
 * must decode here and vice versa, or the codec label would mean two different things depending on
 * who wrote the file.
 */
import { describe, expect, it } from "vitest";

import { CODEC_DEFLATE, CODEC_GZIP, autoRegisterNodeCodecs, codecLabel, getFileCodec } from "../src/compression.js";
import { flzCompress } from "../src/fastlz.js";
import { hasWebCompression, registerWebCodecs } from "../src/web-codecs.js";

const SAMPLE = new TextEncoder().encode("<h1>abx fs</h1>\n".repeat(400));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("registerWebCodecs", () => {
  it("is available in this runtime", () => {
    expect(hasWebCompression()).toBe(true);
  });

  for (const [name, label] of [
    ["gzip", CODEC_GZIP],
    ["deflate", CODEC_DEFLATE],
  ] as const) {
    it(`round-trips ${name}`, async () => {
      registerWebCodecs();
      const codec = getFileCodec(label);
      const packed = await codec.encode(SAMPLE);
      expect(packed.length).toBeLessThan(SAMPLE.length);
      expect(text(await codec.decode(packed))).toBe(text(SAMPLE));
    });

    /** Both registrations must produce the same wire format, or the codec label is ambiguous. */
    it(`${name} interoperates with the node:zlib registration in both directions`, async () => {
      await autoRegisterNodeCodecs();
      const nodePacked = await getFileCodec(label).encode(SAMPLE);

      registerWebCodecs();
      expect(text(await getFileCodec(label).decode(nodePacked))).toBe(text(SAMPLE));

      const webPacked = await getFileCodec(label).encode(SAMPLE);
      await autoRegisterNodeCodecs();
      expect(text(await getFileCodec(label).decode(webPacked))).toBe(text(SAMPLE));
    });
  }

  it("registers under the canonical labels, not new ones", async () => {
    registerWebCodecs();
    expect(getFileCodec(CODEC_GZIP).label).toBe(codecLabel("gzip"));
    expect(getFileCodec(CODEC_DEFLATE).label).toBe(codecLabel("deflate"));
  });

  it("is idempotent", async () => {
    registerWebCodecs();
    registerWebCodecs();
    const codec = getFileCodec(CODEC_GZIP);
    expect(text(await codec.decode(await codec.encode(SAMPLE)))).toBe(text(SAMPLE));
  });

  it("handles empty input", async () => {
    registerWebCodecs();
    const codec = getFileCodec(CODEC_GZIP);
    const empty = new Uint8Array(0);
    expect((await codec.decode(await codec.encode(empty))).length).toBe(0);
  });

  it("stops decoding at the output cap", async () => {
    registerWebCodecs();
    const codec = getFileCodec(CODEC_GZIP);
    const bomb = await codec.encode(new Uint8Array(1024 * 1024));
    await expect(Promise.resolve(codec.decode(bomb, { maxOutputBytes: 1024 }))).rejects.toThrow(/exceeds 1024 bytes/);
  });

  /**
   * gzip compresses harder than FastLZ, which is the whole reason to offer a file codec — the trade-off being
   * that the chain cannot decode it (and so cannot derive its IPFS CID).
   */
  it("compresses text harder than FastLZ", async () => {
    registerWebCodecs();
    const gz = await getFileCodec(CODEC_GZIP).encode(SAMPLE);
    expect(gz.length).toBeLessThan(flzCompress(SAMPLE).length);
  });
});
