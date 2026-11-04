/**
 * Client resource caps (audit M10) and bounded history reads (audit F4's client half).
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { flzCompress, flzDecompress } from "../src/fastlz.js";
import { LimitExceededError, TraversalBudget } from "../src/limits.js";
import { walkDirectory, walkDirectoryTree } from "../src/read.js";
import { autoRegisterNodeCodecs, getFileCodec, CODEC_GZIP } from "../src/compression.js";
import { registerWebCodecs } from "../src/web-codecs.js";
import {
  HISTORY_PAGE_SIZE,
  readTagPage,
  readVersionHistory,
  readVersionHistoryPage,
} from "../src/project.js";
import { readOrgsHeld } from "../src/org.js";
import { verifyOnChainIpfsCid, clearResolverFailureCache } from "../src/verify.js";
import type { AbxfsCid } from "../src/index.js";

const c = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as AbxfsCid;

/** A full address book: every read goes through `contentStores`, which refuses a partial one. */
const STORES = {
  chunkStore: "0x0000000000000000000000000000000000000c57",
  fileStore: "0x0000000000000000000000000000000000000f57",
  directoryStore: "0x0000000000000000000000000000000000000d57",
} as never;

/** A client whose directories are `listing(cid)`, read as the store pages them: `entryCount`, then `getEntries`. */
function dirClient(listing: (cid: AbxfsCid) => Array<{ name: string; cid: AbxfsCid; isDirectory: boolean }>, onRead: (cid: AbxfsCid) => void) {
  return {
    async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid, bigint?, bigint?] }) {
      const list = listing(args[0]);
      if (functionName === "entryCount") {
        onRead(args[0]);
        return BigInt(list.length);
      }
      if (functionName === "getEntries") return list.slice(Number(args[1]), Number(args[2]));
      throw new Error(`unscripted ${functionName}`);
    },
  } as never;
}

describe("walkDirectory on a shared-sub-DAG bomb", () => {
  // Depth-D chain where every level lists the next level TWICE. Walked as a tree that is 2^D leaves;
  // with memoised directory reads it is D+1 reads, and the emitted-file count hits the node cap.
  function bombClient(depth: number) {
    const reads: string[] = [];
    const client = dirClient(
      (cid) => {
        const level = Number(BigInt(cid));
        if (level === depth) return [{ name: "leaf", cid: c(1000), isDirectory: false }];
        return [
          { name: "a", cid: c(level + 1), isDirectory: true },
          { name: "b", cid: c(level + 1), isDirectory: true },
        ];
      },
      (cid) => reads.push(cid),
    );
    return { client, reads };
  }
  const addresses = STORES;

  it("reads each distinct directory once", async () => {
    const { client, reads } = bombClient(10);
    const files = await walkDirectory(client, addresses, c(0));
    expect(files).toHaveLength(2 ** 10);
    expect(reads).toHaveLength(11);
  });

  it("fails with a clear error instead of emitting 2^40 paths", async () => {
    const { client, reads } = bombClient(40);
    await expect(walkDirectory(client, addresses, c(0), { maxNodes: 5000 })).rejects.toThrow(LimitExceededError);
    expect(reads.length).toBeLessThanOrEqual(41);
  });
});

describe("walkDirectory on a directories-only bomb", () => {
  it("is linear, not 2^depth, when nothing is emitted", async () => {
    let reads = 0;
    const client = dirClient(
      (cid) => {
        const level = Number(BigInt(cid));
        return level >= 60
          ? []
          : [
              { name: "a", cid: c(level + 1), isDirectory: true },
              { name: "b", cid: c(level + 1), isDirectory: true },
            ];
      },
      () => reads++,
    );
    const files = await walkDirectory(client, STORES, c(0));
    expect(files).toEqual([]);
    expect(reads).toBe(61);
  });

  /** The same DAG has 2^60 paths to an empty directory: listing them is refused by the node budget, not attempted. */
  it("walkDirectoryTree, which lists every empty directory by path, stops at the node budget", async () => {
    let reads = 0;
    const client = dirClient(
      (cid) => {
        const level = Number(BigInt(cid));
        return level >= 60
          ? []
          : [
              { name: "a", cid: c(level + 1), isDirectory: true },
              { name: "b", cid: c(level + 1), isDirectory: true },
            ];
      },
      () => reads++,
    );
    await expect(walkDirectoryTree(client, STORES, c(0), { maxNodes: 10_000 })).rejects.toBeInstanceOf(LimitExceededError);
    expect(reads).toBeLessThanOrEqual(61);
  });
});

describe("TraversalBudget", () => {
  it("caps nodes and bytes with a readable message", () => {
    const b = new TraversalBudget({ maxNodes: 2, maxBytes: 10 });
    b.node();
    b.node();
    expect(() => b.node()).toThrow(/2 nodes/);
    expect(() => b.addBytes(11)).toThrow(/10 bytes/);
  });
});

