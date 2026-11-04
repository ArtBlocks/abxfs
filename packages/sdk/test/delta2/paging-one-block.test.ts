/**
 * Swap-and-pop lists are paged at ONE block (org-layer delta audit), and `readOrgsAdministered` validates its paging
 * (SDK delta audit: `{ pageSize: 0 }` looped forever) and says when it stopped at its cap.
 *
 * The fake chain below keeps history: each list is a function of the block, and the "chain" advances one block after
 * every read at "latest". A handover between page 1 and page 2 swaps the last org into a removed one's place, so a
 * pager reading each page at "latest" skips the moved org and repeats nothing or another; read at one block, the pages
 * are the list as it was.
 */
import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  encodeAbiParameters,
  getContractError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { iOrgFactoryAbi } from "../../src/abi-org.js";
import { readMyOrgsAcrossGenerationsDetailed, readMyOrgsDetailed, readOrgsAdministered, readOrgsHeld } from "../../src/org.js";
import type { ContractAddresses } from "../../src/types.js";
import { iterateOwnedProjects, readEmptyOwnedProjects, readTagPage } from "../../src/project.js";
import { pinnedReadPolicy } from "../../src/snapshot.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const FACTORY = a(0xf1);
const ENUM = a(0xe1);
const HOOK = a(0x11);
const COLLECTION = a(0xc1);
const ME = a(0xa11ce);

/** `before` until block `at`, then `after` (the swap-and-pop of removing index `removed`). */
function history<T>(before: T[], removed: number, at: bigint): (block: bigint) => T[] {
  const after = [...before];
  after[removed] = after[after.length - 1]!;
  after.pop();
  return (block) => (block < at ? before : after);
}

/**
 * A chain at block 100 that moves to 101 after the first read made at "latest" (or at any block). `lists` maps a
 * function name to the list it pages. Records the block every read asked for.
 */
