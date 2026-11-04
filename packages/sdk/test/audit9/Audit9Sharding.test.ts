/**
 * RS-M1, off-chain half. Kubo (boxo `HAMTShardingSize`, `SizeEstimationLinks`) shards a directory once the sum over
 * EVERY entry of name bytes plus child CID bytes (36 here) is strictly greater than 262,144; `ipfs-unixfs-importer`
 * compares the same sum the same way (it leaves out subdirectories without a CID yet, so it never shards sooner). ABX FS
 * derives flat directories only, so it must derive exactly up to that point and refuse past it, by type.
 */
import * as dagPB from "@ipld/dag-pb";
import { MemoryBlockstore } from "blockstore-core/memory";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { BaseError, encodeErrorResult } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { iIpfsCidResolverAbi } from "../../src/abi.js";
import {
  DirectoryNeedsShardingError,
  IPFS_CHUNK_SIZE,
  IPFS_SHARD_THRESHOLD_BYTES,
  ipfsDirectoryCid,
  ipfsDirectoryEstimate,
  ipfsDirectoryNeedsSharding,
  ipfsFileCid,
} from "../../src/cid.js";
import { clearResolverFailureCache, verifyOnChainIpfsCid } from "../../src/verify.js";
import type { AbxfsCid, ContractAddresses, IpfsCid } from "../../src/types.js";

/** `count` names of `len` bytes (distinct, sorted), plus one more of `lastLen` when given. */
function names(count: number, len: number, lastLen?: number): string[] {
  const out = Array.from({ length: count }, (_, i) => String(i).padStart(5, "0") + "n".repeat(len - 5));
  if (lastLen !== undefined) out.push("z" + "m".repeat(lastLen - 1));
  return out;
}

async function importerRoot(files: string[], content: Uint8Array): Promise<string> {
  const store = new MemoryBlockstore();
  let root = "";
  for await (const e of importer(files.map((n) => ({ path: n, content })), store, {
    cidVersion: 1,
    rawLeaves: true,
    chunker: fixedSize({ chunkSize: IPFS_CHUNK_SIZE }),
    wrapWithDirectory: true,
  })) {
    if (e.path === "" || e.path === undefined) root = e.cid.toString();
  }
  return root;
}

describe("the shard threshold", () => {
  it("counts name bytes plus 36 per entry and compares strictly", () => {
    expect(IPFS_SHARD_THRESHOLD_BYTES).toBe(262_144);
    // 900 x (255 + 36) = 261,900; one more 208-byte name makes exactly 262,144, a 209-byte one 262,145.
    const at = names(900, 255, 208).map((name) => ({ name }));
    const over = names(900, 255, 209).map((name) => ({ name }));
    expect(ipfsDirectoryEstimate(at)).toBe(262_144);
    expect(ipfsDirectoryNeedsSharding(at)).toBe(false);
    expect(ipfsDirectoryEstimate(over)).toBe(262_145);
    expect(ipfsDirectoryNeedsSharding(over)).toBe(true);
    // The auditor's vectors: 900 x 255-byte names are flat, 901 are not.
    expect(ipfsDirectoryNeedsSharding(names(900, 255).map((name) => ({ name })))).toBe(false);
    expect(ipfsDirectoryEstimate(names(901, 255).map((name) => ({ name })))).toBe(262_191);
    expect(ipfsDirectoryNeedsSharding(names(901, 255).map((name) => ({ name })))).toBe(true);
    // Name BYTES, not UTF-16 units: 100,000 of an astral character would read as 200,000.
    expect(ipfsDirectoryEstimate([{ name: "🌍" }])).toBe(4 + 36);
  });

  it("exactly 262,144 derives the flat CID the importer produces; 262,145 is refused where the importer shards", async () => {
    const content = new TextEncoder().encode("x");
    const leaf = (await ipfsFileCid(content)) as IpfsCid;
    const derive = (ns: string[]) => ipfsDirectoryCid(ns.map((name) => ({ name, cid: leaf, tsize: content.length })));

    const at = names(900, 255, 208);
    expect((await derive(at)).cid).toBe(await importerRoot(at, content));

    const over = names(900, 255, 209);
    const err = await derive(over).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DirectoryNeedsShardingError);
    expect((err as DirectoryNeedsShardingError).estimate).toBe(262_145);
    // And the importer did shard it: its root is not the flat directory of the same links.
    const flat = dagPB.encode(
      dagPB.prepare({ Data: new UnixFS({ type: "directory" }).marshal(), Links: over.map((Name) => ({ Name, Hash: CID.parse(leaf), Tsize: 1 })) }),
    );
    const flatCid = CID.createV1(dagPB.code, await sha256.digest(flat)).toString();
    expect(await importerRoot(over, content)).not.toBe(flatCid);
  }, 120_000);
});

describe("the on-chain resolver's refusal is typed, and never a reason to derive locally", () => {
  afterEach(() => clearResolverFailureCache());
  const dirCid = `0x${"32".repeat(32)}` as AbxfsCid;
  const addresses = {
    chunkStore: "0x00000000000000000000000000000000000000c1",
    fileStore: "0x00000000000000000000000000000000000000f1",
    directoryStore: "0x00000000000000000000000000000000000000d1",
    sstore2Backend: "0x00000000000000000000000000000000000000b1",
    fastLzBackend: "0x00000000000000000000000000000000000000b2",
    ipfsCidResolver: "0x00000000000000000000000000000000000000e1",
  } as ContractAddresses;

  it("DirectoryNeedsSharding decodes to DirectoryNeedsShardingError, by type, and is remembered", async () => {
    let calls = 0;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => functionName === "directoryExists",
      call: async () => {
        calls++;
        const data = encodeErrorResult({ abi: iIpfsCidResolverAbi, errorName: "DirectoryNeedsSharding", args: [dirCid, 262_191n] });
        throw new BaseError("execution reverted", { cause: Object.assign(new Error("execution reverted"), { data }) });
      },
    };
    const first = await verifyOnChainIpfsCid(client as never, addresses, dirCid).then(() => undefined, (e: unknown) => e);
    expect(first).toBeInstanceOf(DirectoryNeedsShardingError);
    expect((first as DirectoryNeedsShardingError).estimate).toBe(262_191);
    await expect(verifyOnChainIpfsCid(client as never, addresses, dirCid)).rejects.toBeInstanceOf(DirectoryNeedsShardingError);
    expect(calls).toBe(1);
  });
});
