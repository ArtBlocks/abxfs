/**
 * The state-backed publish feed.
 *
 * The ledger is raw history — a project that republishes appears once per publish — so turning it
 * into "the N most recently active projects" means reading back and deduping. That loop is the only
 * real logic on the client side, and it is where the old log-based version went wrong: its early
 * exit waited for N distinct projects, so a collection with fewer than N projects never satisfied it
 * and walked the entire range on every call. These tests pin the cases that matters for.
 *
 * No chain: the contract's own behavior is covered in `PublishLedger.t.sol`.
 */
import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import {
  readPublishFeed,
  readRecentProjects,
  readPublishCount,
  readPublishPage,
  iteratePublishLedger,
  type PublishPage,
} from "../src/project.js";

const COLLECTION = "0x000000000000000000000000000000000000c011" as Address;
const HOOK = "0x0000000000000000000000000000000000000h00".replace("h", "b") as Address;
const CONTRACTS = { collection: COLLECTION, hook: HOOK };

interface Row {
  tokenId: bigint;
  cid: `0x${string}`;
  publisher: Address;
  publishedAt: bigint;
  version: bigint;
}

/** A ledger where index 0 is the OLDEST record, matching the contract. */
function fakeHook(ledger: Row[]) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];

  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      calls.push({ fn: functionName, args });
      if (functionName === "publishCount") return BigInt(ledger.length);

      if (functionName === "publishRange") {
        const [, start, count] = args as [Address, bigint, bigint];
        return ledger.slice(Number(start), Number(start) + Number(count));
      }

      const [, a, b] = args as [Address, bigint, bigint];
      const before = functionName === "recentPublishes" ? BigInt(ledger.length) : a;
      const count = functionName === "recentPublishes" ? a : b;

      const end = before > BigInt(ledger.length) ? ledger.length : Number(before);
      const n = Math.min(Number(count), end);
      // Newest first, walking backward from `before` exclusive.
      return Array.from({ length: n }, (_, i) => ledger[end - 1 - i]!);
    },
  } as unknown as PublicClient;

  return { client, calls };
}

function row(tokenId: number, version: number, at = 1_700_000_000): Row {
  return {
    tokenId: BigInt(tokenId),
    cid: `0x${String(tokenId).padStart(2, "0")}${String(version).padStart(62, "0")}` as `0x${string}`,
    publisher: "0x00000000000000000000000000000000000000a1" as Address,
    publishedAt: BigInt(at),
    version: BigInt(version),
  };
}

describe("readPublishFeed", () => {
  it("returns newest first and decodes the record", async () => {
    const { client } = fakeHook([row(1, 1), row(2, 1), row(1, 2)]);
    const feed = await readPublishFeed(client, CONTRACTS, { limit: 2 });

    expect(feed.map((f) => f.tokenId)).toEqual([1n, 2n]);
    expect(feed[0]!.version).toBe(2);
    expect(typeof feed[0]!.publishedAt).toBe("number");
  });

  it("pages from a cursor", async () => {
    const { client, calls } = fakeHook([row(1, 1), row(2, 1), row(3, 1)]);
    const page = await readPublishFeed(client, CONTRACTS, { limit: 2, before: 2n });

    expect(page.map((f) => f.tokenId)).toEqual([2n, 1n]);
    expect(calls.at(-1)!.fn).toBe("recentPublishesBefore");
  });

  it("uses the unpaged entry point when no cursor is given", async () => {
    const { client, calls } = fakeHook([row(1, 1)]);
    await readPublishFeed(client, CONTRACTS, { limit: 5 });
    expect(calls.at(-1)!.fn).toBe("recentPublishes");
  });

  it("handles an empty ledger", async () => {
    const { client } = fakeHook([]);
    expect(await readPublishFeed(client, CONTRACTS)).toEqual([]);
    expect(await readPublishCount(client, CONTRACTS)).toBe(0n);
  });
});

