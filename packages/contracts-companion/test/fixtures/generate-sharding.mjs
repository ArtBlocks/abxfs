#!/usr/bin/env node
// HAMT threshold fixtures for `test/IpfsCidResolverSharding.t.sol`: what ipfs-unixfs-importer 16.1.5 (pinned in
// package.json) gives for directories on both sides of the point where `ipfs add -r` shards a directory.
//
// Run: npm ci && node generate-sharding.mjs   (in this directory; writes sharding.json)
//
// The rule (boxo `ipld/unixfs/io/directory.go`, Kubo 0.40 and later, and the importer's `flat-to-shard.js`): with the
// default "links" estimate, a directory is sharded when the sum over its entries of (name bytes + CID bytes) is
// strictly greater than 262,144. Every CID here is 36 bytes. Kubo before 0.40 (boxo before 0.37) used >=.
//
// One difference between the two implementations: the importer counts an entry only once it has a CID, and a
// non-empty subdirectory has none while the tree is being built, so its subdirectories add nothing to its estimate.
// Kubo adds every entry, subdirectories included, from the moment it creates them. The resolver follows Kubo, which
// refuses whenever either shards. The `subdirectoryOver` case shows the importer keeping such a directory flat.
//
// Every entry links the one-byte file "x", or for the subdirectory cases a directory holding "x" under the name "f".
// The test builds the same names:
//   long(i)  = "a" x 249 then i in six digits (255 bytes)
//   tail(n)  = "b" x n (sorts after every long name)
//   img(i)   = "img-" then i in six digits then ".png" (14 bytes)
//   short(i) = i in five digits (5 bytes)
import { writeFileSync } from "node:fs";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import { UnixFS } from "ipfs-unixfs";
import * as dagPB from "@ipld/dag-pb";

const THRESHOLD = 262_144;
const CID_BYTES = 36;

const pad = (i, w) => String(i).padStart(w, "0");
const long = (i) => "a".repeat(249) + pad(i, 6);
const tail = (n) => "b".repeat(n);
const img = (i) => `img-${pad(i, 6)}.png`;
const short = (i) => pad(i, 5);
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// entries: [name, kind] with kind "file", "dir" (holding "f") or "emptyDir"
const cases = [
  { label: "atThreshold", entries: [...range(900, long), tail(208)] },
  { label: "oneOver", entries: [...range(900, long), tail(209)] },
  { label: "long900", entries: range(900, long) },
  { label: "long901", entries: range(901, long) },
  { label: "img5300", entries: range(5300, img) },
  { label: "short7085", entries: range(7085, short) },
  { label: "subdirectoryAtThreshold", entries: range(900, long), dir: [tail(208), "dir"] },
  { label: "subdirectoryOver", entries: range(900, long), dir: [tail(255), "dir"] },
  { label: "emptySubdirectoryOver", entries: range(900, long), dir: [tail(255), "emptyDir"] },
];

const x = new TextEncoder().encode("x");
const out = [];
for (const c of cases) {
  const inputs = c.entries.map((name) => ({ path: `r/${name}`, content: x }));
  const names = [...c.entries];
  if (c.dir) {
    const [name, kind] = c.dir;
    inputs.push(kind === "dir" ? { path: `r/${name}/f`, content: x } : { path: `r/${name}` });
    names.push(name);
  }
  const blockstore = new MemoryBlockstore();
  let root;
  for await (const e of importer(inputs, blockstore, { cidVersion: 1, rawLeaves: true })) {
    if (e.path === "r") root = e;
  }
  let block = await blockstore.get(root.cid);
  if (!(block instanceof Uint8Array)) {
    const parts = [];
    for await (const p of block) parts.push(p);
    block = Buffer.concat(parts);
  }
  const importerType = UnixFS.unmarshal(dagPB.decode(block).Data).type;
  const estimate = names.reduce((a, n) => a + Buffer.byteLength(n) + CID_BYTES, 0);
  const kuboShards = estimate > THRESHOLD;
  console.log(
    `${c.label}: ${names.length} entries, estimate ${estimate} (${kuboShards ? "Kubo shards" : "flat"}), ` +
      `importer ${importerType} ${root.cid}`,
  );
  out.push({ label: c.label, count: names.length, estimate, kuboShards, importerType, importerCid: root.cid.toString() });
}
writeFileSync(new URL("./sharding.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${out.length} cases.`);
