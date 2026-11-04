/**
 * Precomputed Gear hash table: 256 deterministic 32-bit values, one per possible byte.
 *
 * Determinism is critical — these values are baked into chunk boundaries (and therefore
 * file CIDs) for every ABX FS upload using the FastCDC chunker. Changing the values
 * means existing CDC-chunked files won't dedup against new uploads of the same bytes.
 *
 * The table is generated at module load via a Mulberry32 PRNG seeded with `0xba5e5eed`
 * ("base seed", all valid hex digits). Mulberry32 was chosen because it's a tiny,
 * well-studied 32-bit PRNG with very good statistical properties for table-fill
 * purposes; switching to any other deterministic PRNG would just produce a different
 * (still equally valid) gear table.
 *
 * IMPORTANT: any change to `SEED` or `mulberry32` is a chunking-strategy migration.
 * It changes every chunk boundary and so every CID: it is frozen.
 */

const SEED = 0xba5e5eed;

/**
 * Mulberry32 — fixed 32-bit state, 32-bit output PRNG. Released to public domain by
 * Tommy Ettinger; commonly used for reproducible procedural generation.
 *
 * Returns a closure that yields the next uint32 on each call.
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

function buildTable(): Uint32Array {
  const next = mulberry32(SEED);
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) out[i] = next();
  return out;
}

/**
 * The table the chunker reads: a `Uint32Array` (not a regular `number[]`) so the JIT keeps it in the SMI fast path
 * and avoids any boxed-number allocations on the hot loop. A typed array cannot be frozen, so this one stays inside the
 * package (the export map does not reach this module) and is never handed out: a caller writing to it would move
 * every chunk boundary the process computes afterwards.
 */
export const GEAR: Uint32Array = buildTable();

/** The 256 gear values, indexed by byte (0..255), as a frozen copy: the public, read-only view of {@link GEAR}. */
export const GEAR_TABLE: readonly number[] = Object.freeze(Array.from(GEAR));
