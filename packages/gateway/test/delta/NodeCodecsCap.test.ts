/**
 * DELTA AUDIT: `registerNodeCodecs`'s decoder wrapper (`codecs.ts`), the branch nothing exercised. It caps whatever
 * the caller asks for at the registered cap, and when the caller asks for nothing, the cap is the limit; a caller that
 * asks for LESS still gets less. Its own file: the codec registry is process-wide.
 */
import { brotliCompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { CODEC_BROTLI, getFileCodec } from "@artblocks/abxfs-sdk";

import { registerNodeCodecs } from "../../src/codecs.js";

beforeAll(async () => {
  await registerNodeCodecs({ maxOutputBytes: 4096 });
});

const br = (n: number) => new Uint8Array(brotliCompressSync(Buffer.alloc(n, 0x61)));

describe("the capped decoder", () => {
  it("with no options, the registered cap is the limit", async () => {
    const codec = getFileCodec(CODEC_BROTLI);
    expect(new TextDecoder().decode(await codec.decode(br(4096)))).toBe("a".repeat(4096));
    await expect(Promise.resolve(codec.decode(br(4097)))).rejects.toThrow(/larger than 4096/);
  });

  it("options without a limit fall back to the cap too", async () => {
    await expect(Promise.resolve(getFileCodec(CODEC_BROTLI).decode(br(10_000), {}))).rejects.toThrow(/larger than 4096/);
  });

  it("a caller asking for less than the cap gets less; asking for more still gets the cap", async () => {
    const codec = getFileCodec(CODEC_BROTLI);
    await expect(Promise.resolve(codec.decode(br(200), { maxOutputBytes: 100 }))).rejects.toThrow(/larger than 100/);
    await expect(Promise.resolve(codec.decode(br(5_000), { maxOutputBytes: 1_000_000 }))).rejects.toThrow(/larger than 4096/);
  });
});
