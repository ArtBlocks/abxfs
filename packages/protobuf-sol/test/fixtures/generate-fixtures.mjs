#!/usr/bin/env node
// Generate IPFS CID / dag-pb / protobuf fixtures from the reference libraries.
//
// Run: node generate-fixtures.mjs
//
// Every dag-pb / multi-block-file fixture is cross-checked against
// `ipfs-unixfs-importer` (the canonical JS reference, byte-identical with Kubo for
// the ABX FS profile) so that a fixture cannot silently encode a non-Kubo CID. If any
// CID mismatches, generation aborts and prints both values for diffing.
//
// dag-pb `PBLink.Tsize` MUST be the cumulative serialized size of the linked subtree
// (target node + every descendant block), per the dag-pb spec
// https://ipld.io/specs/codecs/dag-pb/spec/. Using the immediate-block size produces
// non-Kubo CIDs.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { UnixFS } from "ipfs-unixfs";
import * as raw from "multiformats/codecs/raw";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";

const IPFS_CHUNK_SIZE = 262_144;

const toHex = (bytes) =>
  "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256Bytes = (buf) => createHash("sha256").update(buf).digest();

/**
 * Run `ipfs-unixfs-importer` over `candidates` with the ABX FS profile (cidVersion: 1,
 * raw leaves, fixed 256 KiB chunker, max 174 children) and return the root CID string.
 *
 * Caller controls whether the importer wraps inputs in a synthetic root directory via
 * `wrap`. The importer emits one entry per file/dir; the wrap entry has empty path.
 * For single-file imports without wrapping we use the last entry.
 */
async function importerRootCid(candidates, { wrap }) {
  const blockstore = new MemoryBlockstore();
  let last;
  let wrapEntry;
  for await (const entry of importer(candidates, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: IPFS_CHUNK_SIZE }),
    wrapWithDirectory: wrap,
    // Disable HAMT sharding so the importer always emits flat dag-pb directories,
    // matching the ABX FS profile.
    shardSplitThresholdBytes: Number.POSITIVE_INFINITY,
  })) {
    last = entry;
    if (entry.path === "" || entry.path === undefined) wrapEntry = entry;
  }
  const chosen = wrapEntry ?? last;
  if (!chosen) throw new Error("importer produced no entries");
  return chosen.cid.toString();
}

function assertCidsMatch(label, ours, theirs) {
  if (ours !== theirs) {
    throw new Error(
      `[fixture-cross-check] ${label}: our CID ${ours} != ipfs-unixfs-importer CID ${theirs}`,
    );
  }
}

async function rawCid(bytes) {
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash);
}

async function dirCid(entries) {
  // entries: [{ name, cid, tsize }]. Must be sorted lex by name (ipfs-unixfs does this itself).
  const links = entries
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => ({ Name: e.name, Hash: e.cid, Tsize: e.tsize }));
  const unixfs = new UnixFS({ type: "directory" });
  const node = dagPB.prepare({ Data: unixfs.marshal(), Links: links });
  const encoded = dagPB.encode(node);
  const hash = await sha256.digest(encoded);
  const cid = CID.createV1(dagPB.code, hash);
  return { cid, encoded };
}