describe("inflate caps", () => {
  it("fastlz refuses to inflate past the cap and rejects malformed streams", () => {
    const big = new Uint8Array(1_000_000).fill(7);
    const packed = flzCompress(big);
    expect(flzDecompress(packed)).toEqual(big);
    expect(() => flzDecompress(packed, 1000)).toThrow(/exceeds 1000/);
    // back-reference with nothing before it
    expect(() => flzDecompress(Uint8Array.from([0x20, 0x00]))).toThrow(/before start/);
    // literal run longer than the input
    expect(() => flzDecompress(Uint8Array.from([0x1f, 1, 2]))).toThrow(/truncated/);
    // truncated back-reference
    expect(() => flzDecompress(Uint8Array.from([0x00, 0x41, 0x20]))).toThrow(/truncated/);
  });

  it("gzip (node codec) aborts at the cap", async () => {
    await autoRegisterNodeCodecs();
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(5_000_000)));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(getFileCodec(CODEC_GZIP).decode(bomb, { maxOutputBytes: 100_000 })).rejects.toThrow();
    const ok = await getFileCodec(CODEC_GZIP).decode(bomb, { maxOutputBytes: 6_000_000 });
    expect(ok.length).toBe(5_000_000);
  });

  it("gzip (web streams codec) aborts at the cap, streaming", async () => {
    registerWebCodecs();
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(5_000_000)));
    await expect(getFileCodec(CODEC_GZIP).decode(bomb, { maxOutputBytes: 100_000 })).rejects.toThrow(
      /exceeds 100000/,
    );
  });
});

describe("bounded history reads", () => {
  function hookClient(total: number) {
    const ranges: [number, number][] = [];
    const client = {
      async readContract(a: { functionName: string; args: unknown[] }) {
        if (a.functionName === "versionCount" || a.functionName === "tagCount") return BigInt(total);
        if (a.functionName === "versionsRange") {
          const [s, e] = [Number(a.args[2]), Number(a.args[3])];
          ranges.push([s, e]);
          return Array.from({ length: e - s }, (_, i) => ({ cid: c(s + i), publishedAt: 1, publisher: "0x" + "1".repeat(40) }));
        }
        if (a.functionName === "getTagsRange") {
          const [s, e] = [Number(a.args[2]), Number(a.args[3])];
          ranges.push([s, e]);
          return Array.from({ length: e - s }, (_, i) => `t${s + i}`);
        }
        throw new Error("unexpected " + a.functionName);
      },
    };
    return { client: client as never, ranges };
  }
  const contracts = { collection: "0x00000000000000000000000000000000000000c1", hook: "0x00000000000000000000000000000000000000c2" } as never;

  it("returns only the newest page of a huge history, never the whole range", async () => {
    const { client, ranges } = hookClient(30_000);
    const v = await readVersionHistory(client, contracts, 1n);
    expect(v).toHaveLength(HISTORY_PAGE_SIZE);
    expect(v[v.length - 1]!.version).toBe(30_000);
    expect(ranges).toEqual([[29_800, 30_000]]);
  });

  it("an explicit window is clamped to the page size", async () => {
    const { client, ranges } = hookClient(30_000);
    await readVersionHistory(client, contracts, 1n, { start: 0, end: 30_000 });
    expect(ranges).toEqual([[0, HISTORY_PAGE_SIZE]]);
  });

  it("pages backwards with a cursor until the first version", async () => {
    const { client } = hookClient(450);
    const p1 = await readVersionHistoryPage(client, contracts, 1n);
    expect(p1.versions.map((v) => v.version)[0]).toBe(251);
    expect(p1.nextBefore).toBe(250);
    const p2 = await readVersionHistoryPage(client, contracts, 1n, { before: p1.nextBefore! });
    expect(p2.versions[0]!.version).toBe(51);
    const p3 = await readVersionHistoryPage(client, contracts, 1n, { before: p2.nextBefore! });
    expect(p3.versions).toHaveLength(50);
    expect(p3.nextBefore).toBeNull();
  });

  it("pages tags through tagCount + getTagsRange", async () => {
    const { client, ranges } = hookClient(1000);
    const page = await readTagPage(client, contracts, 1n);
    expect(page.tags).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page.total).toBe(1000);
    expect(ranges).toEqual([[800, 1000]]);
  });

  it("orgsHeld is read in slices of 200, not one unbounded call", async () => {
    const calls: [bigint, bigint][] = [];
    const client = {
      async readContract(a: { functionName: string; args: unknown[] }) {
        if (a.functionName === "orgsHeldCount") return 450n;
        calls.push([a.args[1] as bigint, a.args[2] as bigint]);
        const start = Number(a.args[1]);
        return Array.from({ length: Math.min(200, 450 - start) }, (_, i) => `0x${(start + i).toString(16).padStart(40, "0")}`);
      },
    };
    const orgs = await readOrgsHeld(client as never, "0x00000000000000000000000000000000000000e1", "0x00000000000000000000000000000000000a11ce");
    expect(orgs).toHaveLength(450);
    expect(calls).toEqual([[0n, 200n], [200n, 200n], [400n, 200n]]);
  });
});

describe("resolver calls", () => {
  const addresses = {
    chunkStore: "0x00000000000000000000000000000000000000c1",
    fileStore: "0x00000000000000000000000000000000000000f1",
    directoryStore: "0x00000000000000000000000000000000000000d1",
    ipfsCidResolver: "0x00000000000000000000000000000000000000e5",
  } as never;

  it("carries an explicit gas limit and remembers a failure for the session", async () => {
    clearResolverFailureCache();
    const gases: (bigint | undefined)[] = [];
    let calls = 0;
    const client = {
      async readContract() {
        return false;
      },
      async call(a: { gas?: bigint }) {
        calls++;
        gases.push(a.gas);
        throw new Error("out of gas");
      },
    } as never;
    await expect(verifyOnChainIpfsCid(client, addresses, c(5))).rejects.toThrow(/out of gas/);
    await expect(verifyOnChainIpfsCid(client, addresses, c(5))).rejects.toThrow(/already failed/);
    expect(calls).toBe(1);
    expect(gases[0]).toBeGreaterThan(0n);
    expect(gases[0]).toBeLessThanOrEqual(50_000_000n);
    clearResolverFailureCache();
  });
});
