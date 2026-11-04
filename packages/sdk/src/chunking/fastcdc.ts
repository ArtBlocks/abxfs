/**
 * FastCDC content-defined chunker (Xia et al., USENIX ATC '16) using a Gear hash.
 *
 * WHY: a fixed-size chunker cuts at byte offsets 0, n, 2n, … —
 * which means inserting/deleting a single byte near the start of a file shifts every
 * chunk boundary downstream by that delta, so every chunk after the edit point has
 * different bytes and must be re-written on chain. CDC instead determines boundaries
 * from the file's own content via a rolling hash, so an edit only invalidates the
 * chunk(s) containing the edit; downstream chunks dedupe for free.
 *
 * Gear hash: `h_{i+1} = ((h_i << 1) | 0) ^ G[byte_i]` where `G` is a precomputed table
 * of 256 random 64-bit values. The shift discards old bytes naturally, which makes the
 * algorithm branchless inside the hot loop. We keep the running hash in a JS `number`
 * (64-bit double) and mask to 32 bits because that's faster than `BigInt` and gives a
 * boundary distribution indistinguishable in practice from the 64-bit reference.
 *
 * Normalized chunking: we use two boundary masks (one stricter, one looser) joined at
 * the target size. Inside `[min, target)` we look for the strict boundary (more bits
 * set) so it triggers less often → chunks rarely undershoot target. Inside
 * `[target, hardMax)` we relax to the looser mask so a boundary lands quickly.
 *
 * The contract (`FileStore.createFile`) takes an arbitrary `bytes32[]` of chunk
 * hashes — it does NOT enforce equal-size chunks. So switching to CDC requires no
 * on-chain change. Existing fixed-chunked files keep their CIDs and continue to read
 * fine; only future uploads use this chunker.
 */

import { GEAR } from "./gear-table.js";

export interface FastCDCParams {
  /** Hard minimum chunk size (bytes). Boundary search is skipped while inside `[0, min)`. */
  min: number;
  /** Target chunk size (bytes). Boundary mask switches from strict→loose when crossing this. */
  target: number;
  /** Hard maximum chunk size (bytes). Force-cut here regardless of rolling hash. */
  hardMax: number;
}

/**
 * Default chunking parameters relative to a backend's reported `maxChunkSize()`.
 * Returns `{ min: floor(max * 0.50), target: floor(max * 0.75), hardMax: max }` —
 * see [project-edit-publish plan, Phase 0] for the gas/dedup tradeoff rationale.
 *
 * For a typical SSTORE2-backed `maxChunkSize() = 24_575`:
 *   - min     = 12_287 bytes  (50%)
 *   - target  = 18_431 bytes  (75%)
 *   - hardMax = 24_575 bytes  (100%, contract limit)
 *
 * The 25% headroom between target and hardMax means most chunks have room to grow
 * via in-place inserts before being force-split, while the 50% floor keeps SSTORE2
 * deployment overhead amortized over a non-trivial payload.
 */
export function defaultParamsFor(maxChunkSize: number): FastCDCParams {
  if (!Number.isInteger(maxChunkSize) || maxChunkSize <= 0) {
    throw new Error(`defaultParamsFor: maxChunkSize must be a positive integer, got ${maxChunkSize}`);
  }
  const hardMax = maxChunkSize;
  const target = Math.floor(maxChunkSize * 0.75);
  const min = Math.floor(maxChunkSize * 0.5);
  return { min, target, hardMax };
}

/**
 * Number of low bits required to be zero in the running hash to declare a boundary.
 * Picked so that the geometric mean chunk size matches `targetSize` reasonably well.
 *
 * For a target of `T`:
 *   - strict bits = floor(log2(T)) + 1   (boundary fires every ~2T bytes on average)
 *   - loose  bits = floor(log2(T)) - 1   (boundary fires every ~T/2 bytes on average)
 *
 * Combined with the min/target/hardMax fences, this yields a chunk-size distribution
 * tightly clustered around `target`. Pure FastCDC reference uses fixed 13/11 bits for
 * a 8 KiB target; our `bitsForTarget` generalises that to any target size.
 */
