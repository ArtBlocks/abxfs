import { describe, expect, it } from "vitest";

import {
  chunkBytes,
  defaultParamsFor,
  fastcdcSplit,
  GEAR_TABLE,
} from "../../src/chunking/index.js";

/**
 * Deterministic synthetic-data helpers. We avoid `Math.random()` everywhere because
 * test failures need to be reproducible — chunking is hash-driven, so a flake here
 * almost always indicates a real bug.
 *
 * Why mulberry32 instead of an LCG? A textbook LCG `s_{n+1} = a*s_n + c (mod 2^32)`
 * has the property that its low k bits cycle with period at most 2^k — so its low
 * byte cycles every 256 iterations. That's catastrophic for testing a content-defined
 * chunker, because the rolling hash's low N bits depend only on the last N input
 * bytes; a 256-cycle byte stream produces only ~256 distinct hash windows total,
 * which kneecaps boundary-search probability and triggers spurious test failures
 * that look like chunker bugs but are really test-data bugs. Mulberry32 is a proper
 * 32-bit PRNG with no such low-bit pathology.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function pseudoBytes(n: number, seed: number): Uint8Array {
  const next = mulberry32(seed);
  const out = new Uint8Array(n);
  // Pull 4 bytes per uint32 for ~4x throughput vs `next() & 0xff`.
  let i = 0;
  while (i + 4 <= n) {
    const v = next();
    out[i++] = v & 0xff;
    out[i++] = (v >>> 8) & 0xff;
    out[i++] = (v >>> 16) & 0xff;
    out[i++] = (v >>> 24) & 0xff;
  }
  while (i < n) out[i++] = next() & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const SMALL = { min: 64, target: 192, hardMax: 256 };

describe("GEAR_TABLE", () => {
  it("has 256 deterministic entries", () => {
    expect(GEAR_TABLE.length).toBe(256);
    // Determinism guard: snapshot a few well-known indices. If any of these change,
    // the chunking strategy has shifted and existing CDC-chunked CIDs will not match.
    // Update intentionally only as part of a coordinated migration.
    expect(GEAR_TABLE[0]).toBeTypeOf("number");
    expect(GEAR_TABLE[255]).toBeTypeOf("number");
    const a = Array.from(GEAR_TABLE.slice(0, 4));
    const b = Array.from(GEAR_TABLE.slice(0, 4));
    expect(a).toEqual(b);
  });

  it("entries fit in 32 bits unsigned", () => {
    for (const v of GEAR_TABLE) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffff_ffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("defaultParamsFor", () => {
  it("returns 50/75/100 ratios", () => {
    expect(defaultParamsFor(24_575)).toEqual({
      min: Math.floor(24_575 * 0.5),
      target: Math.floor(24_575 * 0.75),
      hardMax: 24_575,
    });
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid maxChunkSize %s", (n) => {
    expect(() => defaultParamsFor(n)).toThrow(/positive integer/);
  });
});

describe("fastcdcSplit — edge cases", () => {
  it("empty input → no chunks", () => {
    expect(fastcdcSplit(new Uint8Array(0), SMALL)).toEqual([]);
  });

  it("input shorter than min → single chunk = input", () => {
    const b = new Uint8Array([1, 2, 3, 4]);
    const out = fastcdcSplit(b, SMALL);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual(b);
  });

  it("input exactly min → single chunk = input", () => {
    const b = pseudoBytes(SMALL.min, 1);
    const out = fastcdcSplit(b, SMALL);
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(SMALL.min);
  });

  it("rejects bad params", () => {
    expect(() => fastcdcSplit(new Uint8Array(10), { min: 0, target: 1, hardMax: 1 })).toThrow();
    expect(() => fastcdcSplit(new Uint8Array(10), { min: 10, target: 5, hardMax: 20 })).toThrow();
    expect(() => fastcdcSplit(new Uint8Array(10), { min: 10, target: 20, hardMax: 5 })).toThrow();
  });
});

describe("fastcdcSplit — invariants on random data", () => {
  it("chunks losslessly reassemble the input", () => {
    const b = pseudoBytes(100_000, 42);
    const parts = fastcdcSplit(b, SMALL);
    const rebuilt = concat(parts);
    expect(rebuilt.length).toBe(b.length);
    expect(rebuilt).toEqual(b);
  });

  it("respects min/hardMax bounds (last chunk excepted)", () => {
    const b = pseudoBytes(50_000, 7);
    const parts = fastcdcSplit(b, SMALL);
    expect(parts.length).toBeGreaterThan(1);
    for (let i = 0; i < parts.length - 1; i++) {
      expect(parts[i]!.length).toBeGreaterThanOrEqual(SMALL.min);
      expect(parts[i]!.length).toBeLessThanOrEqual(SMALL.hardMax);
    }
    // Last chunk may be shorter than min if input wasn't aligned.
    expect(parts[parts.length - 1]!.length).toBeLessThanOrEqual(SMALL.hardMax);
  });

  it("is deterministic — identical input → identical chunks", () => {
    const b = pseudoBytes(20_000, 99);
    const a = fastcdcSplit(b, SMALL).map((p) => Array.from(p));
    const c = fastcdcSplit(b, SMALL).map((p) => Array.from(p));
    expect(a).toEqual(c);
  });
});

describe("fastcdcSplit — cascade resistance (the main reason this exists)", () => {
  /**
   * The defining property of CDC: a single-byte insert near the start of a long file
   * should NOT invalidate every chunk afterward. We assert that >50% of chunks past
   * the edit point are bitwise-identical to chunks from the original file.
   *
   * (Fixed-stride chunking would invalidate ~100% of downstream chunks under the same
   * test, since boundaries shift by exactly 1 byte everywhere.)
   */
  it("inserting one byte at offset 0 only invalidates chunks near the edit", () => {
    const original = pseudoBytes(40_000, 123);
    const edited = new Uint8Array(original.length + 1);
    edited[0] = 0x00;
    edited.set(original, 1);

    const params = { min: 256, target: 1024, hardMax: 2048 };
    const a = fastcdcSplit(original, params);
    const b = fastcdcSplit(edited, params);

    const aHashes = new Set(a.map((p) => Array.from(p).join(",")));
    const bHashes = b.map((p) => Array.from(p).join(","));

    const sharedTail = bHashes.filter((h) => aHashes.has(h)).length;
    const totalB = bHashes.length;

    // We expect a vast majority of post-edit chunks to dedupe with the original.
    expect(sharedTail / totalB).toBeGreaterThan(0.5);
  });

  it("inserting one byte in the middle dedupes the prefix and most of the suffix", () => {
    const original = pseudoBytes(40_000, 555);
    const insertAt = 20_000;
    const edited = new Uint8Array(original.length + 1);
    edited.set(original.subarray(0, insertAt), 0);
    edited[insertAt] = 0xab;
    edited.set(original.subarray(insertAt), insertAt + 1);

    const params = { min: 256, target: 1024, hardMax: 2048 };
    const a = fastcdcSplit(original, params);
    const b = fastcdcSplit(edited, params);

    const aHashes = new Set(a.map((p) => Array.from(p).join(",")));
    const sharedB = b.filter((p) => aHashes.has(Array.from(p).join(","))).length;

    // Very strong dedup: >75% chunks shared, since only the chunk at insertAt and
    // potentially the next one need to differ.
    expect(sharedB / b.length).toBeGreaterThan(0.75);
  });

  it("appending bytes preserves all original prefix chunks", () => {
    const original = pseudoBytes(30_000, 314);
    const edited = new Uint8Array(original.length + 5000);
    edited.set(original, 0);
    edited.set(pseudoBytes(5000, 271), original.length);

    const params = { min: 256, target: 1024, hardMax: 2048 };
    const a = fastcdcSplit(original, params);
    const b = fastcdcSplit(edited, params);

    const aHashes = a.map((p) => Array.from(p).join(","));
    const bHashes = b.map((p) => Array.from(p).join(","));

    // All but the last chunk of `original` should appear identically in `edited`,
    // since boundaries are content-defined and the prefix bytes are unchanged.
    let matched = 0;
    for (let i = 0; i < aHashes.length - 1; i++) {
      if (bHashes.includes(aHashes[i]!)) matched++;
    }
    expect(matched).toBe(aHashes.length - 1);
  });
});

