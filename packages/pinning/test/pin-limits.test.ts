/**
 * Resource caps on pinning (audit M10), against a fake client so no chain is needed.
 * A directory DAG where every level lists the next TWICE is 2^depth leaves as a tree; with memoised
 * reads it is depth+1 directory reads.
 */
import { describe, expect, it } from "vitest";
import { IPFS_SHARD_THRESHOLD_BYTES, LimitExceededError, type AbxfsCid, type AbxfsClient } from "@artblocks/abxfs-sdk";

import { DirectoryTooLargeForFlatIpfsError, pinDirectory } from "../src/pin.js";
import type { PinningProvider } from "../src/types.js";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;
const STORES = {
  chunkStore: "0x0000000000000000000000000000000000000c57",
  directoryStore: "0x0000000000000000000000000000000000000d57",
  fileStore: "0x0000000000000000000000000000000000000f1e",
};

function fakeClient(depth: number) {
  const reads: string[] = [];
  const client = {
    addresses: STORES,
    publicClient: {
      // `entryCount` once per directory visited, then `getEntries` for its one page.
      async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid] }) {
        const level = Number(BigInt(args[0]));
        const entries =
          level >= depth
            ? []
            : [
                { name: "a", cid: c(level + 1), isDirectory: true },
                { name: "b", cid: c(level + 1), isDirectory: true },
              ];
        if (functionName === "entryCount") {
          reads.push(args[0]);
          return BigInt(entries.length);
        }
        return entries;
      },
    },
  };
  return { client: client as unknown as AbxfsClient, reads };
}

function provider(onUpload?: () => void): PinningProvider {
  return {
    name: "mock",
    async pinCar({ root }) {
      onUpload?.();
      return { pinnedCid: root };
    },
    async unpin() {},
    async isPinned() {
      return true;
    },
  };
}

describe("pinning limits", () => {
  /** The bottom of this DAG is an empty directory, which pins like any other. */
  it("visits a shared sub-DAG once instead of 2^depth times", async () => {
    const { client, reads } = fakeClient(30);
    const result = await pinDirectory({ client, directoryCid: c(0), provider: provider() });
    expect(result.verified).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(31);
    expect(result.blockCount).toBe(31); // one directory block per level
  });

  it("fails with a clear limit error past maxNodes", async () => {
    const { client } = fakeClient(30);
    await expect(
      pinDirectory({ client, directoryCid: c(0), provider: provider(), limits: { maxNodes: 10 } }),
    ).rejects.toThrow(LimitExceededError);
  });

  it("refuses a directory whose flat IPFS block would pass the safe size, before reading any file", async () => {
    const reads: string[] = [];
    const entries = Array.from({ length: 30_000 }, (_, i) => ({ name: `file-${String(i).padStart(8, "0")}.txt`, cid: c(i + 1), isDirectory: false }));
    const client = {
      addresses: STORES,
      publicClient: {
        // The listing is `entryCount` plus `getEntries` pages; any other call would be a file read.
        async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid, bigint?, bigint?] }) {
          if (functionName === "getEntries") return entries.slice(Number(args[1]), Number(args[2]));
          reads.push(args[0]);
          return BigInt(entries.length);
        },
      },
    } as unknown as AbxfsClient;
    let uploaded = false;
    const err = await pinDirectory({ client, directoryCid: c(0), provider: provider(() => (uploaded = true)) }).catch((e) => e);
    expect(err).toBeInstanceOf(DirectoryTooLargeForFlatIpfsError);
    expect(err.message).toMatch(/Nothing was pinned/);
    expect(err.blockBytes).toBeGreaterThan(IPFS_SHARD_THRESHOLD_BYTES);
    expect(reads).toEqual([c(0)]); // the listing only: no file was read
    expect(uploaded).toBe(false);
  });
});
