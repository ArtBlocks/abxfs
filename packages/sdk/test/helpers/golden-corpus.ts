/**
 * Deterministic inputs for the golden vectors (`test/audit9/Audit9Golden.test.ts`, `test/fixtures/*.json`). Every
 * input is a pure function of its name, so a fixture can pin its output without storing megabytes of input. Changing
 * any generator here changes the inputs, not the frozen algorithms: the fixture's input hashes catch that first.
 */

/** xorshift32 from a seed: the same bytes on every platform. */
export function prng(seed: number): { int: (n: number) => number; bytes: (n: number) => Uint8Array } {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return { int: (n) => next() % n, bytes: (n) => Uint8Array.from({ length: n }, () => next() & 0xff) };
}

const text = (s: string) => new TextEncoder().encode(s);
const repeat = (pattern: Uint8Array, n: number) => Uint8Array.from({ length: n }, (_, i) => pattern[i % pattern.length]!);

/** The FastLZ corpus: edge lengths, runs at the match-length boundaries, the 8 KiB window, and realistic data. */
export function flzCorpus(): Array<{ name: string; bytes: Uint8Array }> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const n of [0, 1, 2, 3, 12, 13, 14, 15, 16, 31, 32, 33]) out.push({ name: `random-${n}`, bytes: prng(1000 + n).bytes(n) });
  for (const n of [3, 4, 9, 10, 15, 16, 17]) out.push({ name: `zeros-${n}`, bytes: new Uint8Array(n) });
  for (const run of [261, 262, 263, 264, 265, 524, 525, 526, 786, 787, 8191, 8192, 8193]) {
    const r = prng(2000 + run);
    out.push({ name: `run-${run}`, bytes: Uint8Array.from([...r.bytes(7), ...new Uint8Array(run).fill(0x5a), ...r.bytes(9)]) });
  }
  for (const gap of [8188, 8189, 8190, 8191, 8192, 8193, 8194]) {
    const r = prng(3000 + gap);
    const base = r.bytes(96);
    out.push({ name: `window-${gap}`, bytes: Uint8Array.from([...base, ...r.bytes(gap - 96), ...base, ...r.bytes(17), ...base]) });
  }
  for (const p of [1, 2, 3, 4, 8, 31, 32, 33, 100]) out.push({ name: `period-${p}`, bytes: repeat(prng(4000 + p).bytes(p), 24_575) });
  out.push({ name: "random-24575", bytes: prng(5001).bytes(24_575) });
  out.push({ name: "random-24574", bytes: prng(5002).bytes(24_574) });
  {
    const r = prng(5003);
    out.push({ name: "sparse-2pct", bytes: Uint8Array.from({ length: 24_575 }, () => (r.int(50) === 0 ? r.int(256) : 0)) });
  }
  {
    const r = prng(5004);
    out.push({ name: "low-entropy-4", bytes: Uint8Array.from({ length: 24_575 }, () => r.int(4)) });
  }
  {
    const r = prng(5005);
    const words = ["function ", "return ", "const ", "{", "}", "(", ")", ";\n", "  ", "if (", "else ", "x", "value", "=> ", "."];
    let s = "";
    while (s.length < 24_575) s += words[r.int(words.length)];
    out.push({ name: "code-like", bytes: text(s.slice(0, 24_575)) });
  }
  {
    const r = prng(5006);
    let s = "";
    while (s.length < 18_000) s += `${" ".repeat(r.int(12))}"key${r.int(500)}": ${r.int(1e6)},\n`;
    out.push({ name: "json-like", bytes: text(s.slice(0, 18_000)) });
  }
  {
    const W = 64;
    const px = Uint8Array.from({ length: 24_575 }, (_, i) => {
      const band = Math.floor(i / (W * 4 * 8));
      return [(band * 37) & 0xff, (band * 91) & 0xff, (band * 53) & 0xff, 0xff][i % 4]!;
    });
    out.push({ name: "rgba-bands", bytes: px });
  }
  return out;
}

/** Inputs for the FastCDC boundary vectors, at the production parameters (`chunkBytes`, backendMax 24,575). */
export function cdcCorpus(): Array<{ name: string; bytes: Uint8Array }> {
  return [
    { name: "random-12287", bytes: prng(6001).bytes(12_287) },
    { name: "random-12288", bytes: prng(6002).bytes(12_288) },
    { name: "random-12289", bytes: prng(6003).bytes(12_289) },
    { name: "random-24575", bytes: prng(6004).bytes(24_575) },
    { name: "random-24576", bytes: prng(6005).bytes(24_576) },
    { name: "random-300000", bytes: prng(6006).bytes(300_000) },
    // The shortest cut there can be: the hash restarts at offset 12,287, no single byte matches the 15-bit mask from a
    // fresh hash, and bytes 65 then 14 do, so the first chunk is 12,289 bytes (the cut follows the matching byte).
    { name: "shortest-cut", bytes: (() => { const b = prng(6009).bytes(30_000); b[12_287] = 65; b[12_288] = 14; return b; })() },
    { name: "zeros-100000", bytes: new Uint8Array(100_000) },
    { name: "period-7-200000", bytes: repeat(prng(6007).bytes(7), 200_000) },
    {
      name: "text-250000",
      bytes: (() => {
        const r = prng(6008);
        const words = ["the ", "chain ", "content ", "address ", "file ", "of ", "a ", "and ", "\n", "node ", "leaf "];
        let s = "";
        while (s.length < 250_000) s += words[r.int(words.length)];
        return text(s.slice(0, 250_000));
      })(),
    },
  ];
}

/** Files for the end-to-end vectors, bytes to file CID: one tiny, one FastLZ text, one mixed, one past 512 chunks. */
export function e2eCorpus(): Array<{ name: string; bytes: Uint8Array; mimeType: string }> {
  const r = prng(7001);
  const words = ["alpha ", "beta ", "gamma ", "delta ", "\n", "  ", "epsilon "];
  let s = "";
  while (s.length < 120_000) s += words[r.int(words.length)];
  const mixed = new Uint8Array(200_000);
  {
    const m = prng(7002);
    for (let i = 0; i < mixed.length; i += 10_000) {
      if (m.int(2)) mixed.set(m.bytes(Math.min(10_000, mixed.length - i)), i);
      else mixed.fill(m.int(256), i, i + 10_000);
    }
  }
  return [
    { name: "tiny.txt", bytes: text("hello, chain"), mimeType: "text/plain" },
    { name: "words.txt", bytes: text(s.slice(0, 120_000)), mimeType: "text/plain" },
    { name: "mixed.bin", bytes: mixed, mimeType: "application/octet-stream" },
    // Incompressible, so every chunk is raw and averages about 21.7 KB: about 580 chunks, more than one leaf can hold.
    { name: "big.bin", bytes: prng(7003).bytes(12_500_000), mimeType: "application/octet-stream" },
  ];
}
