// Prints the ABX FS golden vectors used by test/nodes.test.ts and packages/contracts-core/test/GoldenVectors.t.sol.
// Run after `pnpm build`:
//   node scripts/golden-vectors.mjs
// The inputs are deterministic (no chain):
//   chunk id i is keccak256("chunk-" + i), and its size is 1000 + 100 * (i % 7) (packing only needs ids and sizes);
//   a "high" id is the same with its top byte set to 0xff, so it is never a content-defined boundary; a "low" id has
//   its top byte cleared, so every chunk is a boundary candidate;
//   f5 uses REAL chunk ids: chunkId(backend 0x…aa, keccak256(input), keccak256(data), size) for data "real-" + i,
//   input = data (a raw backend), so the chunk-id formula is pinned on both sides too.
import { keccak256, toBytes } from "viem";
import { packChunkTree, packEntryTree, fileCid, directoryCid, EMPTY_DIRECTORY } from "../dist/nodes.js";
import { chunkId } from "../dist/cid.js";
import { codecLabel } from "../dist/compression.js";

const h = (i) => keccak256(toBytes(`chunk-${i}`));
const high = (i) => `0xff${h(i).slice(4)}`;
const low = (i) => `0x00${h(i).slice(4)}`;
const size = (i) => 1000 + 100 * (i % 7);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const shape = (t) => t.nodes.map((n) => ({ id: n.id, level: n.level, count: n.count, size: n.size }));
const out = {};

const f1 = packChunkTree(range(3).map(h), range(3).map(size));
out.f1 = { root: f1.root, rootLevel: f1.rootLevel, cid: fileCid(f1.root, "text/plain") };

// Content-defined leaves and a branch; the CID binds a file codec and its output hash.
const f2 = packChunkTree(range(1200).map(h), range(1200).map(size));
out.f2 = {
  nodes: shape(f2),
  root: f2.root,
  cid: fileCid(f2.root, "application/octet-stream", codecLabel("gzip"), keccak256(toBytes("logical"))),
};

// No natural boundary anywhere: leaves are forced at the 512 maximum.
const f3 = packChunkTree(range(1100).map(high), range(1100).map(size));
out.f3 = { nodes: shape(f3), root: f3.root, cid: fileCid(f3.root, "video/mp4") };

// Every chunk a boundary candidate: minimum-size leaves, so the BRANCHES are content-defined (by leaf node id),
// including the trailing-one-child rule if it applies, under a two-level tree.
const f4 = packChunkTree(range(4200).map(low), range(4200).map(size));
out.f4 = {
  leaves: f4.nodes.filter((n) => n.level === 0).length,
  branchSizes: f4.nodes.filter((n) => n.level >= 1).map((n) => [n.level, n.childIds.length]),
  root: f4.root,
  rootLevel: f4.rootLevel,
  cid: fileCid(f4.root, "application/octet-stream"),
};

// Real chunk ids through one raw backend.
const BACKEND = "0x00000000000000000000000000000000000000aa";
const real = range(3).map((i) => {
  const data = toBytes(`real-${i}`);
  const dh = keccak256(data);
  return { id: chunkId(BACKEND, dh, dh, data.length), size: data.length };
});
const f5 = packChunkTree(real.map((c) => c.id), real.map((c) => c.size));
out.f5 = { ids: real.map((c) => c.id), root: f5.root, cid: fileCid(f5.root, "text/plain") };

// The empty file and the empty directory.
out.empty = { file: fileCid("0x" + "00".repeat(32), "text/plain"), directory: EMPTY_DIRECTORY };

const f1cid = out.f1.cid;
const d1 = packEntryTree([{ name: "x", cid: f1cid, isDirectory: false }]);
out.d1 = { root: d1.root, cid: directoryCid(d1.root) };

const uni = ["a", "z", "é", "Ａ", "😀", "日本"].map((name) => ({ name, cid: f1cid, isDirectory: false }));
uni.push({ name: "dir", cid: out.d1.cid, isDirectory: true });
const d2 = packEntryTree(uni);
out.d2 = { leaves: d2.nodes.length, root: d2.root, cid: directoryCid(d2.root) };

// 400 entries named e000..e399: content-defined leaves (records are 40 bytes, so about 16 KB) and a branch.
const many = range(400).map((i) => ({ name: `e${String(i).padStart(3, "0")}`, cid: f1cid, isDirectory: false }));
const d3 = packEntryTree(many);
out.d3 = {
  leafCounts: d3.nodes.filter((n) => n.level === 0).map((n) => n.count),
  nodes: shape(d3),
  root: d3.root,
  cid: directoryCid(d3.root),
};

// A directory holding the empty file and the empty directory.
const d4 = packEntryTree([
  { name: ".nojekyll", cid: out.empty.file, isDirectory: false },
  { name: "e", cid: EMPTY_DIRECTORY, isDirectory: true },
]);
out.d4 = { root: d4.root, cid: directoryCid(d4.root) };
console.log(JSON.stringify(out, null, 2));
