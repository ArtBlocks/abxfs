import { describe, expect, it } from "vitest";

import {
  autoRegisterNodeCodecs,
  CODEC_BROTLI,
  CODEC_DEFLATE,
  CODEC_GZIP,
  CODEC_NONE,
  CODEC_ZSTD,
  codecLabel,
  codecName,
  getFileCodec,
  hasFileCodec,
  isNoCodec,
  registerFileCodec,
} from "../src/compression.js";

describe("file codec labels", () => {
  it("encodes a token as a left-aligned, zero-padded bytes32 and decodes it back", () => {
    expect(codecLabel("gzip")).toBe("0x677a697000000000000000000000000000000000000000000000000000000000");
    for (const t of ["gzip", "br", "zstd", "deflate", "x-custom.v1", "a".repeat(32)]) {
      expect(codecName(codecLabel(t))).toBe(t);
    }
    expect(CODEC_GZIP).toBe(codecLabel("gzip"));
    expect(CODEC_BROTLI).toBe(codecLabel("br"));
    expect(CODEC_ZSTD).toBe(codecLabel("zstd"));
    expect(CODEC_DEFLATE).toBe(codecLabel("deflate"));
  });

  it("zero is no codec", () => {
    expect(codecName(CODEC_NONE)).toBeNull();
    expect(isNoCodec(CODEC_NONE)).toBe(true);
    expect(isNoCodec(CODEC_GZIP)).toBe(false);
  });

  it("refuses tokens that are not short lowercase ASCII", () => {
    for (const bad of ["", "GZIP", "gz ip", "é", "a".repeat(33), "-leading", "x/y"]) {
      expect(() => codecLabel(bad), bad).toThrow(/lowercase ASCII/);
    }
  });

  it("refuses labels that hold no readable token", () => {
    // a byte after the zero padding
    expect(() => codecName(("0x677a6970" + "00".repeat(27) + "01") as `0x${string}`)).toThrow(/zero-padded/);
    // uppercase / non-ASCII bytes
    expect(() => codecName(("0x475a4950" + "00".repeat(28)) as `0x${string}`)).toThrow(/lowercase ASCII/);
    expect(() => codecName(("0xff" + "00".repeat(31)) as `0x${string}`)).toThrow(/lowercase ASCII/);
    // not a bytes32
    expect(() => codecName("0x1234")).toThrow(/bytes32/);
  });
});

describe("file codec registry", () => {
  it("refuses the zero label and a label nothing registered", () => {
    expect(() => getFileCodec(CODEC_NONE)).toThrow(/zero label/);
    expect(() => getFileCodec(codecLabel("never-registered"))).toThrow(/no decoder registered for file codec "never-registered"/);
  });

  it("registerFileCodec + getFileCodec roundtrip", () => {
    const label = codecLabel("x-identity");
    registerFileCodec({ label, name: "x-identity", encode: (b) => b, decode: (b) => b });
    expect(hasFileCodec(label)).toBe(true);
    expect(getFileCodec(label).name).toBe("x-identity");
  });
});

describe("autoRegisterNodeCodecs (Node)", () => {
  it("registers gzip, br and deflate", async () => {
    await autoRegisterNodeCodecs();
    expect(hasFileCodec(CODEC_GZIP)).toBe(true);
    expect(hasFileCodec(CODEC_BROTLI)).toBe(true);
    expect(hasFileCodec(CODEC_DEFLATE)).toBe(true);
  });

  for (const [name, label] of [
    ["gzip", CODEC_GZIP],
    ["br", CODEC_BROTLI],
    ["deflate", CODEC_DEFLATE],
  ] as const) {
    it(`${name} roundtrips`, async () => {
      await autoRegisterNodeCodecs();
      const c = getFileCodec(label);
      const input = new TextEncoder().encode("hello world".repeat(100));
      const encoded = await c.encode(input);
      expect(encoded).not.toEqual(input);
      expect(new Uint8Array(await c.decode(encoded))).toEqual(input);
    });
  }

  it("decoding stops at the output cap", async () => {
    await autoRegisterNodeCodecs();
    const c = getFileCodec(CODEC_GZIP);
    const encoded = await c.encode(new Uint8Array(1024 * 1024));
    await expect(Promise.resolve(c.decode(encoded, { maxOutputBytes: 1024 }))).rejects.toThrow();
  });
});