describe("readRecentProjects", () => {
  it("collapses repeat publishes to one row per project, newest kept", async () => {
    const { client } = fakeHook([row(1, 1), row(1, 2), row(2, 1), row(1, 3)]);
    const recent = await readRecentProjects(client, CONTRACTS, { limit: 10 });

    expect(recent.map((r) => r.tokenId)).toEqual([1n, 2n]);
    // The surviving row for project 1 must be its LATEST publish, not its first.
    expect(recent[0]!.version).toBe(3);
  });

  /**
   * The bug the log version had. With fewer distinct projects than `limit`, the old early exit
   * could never be satisfied, so it scanned the whole range every time. Here that case must simply
   * return what exists and stop.
   */
  it("returns what exists when the collection has fewer projects than the limit", async () => {
    const { client, calls } = fakeHook([row(1, 1), row(2, 1)]);
    const recent = await readRecentProjects(client, CONTRACTS, { limit: 20 });

    expect(recent.map((r) => r.tokenId)).toEqual([2n, 1n]);
    // One count read plus one page read — it must not keep asking for more.
    expect(calls.filter((c) => c.fn !== "publishCount").length).toBe(1);
  });

  it("stops once the limit is reached", async () => {
    const ledger = Array.from({ length: 50 }, (_, i) => row(i + 1, 1));
    const { client } = fakeHook(ledger);
    const recent = await readRecentProjects(client, CONTRACTS, { limit: 5 });
    expect(recent).toHaveLength(5);
    expect(recent[0]!.tokenId).toBe(50n);
  });

  /**
   * A few projects publishing constantly could otherwise drag the whole ledger through the client
   * looking for a distinct id that is not there.
   */
  it("bounds the scan rather than reading an unbounded ledger", async () => {
    // 600 publishes, all by the same project: no amount of scanning yields a second distinct id.
    const ledger = Array.from({ length: 600 }, (_, i) => row(1, i + 1));
    const { client, calls } = fakeHook(ledger);

    const recent = await readRecentProjects(client, CONTRACTS, { limit: 20, maxScan: 200 });

    expect(recent.map((r) => r.tokenId)).toEqual([1n]);
    const pages = calls.filter((c) => c.fn !== "publishCount").length;
    expect(pages, "maxScan must cap the paging").toBeLessThanOrEqual(3);
  });

  it("handles an empty ledger without paging at all", async () => {
    const { client, calls } = fakeHook([]);
    expect(await readRecentProjects(client, CONTRACTS)).toEqual([]);
    expect(calls.filter((c) => c.fn !== "publishCount")).toHaveLength(0);
  });
});

describe("readPublishPage", () => {
  it("hands back a cursor that continues exactly where it stopped", async () => {
    const { client } = fakeHook([row(1, 1), row(2, 1), row(3, 1), row(4, 1), row(5, 1)]);

    const first = await readPublishPage(client, CONTRACTS, { limit: 2 });
    expect(first.records.map((r) => r.tokenId)).toEqual([5n, 4n]);
    expect(first.total).toBe(5n);
    expect(first.nextCursor).toBe(3n);

    const second = await readPublishPage(client, CONTRACTS, { limit: 2, before: first.nextCursor });
    expect(second.records.map((r) => r.tokenId)).toEqual([3n, 2n]);
    expect(second.nextCursor).toBe(1n);

    const third = await readPublishPage(client, CONTRACTS, { limit: 2, before: second.nextCursor });
    expect(third.records.map((r) => r.tokenId)).toEqual([1n]);
    // Exhausted: no cursor, so a caller's loop terminates instead of re-reading the last page.
    expect(third.nextCursor).toBeUndefined();
  });

  it("covers the ledger exactly once across pages", async () => {
    const { client } = fakeHook(Array.from({ length: 17 }, (_, i) => row(i + 1, 1)));

    const seen: bigint[] = [];
    let cursor: bigint | undefined;
    do {
      const page: PublishPage = await readPublishPage(client, CONTRACTS, { limit: 5, before: cursor });
      seen.push(...page.records.map((r) => r.tokenId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(17);
    expect(new Set(seen).size).toBe(17);
    expect(seen[0]).toBe(17n);
    expect(seen.at(-1)).toBe(1n);
  });

  it("reports an empty ledger without a cursor", async () => {
    const { client } = fakeHook([]);
    const page = await readPublishPage(client, CONTRACTS);
    expect(page.records).toEqual([]);
    expect(page.total).toBe(0n);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("iteratePublishLedger", () => {
  it("yields every record oldest first", async () => {
    const ledger = Array.from({ length: 7 }, (_, i) => row(i + 1, 1));
    const { client } = fakeHook(ledger);

    const seen: bigint[] = [];
    for await (const record of iteratePublishLedger(client, CONTRACTS, { pageSize: 3 })) {
      seen.push(record.tokenId);
    }
    expect(seen).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });

  it("terminates on an empty ledger", async () => {
    const { client } = fakeHook([]);
    const seen = [];
    for await (const r of iteratePublishLedger(client, CONTRACTS)) seen.push(r);
    expect(seen).toEqual([]);
  });
});
