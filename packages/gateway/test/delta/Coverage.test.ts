/**
 * DELTA AUDIT: branches of the fix round that no test exercised, each now driven on purpose.
 *
 *  - mirror: the per-root entry budget refusing as a directory read throws (both messages), a read error that is not
 *    a limit, a listing past the budget, and the skip of a root the pinning step refuses as needing a sharded form
 *    (`DirectoryNeedsShardingError`, and `DirectoryTooLargeForFlatIpfsError` by name);
 *  - the mirror's `--max-*` flag parser.
 */
import { describe, expect, it, vi } from "vitest";

const dirs = vi.hoisted(() => ({
  /** cid -> what readDirectory does with it */
  behaviour: new Map<string, "limit" | "boom" | { entries: number }>(),
}));

vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
  return {
    ...real,
    fileChunkCount: async () => 1,
    readDirectory: async (_c: unknown, _a: unknown, cid: string, opts: { maxEntries?: number } = {}) => {
      const b = dirs.behaviour.get(cid);
      if (b === "limit") throw new real.LimitExceededError("nodes", opts.maxEntries ?? 0, `directory ${cid}`);
      if (b === "boom") throw new Error("HTTP request failed");
      const n = typeof b === "object" ? b.entries : 0;
      // Ignores maxEntries on purpose: the walk must still refuse a listing longer than its budget.
      return { cid, entries: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, cid: `0x31${i.toString(16).padStart(62, "0")}`, isDirectory: false })) };
    },
  };
});

import { DirectoryNeedsShardingError, ProjectKind, type AbxfsCid } from "@abxfs/sdk";

import { RootTooLargeError, assessRoot, memoryCursor, parsePositiveFlag, runMirror } from "../../src/mirror.js";
import type { GatewayChain } from "../../src/types.js";

const CHAIN = { id: 84532, contracts: {}, client: {} } as never;
const D = (n: number) => `0x32${n.toString(16).padStart(62, "0")}` as AbxfsCid;

describe("mirror: assessRoot's refusals", () => {
  it("a directory read past the budget is refused, and says which limit: the root's entries, or one directory's", async () => {
    dirs.behaviour.set(D(1), "limit");
    // budget left (100) under maxFiles (20,000): the ROOT's entry budget is what ran out
    const a = await assessRoot(CHAIN, D(1), ProjectKind.Directory, { maxEntriesPerRoot: 100 }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(RootTooLargeError);
    expect((a as Error).message).toBe("more than 100 directory entries to read in one root");
    // budget left at least maxFiles: ONE directory is over the file cap
    const b = await assessRoot(CHAIN, D(1), ProjectKind.Directory, { maxFilesPerRoot: 50, maxEntriesPerRoot: 1_000 }).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(RootTooLargeError);
    expect((b as Error).message).toBe("a directory with more than 50 entries");
  });

  it("a read error that is not a limit is thrown as it is (retried by the loop, never skipped as too large)", async () => {
    dirs.behaviour.set(D(2), "boom");
    const err = await assessRoot(CHAIN, D(2), ProjectKind.Directory).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RootTooLargeError);
    expect((err as Error).message).toBe("HTTP request failed");
  });

  it("a listing longer than the budget left is refused even when the reader did not stop at it", async () => {
    dirs.behaviour.set(D(3), { entries: 30 });
    await expect(assessRoot(CHAIN, D(3), ProjectKind.Directory, { maxEntriesPerRoot: 20, maxFilesPerRoot: 10 })).rejects.toThrow(
      /more than 20 directory entries to read in one root/,
    );
  });
});

describe("mirror: a root IPFS would shard is skipped, not retried", () => {
  const ORG = "0x00000000000000000000000000000000000000a1";
  function chainWith(cids: AbxfsCid[]): GatewayChain {
    return {
      id: 84532,
      contracts: { orgFactory: "0x00000000000000000000000000000000000000c0", projectHook: "0x00000000000000000000000000000000000000c1", lens: "0x00000000000000000000000000000000000000c2" } as never,
      client: {
        async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
          if (functionName === "globalPublishCount") return BigInt(cids.length);
          const [start, count] = args as [bigint, bigint];
          return cids.slice(Number(start), Number(start + count)).map((c, k) => ({
            org: ORG,
            record: { cid: c, publisher: ORG, publishedAt: 1, version: 1, tokenId: BigInt(Number(start) + k) },
          }));
        },
      } as never,
    };
  }

  for (const [name, make] of [
    ["DirectoryNeedsShardingError", () => new DirectoryNeedsShardingError(D(9), 300_000)],
    ["DirectoryTooLargeForFlatIpfsError (by name, from @abxfs/pinning)", () => Object.assign(new Error("needs a HAMT"), { name: "DirectoryTooLargeForFlatIpfsError" })],
  ] as const) {
    it(name, async () => {
      const logs: string[] = [];
      let attempts = 0;
      const stats = await runMirror({
        chain: chainWith([D(9), D(9)]),
        provider: {} as never,
        cursor: memoryCursor(),
        once: true,
        pollMs: 1,
        backoffMs: () => 0,
        log: (l) => logs.push(l),
        pinRoot: async () => {
          attempts++;
          throw make();
        },
      });
      expect(attempts).toBe(1); // not retried, and the second publish of the same root is not tried again
      expect(stats).toEqual({ pinned: 0, skipped: 2, next: 2 });
      expect(logs.filter((l) => l.startsWith("SKIPPED (too large"))).toHaveLength(1);
    });
  }
});

describe("the mirror's --max-* flags", () => {
  it("absent, or a positive whole number in its plain spelling", () => {
    expect(parsePositiveFlag("max-entries-per-root", undefined)).toBeUndefined();
    expect(parsePositiveFlag("max-entries-per-root", "100000")).toBe(100_000);
    for (const bad of ["0", "-1", "1.5", "1e4", "abc", "", " ", "0x10", String(2 ** 53)]) {
      expect(() => parsePositiveFlag("max-entries-per-root", bad), bad).toThrow("--max-entries-per-root must be a positive integer");
    }
  });
});