function bitsForTarget(target: number): { strict: number; loose: number } {
  const log2 = Math.floor(Math.log2(Math.max(2, target)));
  return { strict: log2 + 1, loose: Math.max(1, log2 - 1) };
}

/**
 * Split `bytes` into chunks using FastCDC. Returns subarray views (zero-copy).
 *
 * Determinism: identical input bytes ALWAYS produce identical chunk boundaries given
 * identical params. Critical because chunk hashes are content-addressed and any
 * non-determinism would defeat the dedup story.
 *
 * Bounds: every returned chunk satisfies `min < chunk.length <= hardMax` (the cut follows
 * the byte whose hash matched, and hashing starts at offset `min`, so the shortest is
 * `min + 1`), EXCEPT the last chunk, which is whatever remains (at most `min` bytes when
 * the remainder is that short; we don't pad). For inputs of at most `min` bytes, returns a
 * single chunk = the input.
 */
export function fastcdcSplit(bytes: Uint8Array, params: FastCDCParams): Uint8Array[] {
  validateParams(params);
  const { min, target, hardMax } = params;
  const n = bytes.length;

  if (n === 0) return [];
  if (n <= min) return [bytes.subarray(0, n)];

  const { strict, loose } = bitsForTarget(target);
  const strictMask = (1 << strict) - 1;
  const looseMask = (1 << loose) - 1;

  const out: Uint8Array[] = [];
  let pos = 0;

  while (pos < n) {
    const remaining = n - pos;
    if (remaining <= min) {
      out.push(bytes.subarray(pos, n));
      break;
    }

    // Search window starts at `min` (the floor) and ends at `hardMax` (force cut).
    const searchStart = pos + min;
    const targetEnd = Math.min(pos + target, n);
    const hardEnd = Math.min(pos + hardMax, n);

    let h = 0;
    let cut = -1;

    // Phase 1: strict mask. Look for a boundary in `[min, target)`.
    // Hash starts fresh at the chunk's `min` offset (not at `pos`) — the first `min`
    // bytes can't possibly produce a cut anyway, so we save the work. Indexing into
    // `Uint8Array` and `Uint32Array` is statically known to return `number` (not
    // `number | undefined`), so no non-null assertions are needed in the hot loop.
    let i = searchStart;
    for (; i < targetEnd; i++) {
      // Gear: h = ((h << 1) | 0) ^ G[b]. We mask to 32 bits to keep it in the SMI fast path.
      // `bytes[i]!` and `GEAR[byte]!` are sound because (a) the loop bound is
      // `i < hardEnd <= n = bytes.length` and (b) `byte` is in `[0, 256)` while
      // `GEAR.length === 256`. The `!` shaves a `?? 0` from every iteration.
      const byte = bytes[i]!;
      h = (((h << 1) >>> 0) ^ GEAR[byte]!) >>> 0;
      if ((h & strictMask) === 0) {
        cut = i + 1;
        break;
      }
    }

    // Phase 2: loose mask. If no strict boundary was found in `[min, target)`, look in
    // `[target, hardMax)` with the relaxed mask so we cut sooner rather than hitting
    // hardMax on average.
    if (cut < 0) {
      for (; i < hardEnd; i++) {
        const byte = bytes[i]!;
        h = (((h << 1) >>> 0) ^ GEAR[byte]!) >>> 0;
        if ((h & looseMask) === 0) {
          cut = i + 1;
          break;
        }
      }
    }

    // Phase 3: hard cut. No boundary found anywhere in the window — slice at hardMax.
    if (cut < 0) cut = hardEnd;

    out.push(bytes.subarray(pos, cut));
    pos = cut;
  }

  return out;
}

function validateParams(p: FastCDCParams): void {
  if (!Number.isInteger(p.min) || p.min <= 0) {
    throw new Error(`fastcdcSplit: min must be a positive integer, got ${p.min}`);
  }
  if (!Number.isInteger(p.target) || p.target < p.min) {
    throw new Error(`fastcdcSplit: target must be an integer >= min (${p.min}), got ${p.target}`);
  }
  if (!Number.isInteger(p.hardMax) || p.hardMax < p.target) {
    throw new Error(
      `fastcdcSplit: hardMax must be an integer >= target (${p.target}), got ${p.hardMax}`,
    );
  }
}
