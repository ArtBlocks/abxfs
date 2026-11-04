/**
 * FastLZ (level-1) compress / decompress, ported byte-for-byte from Solady's
 * `LibZip.flzCompress` / `LibZip.flzDecompress`:
 *   https://github.com/vectorized/solady/blob/main/src/utils/LibZip.sol
 *
 * This is the off-chain counterpart of the on-chain `FastLZDecompressor` (which calls
 * `LibZip.flzDecompress`). Keeping the two in lock-step is what makes the ABX FS
 * "pre-compress off-chain → upload X → inflate on-chain → verify Y" flow sound:
 *
 *   - `flzCompress(Y)` here MUST produce bytes X that on-chain `flzDecompress(X)` inflates
 *     back to exactly `Y` (so `keccak256(Y) == outputHash`).
 *   - `flzDecompress(X)` here MUST match on-chain `flzDecompress(X)` so SDK reads and chain
 *     reads agree.
 *
 * The implementation mirrors Solady's assembly directly rather than the upstream ariya
 * reference, so the two stay format-identical. The match-copy is expressed as the canonical
 * byte-by-byte overlapping LZ77 copy, which produces identical output to Solady's
 * word-stepping optimisation.
 */

const HASH_SIZE = 0x2000; // 8192 entries (0x1fff + 1)

/** 24-bit little-endian read of `data[p], data[p+1], data[p+2]` (Solady `u24`). */
function u24(data: Uint8Array, p: number): number {
  return data[p]! | (data[p + 1]! << 8) | (data[p + 2]! << 16);
}

/** Solady `hash`: `(2654435769 * v >> 19) & 0x1fff`. Uses BigInt to avoid 2^53 precision loss. */
function hash(v: number): number {
  return Number(((2654435769n * BigInt(v)) >> 19n) & 0x1fffn);
}

/** Returns the compressed form of `data`, byte-identical to Solady `LibZip.flzCompress`. */
export function flzCompress(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const len = data.length;
  const htab = new Int32Array(HASH_SIZE); // zeroized hashmap of input offsets

  // Emit a run of `runs` literal bytes starting at input index `src` (Solady `literals`).
  function literals(runs: number, src: number): void {
    while (runs >= 0x20) {
      out.push(0x1f); // control byte: type 0, count 32
      for (let k = 0; k < 0x20; k++) out.push(data[src + k]!);
      src += 0x20;
      runs -= 0x20;
    }
    if (runs === 0) return;
    out.push(runs - 1); // control byte: type 0, count `runs`
    for (let k = 0; k < runs; k++) out.push(data[src + k]!);
  }

  // Emit a back-reference of length `l` (= matchLen baseline) at distance `d` (Solady `mt`).
  function mt(l: number, d: number): void {
    d = d - 1;
    while (l >= 263) {
      out.push(224 + (d >> 8));
      out.push(253);
      out.push(d & 0xff);
      l -= 262;
    }
    if (l >= 7) {
      out.push(224 + (d >> 8));
      out.push(l - 7);
      out.push(d & 0xff);
      return;
    }
    out.push((l << 5) + (d >> 8));
    out.push(d & 0xff);
  }

  // Solady `cmp`: returns `matchingBytes + 1` when a mismatch occurs within `[0, e - q)`, or the
  // cap `e - q` when every byte matches. The deliberate +1 (from the assembly's post-increment
  // after zeroing the bound on mismatch) guarantees the match-length code is >= 1, so a short
  // match's control byte never collides with the literal-run opcode (top 3 bits == 0).
  function cmp(p: number, q: number, e: number): number {
    e = e - q;
    let l = 0;
    while (l < e) {
      if (data[p + l] !== data[q + l]) return l + 1;
      l++;
    }
    return l;
  }

  function setNextHash(ip: number): number {
    htab[hash(u24(data, ip))] = ip; // store offset (ipStart == 0)
    return ip + 1;
  }

  const ipLimit = len - 13;
  let a = 0;
  let ip = 2;
  // `ipLimit` is signed here (unlike the EVM's unsigned sub), so small inputs simply skip the
  // main loop and fall through to the trailing-literals emit.
  while (ip < ipLimit) {
    let r = 0;
    let d = 0;
    for (;;) {
      const s = u24(data, ip);
      const h = hash(s);
      r = htab[h]!; // ipStart == 0, so r is the stored offset directly
      htab[h] = ip;
      d = ip - r;
      if (!(ip < ipLimit)) break;
      ip = ip + 1;
      if (!(d > 0x1fff)) {
        if (s === u24(data, r)) break;
      }
    }
    if (!(ip < ipLimit)) break;
    ip = ip - 1;
    if (ip > a) literals(ip - a, a);
    const l = cmp(r + 3, ip + 3, ipLimit + 9);
    mt(l, d);
    ip = setNextHash(setNextHash(ip + l));
    a = ip;
  }

  literals(len - a, a);
  return Uint8Array.from(out);
}