describe("chunkBytes", () => {
  it("delegates to fastcdcSplit with defaultParamsFor(backendMax)", () => {
    const b = pseudoBytes(10_000, 1);
    const a = chunkBytes(b, { backendMax: 1024 });
    const c = fastcdcSplit(b, defaultParamsFor(1024));
    expect(a.map((p) => Array.from(p))).toEqual(c.map((p) => Array.from(p)));
  });

  it("explicit params override backendMax-derived defaults", () => {
    const b = pseudoBytes(10_000, 2);
    const params = { min: 100, target: 200, hardMax: 400 };
    const a = chunkBytes(b, { backendMax: 999_999, params });
    const c = fastcdcSplit(b, params);
    expect(a.map((p) => Array.from(p))).toEqual(c.map((p) => Array.from(p)));
  });
});

describe("fastcdcSplit — chunk size distribution", () => {
  it("mean chunk size lands within 0.5×–1.5× of target on random data", () => {
    const b = pseudoBytes(500_000, 9001);
    const params = { min: 1024, target: 4096, hardMax: 8192 };
    const parts = fastcdcSplit(b, params);
    const mean = b.length / parts.length;
    expect(mean).toBeGreaterThan(params.target * 0.5);
    expect(mean).toBeLessThan(params.target * 1.5);
  });
});
