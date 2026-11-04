#!/usr/bin/env node
// Generate a nested-directory-with-chunked-file fixture for IpfsCidResolver end-to-end
// testing. The fixture pins down the exact case the user hit pre-fix: a sub-directory
// containing a > 256 KiB file. Pre-fix the resolver emitted the immediate sub-tree
// block size as `PBLink.Tsize`, producing CIDs Kubo did not recognize.
//
// All CIDs are computed by `ipfs-unixfs-importer` (the canonical JS reference,
// byte-identical with Kubo for the ABX FS profile). The Solidity tests must produce the
// exact same root CID for the same inputs.
//
// Run: node generate-nested-chunked.mjs

import { writeFileSync } from "node:fs";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";

const IPFS_CHUNK_SIZE = 262_144;

const toHex = (bytes) =>
  "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Deterministic byte stream. Matches the LCG used by `BaseCompanionTest.deterministicBytes`
 * in Solidity (state = state*31 + ch for seed; state = state*1103515245 + 12345 for body).
 */
function deterministicBytes(length, seed) {
  const MASK = 0xffffffffn;
  let state = 0n;
  for (let i = 0; i < seed.length; i++) {
    state = (state * 31n + BigInt(seed.charCodeAt(i))) & MASK;
  }
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245n + 12345n) & MASK;
    out[i] = Number(state & 0xffn);
  }
  return out;
}

/**
 * Run a list of file inputs through ipfs-unixfs-importer with the ABX FS profile and
 * return all entries (path → CID). When `wrapWithDirectory: true`, the importer emits
 * one entry per file plus one trailing entry with `path === ""` for the wrap directory.
 */
async function runImporter(files, { wrap }) {
  const blockstore = new MemoryBlockstore();
  const out = [];
  for await (const entry of importer(files, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: IPFS_CHUNK_SIZE }),
    wrapWithDirectory: wrap,
    shardSplitThresholdBytes: Number.POSITIVE_INFINITY,
  })) {
    out.push({
      path: entry.path ?? "",
      cid: entry.cid.toString(),
      cidBytes: toHex(entry.cid.bytes),
      // entry.unixfs is undefined for raw-leaf chunks; only present for unixfs nodes.
      unixfs: entry.unixfs?.type,
    });
  }
  return out;
}

async function main() {
  // Case A: root dir contains a 280 KiB chunked file at top level (sanity baseline).
  const flatChunked = deterministicBytes(280 * 1024, "flat-chunked");
  const flatEntries = await runImporter(
    [{ path: "big.bin", content: flatChunked }],
    { wrap: true },
  );

  // Case B: root dir contains a sub-dir which contains a 280 KiB chunked file +
  // a small sibling raw-leaf file. This is the smoking-gun case: pre-fix the outer
  // dir's `sub` PBLink had Tsize = sub.encoded.length (~107 bytes) instead of the
  // cumulative ~287 KB. Equivalent shape to the user's bug repro upload.
  const nestedChunked = deterministicBytes(280 * 1024, "nested-chunked");
  const sibling = Buffer.from("hello from inside the subdirectory\n", "utf8");
  const nestedEntries = await runImporter(
    [
      { path: "root/sub/big.bin", content: nestedChunked },
      { path: "root/sub/note.txt", content: sibling },
    ],
    { wrap: false },
  );
  // Importer wraps inputs based on the highest common path prefix; since our paths
  // start with "root/", the wrap entry is the "root" directory itself (path === "root").

  // Case C: end-to-end shape — root contains a top-level `readme.md` file AND a `sub/`
  // directory which contains a 280 KiB chunked `big.bin`. Targets the IpfsCidResolver
  // smoke test that proves on-chain output == Kubo for a representative project
  // (mixed-depth, mixed-leaf-type tree). Lex-sorted entries on each level so the
  // Solidity test's `makeEntries` ordering matches the importer's directory layout.
  const e2eBig = deterministicBytes(280 * 1024, "e2e-nested-chunked");
  const e2eReadme = Buffer.from("# end-to-end test project\n", "utf8");
  const e2eEntries = await runImporter(
    [
      { path: "proj/readme.md", content: e2eReadme },
      { path: "proj/sub/big.bin", content: e2eBig },
    ],
    { wrap: false },
  );

  const fixture = {
    profile: {
      cid_version: 1,
      raw_leaves: true,
      chunker: "fixed-size",
      chunk_size: IPFS_CHUNK_SIZE,
      max_links: 174,
    },
    flat_chunked: {
      // bytes_b64 omitted; tests regenerate via deterministicBytes.
      file_size: flatChunked.length,
      file_seed: "flat-chunked",
      sibling_seed: null,
      entries: flatEntries,
      // Convenience: pull out the wrap-directory CID so the Solidity test can `assertEq`.
      wrap_cid: flatEntries.find((e) => e.path === "")?.cid ?? null,
    },
    nested_chunked: {
      file_size: nestedChunked.length,
      file_seed: "nested-chunked",
      sibling_text: sibling.toString("utf8"),
      entries: nestedEntries,
      // The "root" entry is what the Solidity test asserts against.
      root_cid: nestedEntries.find((e) => e.path === "root")?.cid ?? null,
      sub_cid: nestedEntries.find((e) => e.path === "root/sub")?.cid ?? null,
      file_cid: nestedEntries.find((e) => e.path === "root/sub/big.bin")?.cid ?? null,
      sibling_cid: nestedEntries.find((e) => e.path === "root/sub/note.txt")?.cid ?? null,
    },
    end_to_end: {
      file_size: e2eBig.length,
      file_seed: "e2e-nested-chunked",
      readme_text: e2eReadme.toString("utf8"),
      entries: e2eEntries,
      root_cid: e2eEntries.find((e) => e.path === "proj")?.cid ?? null,
      sub_cid: e2eEntries.find((e) => e.path === "proj/sub")?.cid ?? null,
      file_cid: e2eEntries.find((e) => e.path === "proj/sub/big.bin")?.cid ?? null,
      readme_cid: e2eEntries.find((e) => e.path === "proj/readme.md")?.cid ?? null,
    },
  };

  writeFileSync(
    new URL("./nested-chunked.json", import.meta.url),
    JSON.stringify(fixture, null, 2) + "\n",
  );

  console.log("Wrote nested-chunked.json");
  console.log(`  flat wrap CID: ${fixture.flat_chunked.wrap_cid}`);
  console.log(`  nested root CID: ${fixture.nested_chunked.root_cid}`);
  console.log(`  nested sub CID: ${fixture.nested_chunked.sub_cid}`);
  console.log(`  end_to_end root CID: ${fixture.end_to_end.root_cid}`);
  console.log(`  end_to_end sub CID: ${fixture.end_to_end.sub_cid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
