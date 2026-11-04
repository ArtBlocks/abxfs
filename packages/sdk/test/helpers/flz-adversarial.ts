/**
 * Three FastLZ streams from the delta audit's fresh adversarial corpus (2026-10-30) that the stream model with the
 * 2026-10-29 constants priced BELOW their receipts (up to 1.7%): many short back-references between literals, where
 * each token costs more to decode than the old per-literal and per-match figures. Regenerated exactly as that corpus
 * made them (an xorshift32 seeded 0xc0ffee, consumed in the corpus's order), so the pins in `gas-schedule.test.ts`
 * carry the very streams that were measured.
 */
const N = 24_575;

function xorshift(seed: number): () => number {
  let s = seed;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

const gen = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

/**
 * `dict3-sep2`: 3-byte words from a 64-word dictionary, each followed by two random bytes (a match and a literal run
 * every 5 bytes). The corpus drew 19 periodic patterns, a 300-byte block and `dict3-sep1` from the generator first.
 */
export function dict3Sep2(): Uint8Array {
  const rnd = xorshift(0xc0ffee);
  const block = (n: number) => gen(n, () => Math.floor(rnd() * 256));
  for (const p of [3, 4, 5, 7, 8, 15, 16, 17, 31, 32, 33, 64, 255, 256, 1000, 4096, 8191, 8192, 8193]) block(p);
  block(300);
  let out = new Uint8Array(0);
  for (const sep of [1, 2]) {
    const dict = Array.from({ length: 64 }, () => block(3));
    const b: number[] = [];
    while (b.length < N) {
      b.push(...dict[Math.floor(rnd() * dict.length)]!);
      for (let k = 0; k < sep; k++) b.push(Math.floor(rnd() * 256));
    }
    out = Uint8Array.from(b.slice(0, N));
  }
  return out;
}

/** `sparse<k>-a<alpha>-z<zeros>`: in every `k` bytes, `zeros` zero bytes then random bytes in 1..alpha. */
export function sparse(k: 3 | 5, alpha: 64, zeros: 2): Uint8Array {
  const rnd = xorshift(0xc0ffee);
  for (const kk of [3, 4, 5]) {
    for (const a of [256, 64, 16, 8, 4]) {
      for (const z of [1, 2]) {
        const data = gen(N, (i) => (i % kk < z ? 0 : Math.floor(rnd() * a) + 1));
        if (kk === k && a === alpha && z === zeros) return data;
      }
    }
  }
  throw new Error("unreachable");
}
