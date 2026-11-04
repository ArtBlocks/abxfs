#!/usr/bin/env node
// Three-level balanced file DAGs (more than 174^2 = 30,276 leaves) for `test/IpfsCidResolverFold.t.sol`.
//
// Run: npm ci && node generate-fold-three-levels.mjs   (in this directory; writes fold-three-levels.json)
//
// Leaves are synthetic raw blocks, so no content is needed: leaf i of case c has the digest sha256(uint256(i) ‖ c)
// and the size 262,144, or for a mixed case 1 + (first four digest bytes, big-endian) mod 262,144. The test builds the
// same leaves and folds them with the resolver's own `_fold` (through `IpfsCidResolverHarness`).
//
// Two oracles, each independent of ABX FS:
//   - ipfs-unixfs-importer 16.1.5 (pinned in package.json), driven with its own balanced layout and reducer over the
//     synthetic leaves (a chunker yielding one marker per leaf, a buffer importer answering each leaf's CID and size);
//   - a hand fold: @ipld/dag-pb for the nodes, the UnixFS file data marshalled here with BigInt varints.
// They must agree, except where ipfs-unixfs (12.0.2, through protons-runtime) encodes a filesize or blocksize in
// [2^31, 2^32) wrongly: it writes such a uint64 as a signed 32-bit number, so the block is not even valid protobuf.
// Only mixed cases reach that range (a level-2 node of 174 x 174 blocks of about 128 KiB). There the hand fold is the
// expectation, and the case is marked `importerUnusable`.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

const BLOCK = 262_144;
const MAX_LINKS = 174;

const u256 = (n) => {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(n, 28);
  return b;
};
const digestOf = (i, c) => createHash("sha256").update(Buffer.concat([u256(i), Buffer.from([c])])).digest();
const sizeOf = (i, c, mixed) => (mixed ? 1 + (digestOf(i, c).readUInt32BE(0) % BLOCK) : BLOCK);

function varint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 128n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

// UnixFS { Type: File, filesize, blocksizes }.
function fileData(filesize, blocksizes) {
  return Buffer.concat([Buffer.from([0x08, 0x02, 0x18]), varint(filesize), ...blocksizes.flatMap((b) => [Buffer.from([0x20]), varint(b)])]);
}

function handFold(c, n, mixed) {
  let layer = [];
  for (let i = 0; i < n; i++) {
    const s = sizeOf(i, c, mixed);
    layer.push({ cid: CID.createV1(0x55, Digest.create(0x12, digestOf(i, c))), total: BigInt(s), cum: BigInt(s) });
  }
  // A filesize (and so a parent's blocksize) the importer's encoder gets wrong.
  let broken = null;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += MAX_LINKS) {
      const g = layer.slice(i, i + MAX_LINKS);
      const total = g.reduce((a, x) => a + x.total, 0n);
      if (broken === null && total >= 2n ** 31n && total < 2n ** 32n) broken = total;
      const Data = fileData(total, g.map((x) => x.total));
      const Links = g.map((x) => ({ Name: "", Hash: x.cid, Tsize: Number(x.cum) }));
      const block = dagPB.encode(dagPB.prepare({ Data, Links }));
      const cum = BigInt(block.length) + g.reduce((a, x) => a + x.cum, 0n);
      next.push({ cid: CID.createV1(0x70, Digest.create(0x12, createHash("sha256").update(block).digest())), total, cum });
    }
    layer = next;
  }
  return { cid: layer[0].cid.toString(), tsize: Number(layer[0].cum), broken };
}

async function importerFold(c, n, mixed) {
  const chunker = async function* () {
    for (let i = 0; i < n; i++) yield u256(i);
  };
  const bufferImporter = async function* (file) {
    for await (const block of file.content) {
      const i = block.readUInt32BE(28);
      yield async () => ({
        cid: CID.createV1(0x55, Digest.create(0x12, digestOf(i, c))),
        size: BigInt(sizeOf(i, c, mixed)),
        block,
      });
    }
  };
  let root;
  for await (const e of importer([{ path: "f", content: new Uint8Array([1]) }], new MemoryBlockstore(), {
    cidVersion: 1,
    rawLeaves: true,
    chunker,
    bufferImporter,
  })) {
    root = e;
  }
  return { cid: root.cid.toString(), tsize: Number(root.size) };
}

const cases = [
  { c: 1, n: 30_276, mixed: false }, // exactly 174^2: two full levels
  { c: 2, n: 30_277, mixed: false }, // one more: a third level, whose second node has a one-child chain under it
  { c: 3, n: 35_000, mixed: true },
  { c: 4, n: 30_277, mixed: true },
  { c: 5, n: 300, mixed: true },
  { c: 6, n: 2, mixed: true },
];

const out = [];
for (const { c, n, mixed } of cases) {
  const hand = handFold(c, n, mixed);
  const imp = await importerFold(c, n, mixed);
  const unusable = hand.broken !== null;
  if (!unusable && (hand.cid !== imp.cid || hand.tsize !== imp.tsize)) {
    throw new Error(`case ${c}: the hand fold and the importer disagree outside the importer's broken range`);
  }
  console.log(
    `case ${c}: ${n} leaves${mixed ? " (mixed sizes)" : ""} -> ${hand.cid}, Tsize ${hand.tsize}` +
      (unusable ? ` (importer unusable: a filesize of ${hand.broken}; it says ${imp.cid})` : ", importer agrees"),
  );
  out.push({ c, n, mixed, cid: hand.cid, tsize: hand.tsize, importerUnusable: unusable });
}
writeFileSync(new URL("./fold-three-levels.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${out.length} cases.`);