/**
 * Returns the decompressed form of `data`, matching Solady `LibZip.flzDecompress` for every stream a
 * compliant compressor emits.
 *
 * Malformed input (truncated runs, back-references before the start of the output) THROWS instead of
 * emitting garbage, and output beyond `maxOutputBytes` (default 256 MiB) throws before it is
 * allocated: the format inflates ~88x, so a few MiB of hostile input would otherwise ask for GiB.
 */
export function flzDecompress(data: Uint8Array, maxOutputBytes: number = 256 * 1024 * 1024): Uint8Array {
  let out = new Uint8Array(Math.min(Math.max(data.length * 4, 1024), maxOutputBytes));
  let len = 0;
  const ensure = (extra: number) => {
    if (len + extra > maxOutputBytes) {
      throw new Error(`fastlz: output exceeds ${maxOutputBytes} bytes; refusing to inflate`);
    }
    if (len + extra > out.length) {
      const grown = new Uint8Array(Math.min(Math.max(out.length * 2, len + extra), maxOutputBytes));
      grown.set(out.subarray(0, len));
      out = grown;
    }
  };
  const n = data.length;
  let i = 0;
  while (i < n) {
    const c = data[i]!;
    const t = c >> 5;
    if (t === 0) {
      // Literal run of `c + 1` bytes.
      const runs = c + 1;
      if (i + 1 + runs > n) throw new Error("fastlz: truncated literal run");
      ensure(runs);
      out.set(data.subarray(i + 1, i + 1 + runs), len);
      len += runs;
      i += 2 + c;
    } else {
      // Back-reference.
      const g = t === 7 ? 1 : 0;
      if (i + 1 + g >= n) throw new Error("fastlz: truncated back-reference");
      const l = g ? 9 + data[i + 1]! : 2 + t;
      const s = ((c & 0x1f) << 8) + data[i + 1 + g]! + 1;
      const ref = len - s;
      if (ref < 0) throw new Error("fastlz: back-reference before start of output");
      ensure(l);
      // Overlapping copy by design (run-length), so byte by byte.
      for (let k = 0; k < l; k++) out[len + k] = out[ref + k]!;
      len += l;
      i += 2 + g;
    }
  }
  return out.slice(0, len);
}

/** What Solady's `flzDecompress` loop does for one stream: what its gas follows (`gas.ts`). */
export interface FlzDecodeWork {
  /** Literal runs (one loop iteration each, at most 32 bytes). */
  literals: number;
  /** Back-references (one loop iteration each, plus their copy steps). */
  matches: number;
  /**
   * Copy steps: a back-reference of length `l` at distance `s` copies `min(s, 32)` bytes a step, so `ceil(l / min(s,
   * 32))` steps. A short distance is what makes a run or a small repeating pattern expensive to inflate: a 1-byte run
   * copies one byte a step.
   */
  steps: number;
}

/**
 * Count the work Solady's `flzDecompress` does for `stream`, walking it the way that loop does. Pure and linear in the
 * stream; it inflates nothing. A truncated last token is counted as far as it goes.
 */
export function flzDecodeWork(stream: Uint8Array): FlzDecodeWork {
  let literals = 0;
  let matches = 0;
  let steps = 0;
  let i = 0;
  while (i < stream.length) {
    const c = stream[i]!;
    const t = c >> 5;
    if (t === 0) {
      literals++;
      i += 2 + c;
      continue;
    }
    matches++;
    const g = t === 7 ? 1 : 0;
    const l = g ? 9 + (stream[i + 1] ?? 0) : 2 + t;
    const s = ((c & 0x1f) << 8) + (stream[i + 1 + g] ?? 0) + 1;
    steps += Math.ceil(l / Math.min(s, 32));
    i += 2 + g;
  }
  return { literals, matches, steps };
}