async function main() {
  const raws = [];
  const samples = [
    { name: "empty", text: "" },
    { name: "hello", text: "hello\n" },
    { name: "pangram", text: "The quick brown fox jumps over the lazy dog\n" },
    { name: "zero-byte", hex: "00" },
    { name: "binary", hex: "deadbeefcafebabe0102" },
    { name: "kilobyte", text: "a".repeat(1024) },
  ];

  for (const s of samples) {
    const bytes = s.hex
      ? Buffer.from(s.hex, "hex")
      : Buffer.from(s.text ?? "", "utf8");
    const cid = await rawCid(bytes);
    raws.push({
      name: s.name,
      input_hex: "0x" + bytes.toString("hex"),
      sha256_hex: toHex(sha256Bytes(bytes)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
    });
  }

  writeFileSync(
    new URL("./raw-leaves.json", import.meta.url),
    JSON.stringify(raws, null, 2) + "\n",
  );

  const dagpb = [];

  // Directory A: two small files.
  {
    const aBytes = Buffer.from("alpha");
    const bBytes = Buffer.from("beta");
    const a = await rawCid(aBytes);
    const b = await rawCid(bBytes);
    // Raw-leaf children: cumulative subtree size == own bytes.length.
    const { cid, encoded } = await dirCid([
      { name: "a.txt", cid: a, tsize: aBytes.length },
      { name: "b.txt", cid: b, tsize: bBytes.length },
    ]);
    const reference = await importerRootCid(
      [
        { path: "a.txt", content: aBytes },
        { path: "b.txt", content: bBytes },
      ],
      { wrap: true },
    );
    assertCidsMatch("two-file-dir", cid.toString(), reference);
    dagpb.push({
      name: "two-file-dir",
      entries: [
        { name: "a.txt", cid: a.toString(), size: aBytes.length },
        { name: "b.txt", cid: b.toString(), size: bBytes.length },
      ],
      pbnode_hex: toHex(encoded),
      sha256_hex: toHex(sha256Bytes(encoded)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
    });
  }

  // Directory B: one entry.
  {
    const xBytes = Buffer.from("x");
    const x = await rawCid(xBytes);
    const { cid, encoded } = await dirCid([
      { name: "x", cid: x, tsize: xBytes.length },
    ]);
    const reference = await importerRootCid(
      [{ path: "x", content: xBytes }],
      { wrap: true },
    );
    assertCidsMatch("one-file-dir", cid.toString(), reference);
    dagpb.push({
      name: "one-file-dir",
      entries: [{ name: "x", cid: x.toString(), size: xBytes.length }],
      pbnode_hex: toHex(encoded),
      sha256_hex: toHex(sha256Bytes(encoded)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
    });
  }

  // Directory C: names with dots to prove dag-pb handles them.
  {
    const pkgBytes = Buffer.from('{"name":"demo"}');
    const readmeBytes = Buffer.from("# Demo\n");
    const gitignoreBytes = Buffer.from("node_modules\n");
    const pkg = await rawCid(pkgBytes);
    const readme = await rawCid(readmeBytes);
    const gitignore = await rawCid(gitignoreBytes);
    const { cid, encoded } = await dirCid([
      { name: ".gitignore", cid: gitignore, tsize: gitignoreBytes.length },
      { name: "README.md", cid: readme, tsize: readmeBytes.length },
      { name: "package.json", cid: pkg, tsize: pkgBytes.length },
    ]);
    const reference = await importerRootCid(
      [
        { path: ".gitignore", content: gitignoreBytes },
        { path: "README.md", content: readmeBytes },
        { path: "package.json", content: pkgBytes },
      ],
      { wrap: true },
    );
    assertCidsMatch("dotted-names-dir", cid.toString(), reference);
    dagpb.push({
      name: "dotted-names-dir",
      entries: [
        { name: ".gitignore", cid: gitignore.toString(), size: gitignoreBytes.length },
        { name: "README.md", cid: readme.toString(), size: readmeBytes.length },
        { name: "package.json", cid: pkg.toString(), size: pkgBytes.length },
      ],
      pbnode_hex: toHex(encoded),
      sha256_hex: toHex(sha256Bytes(encoded)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
    });
  }

  // Directory D: nested (contains a subdirectory). Tests the cumulative-Tsize rule:
  // the inner sub-directory's PBLink.Tsize MUST be inner.encoded.length + sum(inner
  // children Tsize) — *not* just inner.encoded.length. Pre-fix the buggy fixture used
  // inner.encoded.length and produced a CID Kubo did not recognize.
  {
    const leafBytes = Buffer.from("leaf");
    const leaf = await rawCid(leafBytes);
    const inner = await dirCid([
      { name: "l.txt", cid: leaf, tsize: leafBytes.length },
    ]);
    const innerCumulative = inner.encoded.length + leafBytes.length;
    const { cid, encoded } = await dirCid([
      { name: "inner", cid: inner.cid, tsize: innerCumulative },
    ]);
    const reference = await importerRootCid(
      [{ path: "inner/l.txt", content: leafBytes }],
      { wrap: true },
    );
    assertCidsMatch("nested-dir", cid.toString(), reference);
    dagpb.push({
      name: "nested-dir",
      entries: [
        {
          name: "inner",
          cid: inner.cid.toString(),
          size: innerCumulative,
          is_directory: true,
        },
      ],
      inner_cid: inner.cid.toString(),
      inner_pbnode_hex: toHex(inner.encoded),
      pbnode_hex: toHex(encoded),
      sha256_hex: toHex(sha256Bytes(encoded)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
    });
  }

  writeFileSync(
    new URL("./dag-pb-nodes.json", import.meta.url),
    JSON.stringify(dagpb, null, 2) + "\n",
  );

  // Multi-block file fixtures: files > 256KB split into raw-leaf chunks, stitched by a dag-pb
  // root whose UnixFS Data message carries blocksizes. Matches go-ipfs/js-ipfs canonical output
  // exactly when using the ABX FS profile (raw leaves, 256KB chunks, balanced DAG, max 174 links).
  const MB = 262144;
  const multiBlockFiles = [];

  async function multiBlockFile({ name, bytes }) {
    const chunks = [];
    const blocksizes = [];
    for (let off = 0; off < bytes.length; off += MB) {
      chunks.push(bytes.subarray(off, Math.min(off + MB, bytes.length)));
    }
    const chunkCids = await Promise.all(chunks.map(rawCid));
    const links = chunks.map((c, i) => ({
      Name: "",
      Hash: chunkCids[i],
      Tsize: c.length,
    }));
    for (const c of chunks) blocksizes.push(c.length);

    // Hand-build the UnixFS Data message: Type(1)=File(2), filesize(3), blocksizes(4, repeated).
    const encodeVarint = (n) => {
      let bn = BigInt(n);
      const out = [];
      while (bn >= 128n) {
        out.push(Number((bn & 0x7fn) | 0x80n));
        bn >>= 7n;
      }
      out.push(Number(bn));
      return Buffer.from(out);
    };
    let unixfsData = Buffer.concat([
      Buffer.from([0x08]),
      encodeVarint(2),
      Buffer.from([0x18]),
      encodeVarint(bytes.length),
    ]);
    for (const bs of blocksizes) {
      unixfsData = Buffer.concat([unixfsData, Buffer.from([0x20]), encodeVarint(bs)]);
    }
    const node = dagPB.prepare({ Data: unixfsData, Links: links });
    const encoded = dagPB.encode(node);
    const hash = await sha256.digest(encoded);
    const cid = CID.createV1(dagPB.code, hash);

    // Cross-check against ipfs-unixfs-importer (Kubo-canonical).
    const reference = await importerRootCid(
      [{ path: name, content: bytes }],
      { wrap: false },
    );
    assertCidsMatch(`multi-block-file:${name}`, cid.toString(), reference);

    return {
      name,
      size: bytes.length,
      num_chunks: chunks.length,
      chunk_sizes: blocksizes,
      chunk_cids: chunkCids.map((c) => c.toString()),
      pbnode_hex: toHex(encoded),
      sha256_hex: toHex(sha256Bytes(encoded)),
      cid: cid.toString(),
      cid_bytes_hex: toHex(cid.bytes),
      // Not emitting bytes_hex for >1MB; tests regenerate input bytes deterministically.
      input_seed: name,
    };
  }

  const deterministicBytes = (len, seed) => {
    const out = Buffer.alloc(len);
    // LCG in uint32 space. Use BigInt to match Solidity's uint32 wrapping exactly;
    // plain JS numbers lose precision above 2^53 during the multiply.
    const MASK = 0xffffffffn;
    let state = 0n;
    for (let i = 0; i < seed.length; i++) {
      state = (state * 31n + BigInt(seed.charCodeAt(i))) & MASK;
    }
    for (let i = 0; i < len; i++) {
      state = (state * 1103515245n + 12345n) & MASK;
      out[i] = Number(state & 0xffn);
    }
    return out;
  };

  multiBlockFiles.push(
    await multiBlockFile({
      name: "two-chunk-file",
      bytes: deterministicBytes(MB + 1024, "two-chunk-file"),
    }),
  );
  multiBlockFiles.push(
    await multiBlockFile({
      name: "three-chunk-file",
      bytes: deterministicBytes(MB * 2 + 5000, "three-chunk-file"),
    }),
  );

  writeFileSync(
    new URL("./multi-block-files.json", import.meta.url),
    JSON.stringify(multiBlockFiles, null, 2) + "\n",
  );

  // Varint test vectors.
  const varintSamples = [
    0, 1, 127, 128, 255, 256, 16383, 16384, 2097151, 2147483647, 4294967295,
    1_000_000_000_000n,
  ].map((n) => BigInt(n));

  const encodeVarint = (nBig) => {
    let n = BigInt(nBig);
    const out = [];
    while (n >= 128n) {
      out.push(Number((n & 0x7fn) | 0x80n));
      n >>= 7n;
    }
    out.push(Number(n));
    return "0x" + out.map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const varints = varintSamples.map((v) => ({
    value: v.toString(),
    encoded_hex: encodeVarint(v),
  }));
  writeFileSync(
    new URL("./varints.json", import.meta.url),
    JSON.stringify(varints, null, 2) + "\n",
  );

  console.log(`Wrote ${raws.length} raw-leaves, ${dagpb.length} dag-pb, ${varints.length} varints fixtures.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