function chain(lists: Record<string, (block: bigint) => unknown[]>, extra: Record<string, (block: bigint, args: readonly unknown[]) => unknown> = {}) {
  let head = 100n;
  const asked: Array<bigint | "latest"> = [];
  const client = {
    async getBlockNumber() {
      return head;
    },
    async readContract({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
      const at = blockNumber ?? head;
      asked.push(blockNumber ?? "latest");
      head = 101n; // the handover lands right after the first read
      if (extra[functionName]) return extra[functionName]!(at, args);
      const list = lists[functionName.replace(/Slice$|Range$|Count$/, "")];
      if (!list) throw new Error(`unexpected ${functionName}`);
      const all = list(at);
      if (/Count$|^balanceOfTracked$/.test(functionName)) return BigInt(all.length);
      // (who, start, count) for the org lists; (collection, owner, start, count) / (collection, token, start, end).
      if (functionName === "getTagsRange") return all.slice(Number(args[2]), Number(args[3]));
      const [start, count] = functionName === "tokensOfOwnerSlice" ? [args[2], args[3]] : [args[1], args[2]];
      return all.slice(Number(start), Number(start) + Number(count));
    },
    async multicall({ contracts, blockNumber }: { contracts: unknown[]; blockNumber?: bigint }) {
      asked.push(blockNumber ?? "latest");
      return contracts.map(() => ({ status: "failure", error: new Error("x") }));
    },
  } as unknown as PublicClient;
  return { client, asked };
}

const ORGS = Array.from({ length: 5 }, (_, i) => a(i + 1));

describe("a swap-and-pop list is read at one block", () => {
  it("readOrgsAdministered: a handover between pages neither skips nor repeats an org", async () => {
    const { client, asked } = chain({ orgsAdministered: history(ORGS, 0, 101n) });
    const got = await readOrgsAdministered(client, FACTORY, ME, { pageSize: 2 });
    expect(got).toEqual(ORGS); // the list at block 100
    expect(new Set(got).size).toBe(got.length);
    expect(asked.every((b) => b === 100n)).toBe(true);
  });

  it("the same list read page by page at latest would have lost org 5 (what the fix prevents)", async () => {
    const { client } = chain({ orgsAdministered: history(ORGS, 0, 101n) });
    const latest = { ...client, getBlockNumber: undefined } as unknown as PublicClient;
    const got = await readOrgsAdministered(latest, FACTORY, ME, { pageSize: 2 });
    expect(got).not.toContain(ORGS[4]);
  });

  it("readOrgsHeld: the count and every page at one block", async () => {
    const { client, asked } = chain({ orgsHeld: history(ORGS, 1, 101n) });
    expect(await readOrgsHeld(client, ENUM, ME, { pageSize: 2 })).toEqual(ORGS);
    expect(asked).toEqual([100n, 100n, 100n, 100n]);
  });

  it("iterateOwnedProjects and readEmptyOwnedProjects: an owner's tokens at one block", async () => {
    const tokens = [1n, 2n, 3n, 4n, 5n];
    const { client, asked } = chain({ balanceOfTracked: history(tokens, 0, 101n), tokensOfOwner: history(tokens, 0, 101n) });
    const got: bigint[] = [];
    for await (const t of iterateOwnedProjects(client, { collection: COLLECTION, hook: HOOK, enumeration: ENUM }, ME, { pageSize: 2 })) got.push(t);
    expect(got).toEqual(tokens);
    expect(asked.every((b) => b === 100n)).toBe(true);

    const second = chain({ balanceOfTracked: history(tokens, 0, 101n), tokensOfOwner: history(tokens, 0, 101n) });
    // Every token read fails here, so the answer is "cannot tell"; what matters is that all three reads share a block.
    expect(await readEmptyOwnedProjects(second.client, { collection: COLLECTION, hook: HOOK, enumeration: ENUM }, ME)).toBeUndefined();
    expect(second.asked).toEqual([100n, 100n, 100n]);
  });

  it("readTagPage: the count and the range at one block", async () => {
    const tags = ["v1", "v2", "v3", "v4"];
    const { client, asked } = chain({ tag: history(tags, 0, 101n), getTags: history(tags, 0, 101n) }, {
      tagCount: (block) => BigInt(history(tags, 0, 101n)(block).length),
    });
    const page = await readTagPage(client, { collection: COLLECTION, hook: HOOK }, 1n, { limit: 10 });
    expect(page.tags).toEqual(tags);
    expect(page.total).toBe(4);
    expect(asked).toEqual([100n, 100n]);
  });

  it("a replica that has not seen the pinned block yet is waited out; a revert or a dead connection is not", async () => {
    const saved = { ...pinnedReadPolicy };
    pinnedReadPolicy.delayMs = 1;
    try {
      let misses = 2;
      const lagging = {
        async getBlockNumber() {
          return 100n;
        },
        async readContract({ args }: { args: readonly unknown[] }) {
          if (misses-- > 0) throw new Error("header not found");
          return ORGS.slice(Number(args[1]), Number(args[1]) + Number(args[2]));
        },
      } as unknown as PublicClient;
      expect(await readOrgsAdministered(lagging, FACTORY, ME)).toEqual(ORGS);

      let calls = 0;
      const dead = {
        async getBlockNumber() {
          return 100n;
        },
        async readContract() {
          calls++;
          throw Object.assign(new Error("HTTP 429 too many requests"), { status: 429 });
        },
      } as unknown as PublicClient;
      await expect(readOrgsAdministered(dead, FACTORY, ME)).rejects.toThrow(/429/);
      expect(calls).toBe(1);

      // A real revert, as viem throws one for revert data on the wire: a ContractFunctionRevertedError inside a
      // ContractFunctionExecutionError. Thrown at once: no replica will ever answer it differently.
      calls = 0;
      const revert = getContractError(new RawContractError({ data: "0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["nope"]).slice(2) as Hex }), {
        abi: iOrgFactoryAbi,
        address: FACTORY,
        args: [ME, 0n, 200n],
        functionName: "orgsAdministeredSlice",
      });
      expect((revert as BaseError).walk((e) => e instanceof ContractFunctionRevertedError)).not.toBeNull();
      const reverting = {
        async getBlockNumber() {
          return 100n;
        },
        async readContract() {
          calls++;
          throw revert;
        },
      } as unknown as PublicClient;
      await expect(readOrgsAdministered(reverting, FACTORY, ME)).rejects.toBe(revert);
      expect(calls).toBe(1);

      calls = 0;
      const never = {
        async getBlockNumber() {
          return 100n;
        },
        async readContract() {
          calls++;
          throw new Error("header not found");
        },
      } as unknown as PublicClient;
      await expect(readOrgsAdministered(never, FACTORY, ME)).rejects.toThrow(/header not found/);
      expect(calls).toBe(pinnedReadPolicy.attempts);
    } finally {
      Object.assign(pinnedReadPolicy, saved);
    }
  });
});

describe("readOrgsAdministered validates its paging and says when it stopped at its cap", () => {
  const fake = (all: Address[]) => {
    const windows: Array<[number, number]> = [];
    const client = {
      async readContract({ args }: { args: readonly unknown[] }) {
        const [start, count] = [Number(args[1]), Number(args[2])];
        windows.push([start, count]);
        return all.slice(start, start + count);
      },
    } as unknown as PublicClient;
    return { client, windows };
  };

  it("pageSize 0, a negative or fractional pageSize, and a negative max are refused before any read", async () => {
    const { client, windows } = fake(ORGS);
    for (const opts of [{ pageSize: 0 }, { pageSize: -1 }, { pageSize: 1.5 }, { pageSize: Number.NaN }, { max: -1 }]) {
      await expect(readOrgsAdministered(client, FACTORY, ME, opts)).rejects.toThrow(RangeError);
      await expect(readOrgsHeld(client, ENUM, ME, opts)).rejects.toThrow(RangeError);
    }
    expect(windows).toEqual([]);
  });

  it("an empty page ends the read (a client that answers a full window with nothing cannot spin it)", async () => {
    const { client, windows } = fake([]);
    const got = await readOrgsAdministered(client, FACTORY, ME, { pageSize: 1 });
    expect(got).toEqual([]);
    expect(got.truncated).toBe(false);
    expect(windows).toEqual([[0, 1]]);
  });

  it("at max, one probe says whether there are more; under it, nothing is flagged", async () => {
    const all = Array.from({ length: 450 }, (_, i) => a(i + 1));
    const big = fake(all);
    const capped = await readOrgsAdministered(big.client, FACTORY, ME, { max: 250 });
    expect(capped).toHaveLength(250);
    expect(capped.truncated).toBe(true);
    expect(big.windows).toEqual([[0, 200], [200, 50], [250, 1]]);

    const exact = fake(all.slice(0, 250));
    const whole = await readOrgsAdministered(exact.client, FACTORY, ME, { max: 250 });
    expect(whole).toHaveLength(250);
    expect(whole.truncated).toBe(false);
    // `truncated` is not an element: the result is still exactly the list.
    expect([...whole]).toEqual(all.slice(0, 250));
    expect(JSON.stringify(whole)).toBe(JSON.stringify(all.slice(0, 250)));
  });

  it("readOrgsHeld flags a held list past its cap, and readMyOrgsDetailed passes the flag on", async () => {
    const held = Array.from({ length: 30 }, (_, i) => a(0x1000 + i));
    const client = {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        if (functionName === "orgsAdministeredSlice") return [];
        if (functionName === "orgsHeldCount") return BigInt(held.length);
        if (functionName === "orgsHeldSlice") return held.slice(Number(args[1]), Number(args[1]) + Number(args[2]));
        throw new Error(functionName);
      },
      async multicall() {
        const ok = (result: unknown) => ({ status: "success", result });
        return [ok(true), ok(a(9)), ok(a(0)), ok(false), ok(1n), ok("n")];
      },
    } as unknown as PublicClient;
    const list = await readOrgsHeld(client, ENUM, ME, { max: 10 });
    expect(list).toHaveLength(10);
    expect(list.truncated).toBe(true);
    expect((await readOrgsHeld(client, ENUM, ME)).truncated).toBe(false);
    // Under its 2,000 default cap, readMyOrgsDetailed says nothing about truncation.
    const mine = await readMyOrgsDetailed(client, { factory: FACTORY, hook: HOOK, enumeration: ENUM }, ME);
    expect(mine.truncated).toBeUndefined();
    expect(mine.orgs).toHaveLength(30);
  });

  /**
   * A wallet that holds projects in `held` orgs and administers `administered` (anyone can mint into a wallet from an
   * open org, so `held` can be made past the cap). Every org reads as registered.
   */
  const connected = (counts: { held: number; administered: number }) => {
    const held = Array.from({ length: counts.held }, (_, i) => a(0x10000 + i));
    const administered = Array.from({ length: counts.administered }, (_, i) => a(0x20000 + i));
    return {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        const [start, count] = [Number(args[1]), Number(args[2])];
        if (functionName === "orgsAdministeredSlice") return administered.slice(start, start + count);
        if (functionName === "orgsHeldCount") return BigInt(held.length);
        if (functionName === "orgsHeldSlice") return held.slice(start, start + count);
        throw new Error(functionName);
      },
      async multicall() {
        const ok = (result: unknown) => ({ status: "success", result });
        return [ok(true), ok(a(9)), ok(a(0)), ok(false), ok(1n), ok("n")];
      },
    } as unknown as PublicClient;
  };

  it("readMyOrgsDetailed: a held list past its 2,000 cap is flagged truncated", async () => {
    const mine = await readMyOrgsDetailed(connected({ held: 2_001, administered: 0 }), { factory: FACTORY, hook: HOOK, enumeration: ENUM }, ME);
    expect(mine.truncated).toBe(true);
    expect(mine.orgs).toHaveLength(2_000);
  });

  it("readMyOrgsDetailed: so is an administered list past its cap", async () => {
    const mine = await readMyOrgsDetailed(connected({ held: 0, administered: 2_001 }), { factory: FACTORY, hook: HOOK, enumeration: ENUM }, ME);
    expect(mine.truncated).toBe(true);
    expect(mine.orgs).toHaveLength(2_000);
  });

  it("readMyOrgsAcrossGenerationsDetailed passes a generation's truncated flag on", async () => {
    const addresses = {
      chunkStore: a(0xc0),
      fileStore: a(0xc2),
      directoryStore: a(0xc3),
      orgFactory: FACTORY,
      projectHook: HOOK,
      projectEnumeration: ENUM,
    } as ContractAddresses;
    const over = await readMyOrgsAcrossGenerationsDetailed(connected({ held: 2_001, administered: 1 }), addresses, ME);
    expect(over.truncated).toBe(true);
    expect(over.orgs).toHaveLength(2_001); // 2,000 held and the one administered
    const under = await readMyOrgsAcrossGenerationsDetailed(connected({ held: 3, administered: 1 }), addresses, ME);
    expect(under.truncated).toBeUndefined();
    expect(under.orgs).toHaveLength(4);
  });
});
