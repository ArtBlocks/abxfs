import { describe, expect, it } from "vitest";

import { flzCompress, flzDecompress } from "../src/fastlz.js";

function roundTrips(bytes: Uint8Array): void {
  const compressed = flzCompress(bytes);
  const back = flzDecompress(compressed);
  expect(Array.from(back)).toEqual(Array.from(bytes));
}

/** Deterministic pseudo-random bytes (incompressible) via an LCG. */
function pseudoRandom(len: number, seed = 0x12345678): Uint8Array {
  let state = seed >>> 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

describe("fastlz round-trip", () => {
  it("empty input", () => roundTrips(new Uint8Array(0)));

  it("tiny inputs (< 13 bytes, all-literal path)", () => {
    for (let n = 1; n <= 13; n++) {
      roundTrips(new Uint8Array(n).fill(0x41));
    }
  });

  it("highly compressible (long repeats / overlapping matches)", () => {
    roundTrips(new TextEncoder().encode("a".repeat(5000)));
    roundTrips(new TextEncoder().encode("abcabcabc".repeat(2000)));
  });

  it("typical text", () => {
    const text =
      "the quick brown fox jumps over the lazy dog. ".repeat(300) +
      "ABX FS pre-compresses off-chain and inflates on-chain.";
    roundTrips(new TextEncoder().encode(text));
  });

  it("incompressible (pseudo-random) of various sizes", () => {
    for (const n of [1, 31, 32, 33, 64, 1000, 60_000]) {
      roundTrips(pseudoRandom(n, 0xabcdef01 ^ n));
    }
  });

  it("realistic JSON-ish payload", () => {
    const obj = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      tags: ["alpha", "beta", "gamma"],
      active: i % 2 === 0,
    }));
    roundTrips(new TextEncoder().encode(JSON.stringify(obj)));
  });
});

/**
 * FastLZ is not a file codec: it is the FastLZ storage backend's, per chunk, and the chain inflates it. The planner sends
 * a chunk through it only when the output is smaller, so whether it shrinks or grows a payload decides chunk ids.
 */
describe("fastlz as the per-chunk compressor", () => {
  it("shrinks a repetitive payload and grows an incompressible one", () => {
    const original = new TextEncoder().encode("compress me through the backend".repeat(50));
    expect(flzCompress(original).length).toBeLessThan(original.length);
    const noise = pseudoRandom(4000, 0x5eed);
    expect(flzCompress(noise).length).toBeGreaterThan(noise.length);
  });
});
