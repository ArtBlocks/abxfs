#!/usr/bin/env node
// Generate multi-level balanced DAG fixtures for IpfsCidResolver testing.
//
// Produces `multi-level-dag.json` in this directory. Each fixture is a self-contained
// (leaves -> expected root) test vector for the 174-link balanced DAG folding logic.
// Leaf CIDs are synthetic (their multihashes are sha256 of deterministic seeds), so the
// DAG shape can be tested at scale without writing gigabytes of file data on-chain.
//
// Run: node generate-multilevel-dag.mjs
//
// `PBLink.Tsize` is the **cumulative serialized size of the linked subtree**, per the
// dag-pb spec (https://ipld.io/specs/codecs/dag-pb/spec/) — i.e. for an intermediate
// dag-pb wrap, `Tsize = encoded_block.length + sum(child_link.Tsize)`. For raw leaves
// the cumulative size collapses to the raw byte length. This was previously emitted as
// just the immediate-block size, which produces non-Kubo CIDs for any DAG taller than
// one layer.
//
// As a Kubo-canonicality guard the same DAG is also rebuilt via `ipfs-unixfs-importer`
// from real deterministic leaf bytes; the importer-produced root CID must equal the
// hand-built one. Generation aborts on mismatch.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 as mhSha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";

const IPFS_MAX_LINKS = 174;
const IPFS_CHUNK_SIZE = 262_144;

const toHex = (bytes) =>
  "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256Bytes = (buf) => createHash("sha256").update(buf).digest();

function encodeVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 128n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function marshalUnixFSFile(filesize, blocksizes) {
  let data = Buffer.concat([
    Buffer.from([0x08]),
    encodeVarint(2),
    Buffer.from([0x18]),
    encodeVarint(filesize),
  ]);
  for (const bs of blocksizes) {
    data = Buffer.concat([data, Buffer.from([0x20]), encodeVarint(bs)]);
  }
  return data;
}

async function rawLeaf(seed) {
  // Synthetic leaf: multihash = sha256(seed). The seed itself is never stored — for a
  // test vector we only care about the CID-binary bytes.
  const mh = await mhSha256.digest(Buffer.from(seed, "utf8"));
  const cid = CID.createV1(raw.code, mh);
  return cid;
}

async function wrapGroup(children) {
  const filesize = children.reduce((acc, c) => acc + c.totalSize, 0);
  const Data = marshalUnixFSFile(filesize, children.map((c) => c.totalSize));
  // PBLink.Tsize MUST be cumulative subtree size: child.cumulativeSize already includes
  // child.encoded.length + every grandchild's cumulative size, recursively.
  const Links = children.map((c) => ({
    Name: "",
    Hash: c.cid,
    Tsize: c.cumulativeSize,
  }));
  const node = dagPB.prepare({ Data, Links });
  const encoded = dagPB.encode(node);
  const mh = await mhSha256.digest(encoded);
  const cumulativeSize =
    encoded.length + children.reduce((acc, c) => acc + c.cumulativeSize, 0);
  return {
    cid: CID.createV1(dagPB.code, mh),
    totalSize: filesize,
    cumulativeSize,
    encoded,
  };
}

async function buildRoot(leaves) {
  let layer = leaves;
  let depth = 0;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += IPFS_MAX_LINKS) {
      next.push(await wrapGroup(layer.slice(i, i + IPFS_MAX_LINKS)));
    }
    layer = next;
    depth++;
  }
  return { root: layer[0], depth };
}

async function fixture(name, leafCount, leafSize) {
  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const cid = await rawLeaf(`${name}-leaf-${i}`);
    leaves.push({
      cid,
      totalSize: leafSize,
      // Raw leaves have no descendants → cumulative subtree size == raw byte count.
      cumulativeSize: leafSize,
    });
  }
  const { root, depth } = await buildRoot(leaves);
  return {
    name,
    leaf_count: leafCount,
    leaf_size: leafSize,
    // Each leaf's CID-binary bytes (what Solidity stores in `cidBins[i]`).
    leaf_cid_bytes_hex: leaves.map((l) => toHex(l.cid.bytes)),
    dag_depth: depth + 1, // +1 because `depth` counts folds; root layer included.
    root_cid: root.cid.toString(),
    root_cid_bytes_hex: toHex(root.cid.bytes),
    root_sha256_hex: toHex(sha256Bytes(root.encoded)),
    root_pbnode_len: root.encoded.length,
    // Cumulative serialized size of the entire root subtree — useful for callers that
    // want to wrap this root in a parent dag-pb node.
    root_cumulative_size: root.cumulativeSize,
  };
}

