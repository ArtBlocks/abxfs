#!/usr/bin/env node
// Differential fixtures for IpfsCidResolver: random trees, written as a byte program that
// `test/IpfsCidResolverDifferential.t.sol` replays through the real content layer, with the CID and Tsize
// ipfs-unixfs-importer gives every object of the same tree.
//
// Run: npm ci && node generate-differential-trees.mjs   (in this directory; writes differential-trees.json)
//
// The importer is pinned to 16.1.5 in package.json and runs with the ABX FS profile: CIDv1, raw leaves, 256 KiB
// chunks, 174 links per node, the default "links" HAMT estimate (no directory here comes near it). Nothing in the
// expectations comes from ABX FS code.
//
// Each tree is small enough for the default forge profile (about 1 MiB of stored content), and between them the trees
// cover:
//   - files of 0 bytes, a few bytes, around a block, and several blocks, cut into chunks of every size (tiny chunks
//     give files of more than one page of 128 chunk ids);
//   - raw and FastLZ chunks, FastLZ chunks of compressible runs inflating past one 256 KiB block and past the
//     resolver's block buffer, and chunk lists repeated (stored once, hashed every time);
//   - file and entry node trees of one to three branch levels, with random leaf and branch widths;
//   - directories of more than one page of 64 entries, empty directories, files linked from several directories;
//   - names of every valid UTF-8 shape: control bytes, DEL, two-, three- and four-byte sequences, 1 to 255 bytes.
//
// Program (big-endian integers):
//   file:      0x01 seed:32 kind:1 runLen:4 baseSize:6 rep:4 chunkCount:4 leafCap:2 branchCap:1
//              then per chunk: size:4 fastLz:1. The content is the base (below) repeated `rep` times; the chunk list
//              covers the base once and is repeated `rep` times.
//   directory: 0x02 entryCount:4 leafCap:2 branchCap:1
//              then per entry, in byte order of name: nameLen:1 name isDirectory:1 objectIndex:4
// Base content of `size` bytes, word w (32 bytes) of it:
//   kind 0: sha256(seed ‖ uint256(w));
//   kind 1: the byte sha256(seed ‖ uint256(floor(32w / runLen)))[0], repeated (runs of `runLen` bytes).
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";

