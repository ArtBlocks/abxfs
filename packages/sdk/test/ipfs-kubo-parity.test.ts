/**
 * Parity tests: assert that our locally-computed IPFS CIDs (file + nested directory)
 * match what `ipfs-unixfs-importer` produces for the same content. The importer is the
 * canonical JS implementation that Kubo's `ipfs add` is bit-identical with for the
 * ABX FS profile (cid-version=1, chunker=size-262144, raw-leaves=true, sha2-256), so
 * passing parity here = passing parity against a real Kubo node.
 *
 * Why these tests exist: prior to commit X, we hard-coded `Tsize: 0` for sub-directory
 * links and `Tsize: c.serializedSize` (instead of cumulative) for inner dag-pb file
 * wraps. Both are part of the protobuf-encoded bytes, so wrong Tsize → wrong parent
 * CID → pin verification fails against Kubo → gateway returns
 * `"directory ... has no IPFS mapping (not pinned or verified)"`. This file pins down
 * the contract so the regression cannot recur silently.
 */
import { describe, expect, it } from "vitest";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer, type ImportCandidate } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";

import {
  ipfsDirectoryCid,
  ipfsFileCid,
  ipfsFileCidWithSize,
  IPFS_CHUNK_SIZE,
} from "../src/cid.js";
import type { IpfsCid } from "../src/types.js";

/**
 * Run `ipfs-unixfs-importer` over the given inputs with the ABX FS profile and return the
 * root CID. The importer emits one entry per file/dir and yields a final wrap-directory
 * entry whose path is "" (empty) — that's the root we care about. Falls back to the
 * last-emitted entry if no empty-path entry exists (single-file imports).
 */
async function importerRoot(
  candidates: ImportCandidate[],
  opts: { wrap: boolean },
): Promise<string> {
  const blockstore = new MemoryBlockstore();
  let last: { cid: { toString(): string }; path?: string } | undefined;
  let wrap: { cid: { toString(): string }; path?: string } | undefined;
  for await (const entry of importer(candidates, blockstore, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: IPFS_CHUNK_SIZE }),
    wrapWithDirectory: opts.wrap,
  })) {
    last = entry;
    if (entry.path === "" || entry.path === undefined) wrap = entry;
  }
  const chosen = wrap ?? last;
  if (!chosen) throw new Error("importer produced no entries");
  return chosen.cid.toString();
}

describe("IPFS CID parity with ipfs-unixfs-importer (Kubo-equivalent)", () => {
  it("single-block raw-leaf file", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const ours = await ipfsFileCid(bytes);
    const reference = await importerRoot(
      [{ path: "f", content: bytes }],
      { wrap: false },
    );
    expect(ours).toBe(reference);
  });

  it("multi-chunk file (single-level dag-pb wrap)", async () => {
    // 600KB → 3 chunks of 256KB → wrapped under one dag-pb root with 3 raw-leaf links.
    const bytes = new Uint8Array(600 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const ours = await ipfsFileCid(bytes);
    const reference = await importerRoot(
      [{ path: "f", content: bytes }],
      { wrap: false },
    );
    expect(ours).toBe(reference);
  });

  it("ipfsFileCidWithSize.tsize matches the importer's parent Tsize", async () => {
    // Embed two files in a wrap directory and check that the wrap CID matches when we
    // build it manually with our reported tsizes. If our tsize is wrong the wrap CID
    // diverges. Tests both raw-leaf (small) and dag-pb (chunked) file branches.
    const small = new TextEncoder().encode("tiny");
    const big = new Uint8Array(600 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;

    const smallSized = await ipfsFileCidWithSize(small);
    const bigSized = await ipfsFileCidWithSize(big);

    const sortedEntries = [
      { name: "a-small", cid: smallSized.cid, tsize: smallSized.tsize },
      { name: "z-big", cid: bigSized.cid, tsize: bigSized.tsize },
    ].sort((a, b) => (a.name < b.name ? -1 : 1));

    const ours = (await ipfsDirectoryCid(sortedEntries)).cid;
    const reference = await importerRoot(
      [
        { path: "a-small", content: small },
        { path: "z-big", content: big },
      ],
      { wrap: true },
    );
    expect(ours).toBe(reference);
  });

  it("nested directory tree (the original bug repro)", async () => {
    // Mirrors the user's failing upload: a top-level dir containing files AND a
    // sub-directory that itself contains a file. Pre-fix, our `tsize: 0` for the
    // `subdir` link in the parent diverged from Kubo's cumulative value here.
    const helloBytes = new TextEncoder().encode("hello world");
    const utilBytes = new TextEncoder().encode("export const v = 1;\n");
    const nestedBytes = new TextEncoder().encode("deeply nested");

    const helloSized = await ipfsFileCidWithSize(helloBytes);
    const utilSized = await ipfsFileCidWithSize(utilBytes);
    const nestedSized = await ipfsFileCidWithSize(nestedBytes);

    // Build the inner-most dir: lib/inner/{nested.txt}
    const innerDir = await ipfsDirectoryCid([
      { name: "nested.txt", cid: nestedSized.cid, tsize: nestedSized.tsize },
    ]);
    // Build lib/{util.js, inner/}
    const libEntries = [
      { name: "inner", cid: innerDir.cid, tsize: innerDir.encoded.length + nestedSized.tsize },
      { name: "util.js", cid: utilSized.cid, tsize: utilSized.tsize },
    ];
    const libDir = await ipfsDirectoryCid(libEntries);
    const libCumulative =
      libDir.encoded.length +
      libEntries.reduce((acc, e) => acc + e.tsize, 0);

    // Build top: {hello.txt, lib/}
    const topEntries = [
      { name: "hello.txt", cid: helloSized.cid, tsize: helloSized.tsize },
      { name: "lib", cid: libDir.cid, tsize: libCumulative },
    ];
    const ours = (await ipfsDirectoryCid(topEntries)).cid as IpfsCid;

    const reference = await importerRoot(
      [
        { path: "hello.txt", content: helloBytes },
        { path: "lib/util.js", content: utilBytes },
        { path: "lib/inner/nested.txt", content: nestedBytes },
      ],
      { wrap: true },
    );
    expect(ours).toBe(reference);
  });
});