async function main() {
  const out = [];
  // 175 leaves: crosses into 2-level DAG (ceil(175/174)=2 intermediates -> 1 root).
  out.push(await fixture("leaves-175", 175, 262144));
  // 350 leaves: 3 intermediates at L1 -> 1 root at L2.
  out.push(await fixture("leaves-350", 350, 262144));
  // Mixed leaf sizes (last leaf short). Exercises UnixFS blocksizes list with non-uniform entries.
  const mixed = await (async () => {
    const leaves = [];
    for (let i = 0; i < 200; i++) {
      const cid = await rawLeaf(`mixed-200-leaf-${i}`);
      const sz = i === 199 ? 12345 : 262144;
      leaves.push({ cid, totalSize: sz, cumulativeSize: sz });
    }
    const { root, depth } = await buildRoot(leaves);
    return {
      name: "mixed-200",
      leaf_count: 200,
      // Per-leaf totalSize == cumulativeSize for raw leaves.
      leaf_sizes: leaves.map((l) => l.totalSize),
      leaf_cid_bytes_hex: leaves.map((l) => toHex(l.cid.bytes)),
      dag_depth: depth + 1,
      root_cid: root.cid.toString(),
      root_cid_bytes_hex: toHex(root.cid.bytes),
      root_sha256_hex: toHex(sha256Bytes(root.encoded)),
      root_pbnode_len: root.encoded.length,
      root_cumulative_size: root.cumulativeSize,
    };
  })();
  out.push(mixed);

  // ─── Kubo cross-check: import a single deterministic file of size leaf_count *
  // 256 KiB through ipfs-unixfs-importer and assert the root CID matches our
  // hand-built fixture. We only run this for the uniform 175-leaf case to keep
  // generation snappy (45 MB through the importer). The 350-leaf and mixed-200 cases
  // share the same wrapGroup machinery, so passing the 175-leaf parity is sufficient
  // to guard against tsize regressions.
  await crossCheckUniformWithImporter(out[0]);

  writeFileSync(
    new URL("./multi-level-dag.json", import.meta.url),
    JSON.stringify(out, null, 2) + "\n",
  );

  console.log(`Wrote ${out.length} multi-level DAG fixtures.`);
}

/**
 * Build a deterministic byte stream of `leafCount * leafSize` bytes whose chunks have
 * the same SHA256 digests as our synthetic-seed leaves would, then import it through
 * ipfs-unixfs-importer with the ABX FS profile and assert the root CID matches.
 *
 * NOTE: The leaf_cid_bytes in the multi-level fixture are derived from string seeds
 * (sha256("leaves-175-leaf-N")), not from real bytes — so we cannot reproduce *those*
 * leaf CIDs from the importer. Instead we compute the importer's root CID for an
 * equivalent leaf set (using real deterministic bytes) and confirm that the
 * wrapGroup() / buildRoot() code path produces the same root CID for the same leaf
 * CIDs by checking shape + cumulative-size invariants. The bug we're guarding against
 * is the cumulative-Tsize encoding, which is checked end-to-end by the per-fixture
 * cross-check in generate-fixtures.mjs (nested-dir, multi-block-file).
 */
async function crossCheckUniformWithImporter(fix) {
  const blockstore = new MemoryBlockstore();
  // Generate `leafCount` chunks of exactly `leafSize` bytes each from a single
  // deterministic stream. Each chunk's content is `leafSize` bytes of byte i+1 (1..N),
  // wrapping at 256.
  const totalBytes = fix.leaf_count * fix.leaf_size;
  const stream = Buffer.alloc(totalBytes);
  for (let i = 0; i < fix.leaf_count; i++) {
    stream.fill((i + 1) & 0xff, i * fix.leaf_size, (i + 1) * fix.leaf_size);
  }
  let last;
  for await (const entry of importer(
    [{ path: fix.name, content: stream }],
    blockstore,
    {
      cidVersion: 1,
      rawLeaves: true,
      chunker: fixedSize({ chunkSize: IPFS_CHUNK_SIZE }),
      maxChildrenPerNode: IPFS_MAX_LINKS,
      shardSplitThresholdBytes: Number.POSITIVE_INFINITY,
    },
  )) {
    last = entry;
  }
  if (!last) throw new Error("importer produced no entries");

  // Rebuild the same DAG locally with our wrapGroup, but using the importer's leaf
  // CIDs (which we get from the blockstore by recomputing each chunk's CID).
  const leaves = [];
  for (let i = 0; i < fix.leaf_count; i++) {
    const chunk = stream.subarray(
      i * fix.leaf_size,
      (i + 1) * fix.leaf_size,
    );
    const mh = await mhSha256.digest(chunk);
    leaves.push({
      cid: CID.createV1(raw.code, mh),
      totalSize: fix.leaf_size,
      cumulativeSize: fix.leaf_size,
    });
  }
  const { root: parityRoot } = await buildRoot(leaves);
  if (parityRoot.cid.toString() !== last.cid.toString()) {
    throw new Error(
      `[fixture-cross-check] multi-level wrapGroup parity root CID ${parityRoot.cid.toString()}` +
        ` != ipfs-unixfs-importer root ${last.cid.toString()} (leaf_count=${fix.leaf_count})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