const EMPTY_DIR_CID = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";
const BLOCK = 262_144;
const RAW_MAX = 24_575;
const SEEDS = [1, 2, 3, 4, 5, 6];
// What one tree may cost the replay, which must stay inside the default profile's 2^30 gas per test. Writing costs
// about 215 gas a stored byte (FastLZ runs store at well under a quarter of their size). Every derivation of the tree
// reads it all: about 8 gas a raw byte, 12 a FastLZ byte of random data, 60 a FastLZ byte of runs; the replay derives
// each object once, so content is read about once per directory above it.
const STORED_BUDGET = 600_000;
const READ_GAS_BUDGET = 40_000_000;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function u(n, bytes) {
  const out = Buffer.alloc(bytes);
  let v = BigInt(n);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function baseContent(seed, kind, runLen, size) {
  const out = Buffer.alloc(size);
  const words = Math.ceil(size / 32);
  let lastRun = -1;
  let b = 0;
  for (let w = 0; w < words; w++) {
    const end = Math.min(w * 32 + 32, size);
    if (kind === 0) {
      const h = createHash("sha256").update(Buffer.concat([seed, u(w, 32)])).digest();
      h.copy(out, w * 32, 0, end - w * 32);
    } else {
      const run = Math.floor((w * 32) / runLen);
      if (run !== lastRun) {
        b = createHash("sha256").update(Buffer.concat([seed, u(run, 32)])).digest()[0];
        lastRun = run;
      }
      out.fill(b, w * 32, end);
    }
  }
  return out;
}

const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function randomName(rng) {
  const r = rng();
  const target = r < 0.5 ? ri(rng, 1, 8) : r < 0.85 ? ri(rng, 9, 40) : ri(rng, 41, 255);
  const bytes = [];
  while (bytes.length < target) {
    const c = rng();
    let ch;
    if (c < 0.6) {
      do ch = [ri(rng, 0x20, 0x7e)];
      while (ch[0] === 0x2f || ch[0] === 0x5c); // the store refuses `/` and `\`
    } else if (c < 0.67) ch = [ri(rng, 0x00, 0x1f)];
    else if (c < 0.7) ch = [0x7f];
    else if (c < 0.85) {
      const cp = ri(rng, 0x80, 0x7ff);
      ch = [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
    } else if (c < 0.95) {
      let cp;
      do cp = ri(rng, 0x800, 0xffff);
      while (cp >= 0xd800 && cp <= 0xdfff);
      ch = [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    } else {
      const cp = ri(rng, 0x10000, 0x10ffff);
      ch = [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
    }
    if (bytes.length + ch.length > 255) break;
    bytes.push(...ch);
  }
  const b = Buffer.from(bytes);
  const s = b.toString("latin1");
  if (b.length === 0 || s === "." || s === "..") return randomName(rng);
  new TextDecoder("utf-8", { fatal: true }).decode(b); // valid UTF-8, so the importer's path string is lossless
  return b;
}

function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

async function oneTree(seedNumber, t) {
  const rng = mulberry32(seedNumber);
  const files = [];
  let stored = 0;
  let readGas = 0;
  // Features every tree is steered towards, so the six of them cover all of them.
  const want = { bigFlz: t % 2 === 0, tinyChunks: t % 3 === 0, bigDir: true };

  function chunksFor(kind, baseSize, rep, style) {
    const chunks = [];
    let cost = 0;
    let left = baseSize;
    while (left > 0) {
      let size;
      let flz = false;
      if (style === "tiny") {
        size = Math.min(left, ri(rng, 1, 64));
      } else if (style === "bigFlz") {
        flz = true;
        size = left; // one chunk
      } else if (kind === 1 && rng() < 0.6) {
        flz = true;
        size = Math.min(left, ri(rng, 1, 40_000));
      } else {
        size = Math.min(left, rng() < 0.5 ? RAW_MAX : ri(rng, 1, RAW_MAX));
        flz = kind === 0 && size <= 16_000 && rng() < 0.2;
      }
      chunks.push({ size, flz });
      stored += flz && kind === 1 ? Math.ceil(size / 4) : size;
      cost += size * rep * (flz ? (kind === 1 ? 60 : 12) : 8);
      left -= size;
    }
    readGas += cost;
    return { chunks, cost };
  }

  // A file to link again. Mostly cheap ones: nothing is memoised, so every link to a file reads it again, and a
  // directory of 100 entries over a few large files would cost the replay a hundred of them.
  function reuse() {
    const cheap = files.filter((f) => f.cost <= 100_000);
    const pool = cheap.length > 0 ? cheap : files;
    return pool[ri(rng, 0, pool.length - 1)];
  }

  function makeFile() {
    const full = stored > STORED_BUDGET || readGas > READ_GAS_BUDGET;
    if (files.length >= 24 || (full && files.length > 0)) return reuse();
    const seed = createHash("sha256").update(`tree-${t}-file-${files.length}-${rng()}`).digest();
    let kind = rng() < 0.35 ? 1 : 0;
    const runLen = 32 * ri(rng, 32, 128);
    let style = "mixed";
    let baseSize;
    let rep = 1;
    if (want.bigFlz) {
      // A FastLZ chunk of runs that inflates past one block and past the block buffer.
      want.bigFlz = false;
      kind = 1;
      style = "bigFlz";
      baseSize = ri(rng, 290_000, 330_000); // more than 262,144 and than the 286,752-byte buffer
    } else if (want.tinyChunks) {
      // More than 128 chunk records: two or more pages of ids.
      want.tinyChunks = false;
      style = "tiny";
      baseSize = ri(rng, 9_000, 14_000);
    } else {
      const r = rng();
      if (r < 0.08) baseSize = 0;
      else if (r < 0.16) baseSize = ri(rng, 1, 40);
      else if (r < 0.55) baseSize = ri(rng, 41, 30_000);
      else if (r < 0.7) baseSize = BLOCK + ri(rng, -2, 2);
      else if (r < 0.8) baseSize = ri(rng, BLOCK - 30_000, BLOCK + 60_000);
      else baseSize = ri(rng, 30_000, 120_000);
      if (stored + baseSize > STORED_BUDGET || readGas + 60 * baseSize > READ_GAS_BUDGET) {
        baseSize = ri(rng, 0, 4_000);
      }
      // Now and then a chunk list repeated: stored once, read and hashed every time.
      if (baseSize > 0 && baseSize < 30_000 && rng() < 0.15) rep = ri(rng, 2, 9);
    }
    const { chunks, cost } = chunksFor(kind, baseSize, rep, style);
    const nChunks = chunks.length * rep;
    let leafCap = rng() < 0.4 ? ri(rng, 1, 8) : ri(rng, 1, 646);
    let branchCap = ri(rng, 2, rng() < 0.5 ? 4 : 128);
    leafCap = Math.min(646, Math.max(leafCap, Math.ceil(nChunks / 128 ** 3), 1));
    while (Math.ceil(nChunks / leafCap) > branchCap ** 3) branchCap++;
    const f = { kind: "file", seed, kindC: kind, runLen, baseSize, rep, chunks, leafCap, branchCap, cost };
    files.push(f);
    return f;
  }

  let dirCount = 0;
  function makeDir(depth) {
    const r = rng();
    let n;
    if (want.bigDir && depth === 1) {
      // More than one page of 64 entries.
      want.bigDir = false;
      n = ri(rng, 65, 140);
    } else if (depth > 0 && r < 0.1) n = 0;
    else if (r < 0.75) n = ri(rng, 1, 8);
    else n = ri(rng, 9, 40);
    dirCount++;
    const names = new Map();
    while (names.size < n) {
      const nm = randomName(rng);
      names.set(nm.toString("hex"), nm);
    }
    const sorted = [...names.values()].sort(cmpBytes);
    const entries = [];
    for (const name of sorted) {
      let child;
      if (depth < 3 && dirCount < 7 && (rng() < 0.2 || (want.bigDir && depth === 0))) child = makeDir(depth + 1);
      else if (files.length > 0 && rng() < 0.2) child = reuse();
      else child = makeFile();
      entries.push({ name, child });
    }
    const leafCap = rng() < 0.5 ? ri(rng, 1, 12) : 300;
    let branchCap = ri(rng, 2, rng() < 0.5 ? 4 : 128);
    while (Math.ceil(n / leafCap) > branchCap ** 3) branchCap++;
    return { kind: "dir", entries, leafCap, branchCap };
  }
  const root = makeDir(0);

  // Program, bottom up, each object once.
  const order = [];
  const index = new Map();
  function emit(o) {
    if (index.has(o)) return index.get(o);
    if (o.kind === "dir") for (const e of o.entries) emit(e.child);
    index.set(o, order.length);
    order.push(o);
    return order.length - 1;
  }
  emit(root);
  const prog = [];
  for (const o of order) {
    if (o.kind === "file") {
      prog.push(Buffer.from([1]), o.seed, u(o.kindC, 1), u(o.runLen, 4), u(o.baseSize, 6), u(o.rep, 4));
      prog.push(u(o.chunks.length, 4), u(o.leafCap, 2), u(o.branchCap, 1));
      for (const c of o.chunks) prog.push(u(c.size, 4), u(c.flz ? 1 : 0, 1));
    } else {
      prog.push(Buffer.from([2]), u(o.entries.length, 4), u(o.leafCap, 2), u(o.branchCap, 1));
      for (const e of o.entries) {
        prog.push(u(e.name.length, 1), e.name, u(e.child.kind === "dir" ? 1 : 0, 1), u(index.get(e.child), 4));
      }
    }
  }

  // The same tree through the importer.
  const inputs = [];
  const pathsOf = new Map();
  function walk(o, path) {
    if (!pathsOf.has(o)) pathsOf.set(o, []);
    pathsOf.get(o).push(path);
    if (o.kind === "dir") {
      if (o.entries.length === 0) inputs.push({ path });
      for (const e of o.entries) walk(e.child, `${path}/${new TextDecoder().decode(e.name)}`);
    } else {
      const base = baseContent(o.seed, o.kindC, o.runLen, o.baseSize);
      inputs.push({ path, content: o.rep === 1 ? base : Buffer.concat(Array(o.rep).fill(base)) });
    }
  }
  walk(root, "r");
  const got = new Map();
  for await (const entry of importer(inputs, new MemoryBlockstore(), { cidVersion: 1, rawLeaves: true })) {
    got.set(entry.path, { cid: entry.cid.toString(), size: Number(entry.size) });
  }
  const cids = [];
  const tsizes = [];
  let totalBytes = 0;
  for (const o of order) {
    let want;
    if (o.kind === "dir" && o.entries.length === 0) want = { cid: EMPTY_DIR_CID, size: 4 };
    for (const p of pathsOf.get(o)) {
      const g = got.get(p);
      if (!g) {
        if (o.kind === "dir" && o.entries.length === 0) continue;
        throw new Error(`importer gave nothing for ${JSON.stringify(p)}`);
      }
      if (want && (want.cid !== g.cid || want.size !== g.size)) throw new Error(`one object, two CIDs at ${p}`);
      want = g;
    }
    if (o.kind === "file") totalBytes += o.baseSize * o.rep;
    cids.push(want.cid);
    tsizes.push(want.size);
  }
  const maxEntries = Math.max(...order.filter((o) => o.kind === "dir").map((o) => o.entries.length));
  const maxChunk = Math.max(0, ...files.flatMap((f) => f.chunks.map((c) => c.size)));
  const maxChunks = Math.max(0, ...files.map((f) => f.chunks.length * f.rep));
  console.log(
    `tree ${t} (seed ${seedNumber}): ${order.length} objects, ${files.length} files, ${dirCount} directories, ` +
      `${totalBytes} bytes (about ${stored} stored), largest directory ${maxEntries}, largest chunk ${maxChunk}, ` +
      `most chunk records ${maxChunks}, root ${cids.at(-1)}`,
  );
  return { program: "0x" + Buffer.concat(prog).toString("hex"), cids, tsizes };
}

const trees = [];
for (let t = 0; t < SEEDS.length; t++) trees.push(await oneTree(SEEDS[t], t));
writeFileSync(new URL("./differential-trees.json", import.meta.url), JSON.stringify(trees, null, 1) + "\n");
console.log(`Wrote ${trees.length} trees.`);
