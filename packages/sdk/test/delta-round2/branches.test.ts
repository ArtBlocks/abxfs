/**
 * Delta audit round 2: branches its coverage found untested, and `iterateOwnedProjects`' one-block walk.
 */
import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { readOrgsAdministeredAcrossGenerations } from "../../src/org.js";
import { iterateOwnedProjects } from "../../src/project.js";
import { pinnedReadPolicy } from "../../src/snapshot.js";
import type { ContractAddresses } from "../../src/types.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const CONTRACTS = { collection: a(0xc1), hook: a(0x11), enumeration: a(0xe1) };
const ME = a(0xa11ce);

/** An owner of `n` tokens; records the (start, count) of every page read and the block it was read at. */
function owner(n: number, opts: { prunedAfterFirstPage?: boolean } = {}) {
  const pages: Array<{ start: number; count: number; block: bigint | undefined }> = [];
  let pruned = false;
  const client = {
    async getBlockNumber() {
      return 100n;
    },
    async readContract({ functionName, args, blockNumber }: { functionName: string; args: readonly unknown[]; blockNumber?: bigint }) {
      if (pruned) throw new Error("missing trie node 0xabc (path ) state 0xdef is not available");
      if (functionName === "balanceOfTracked") return BigInt(n);
      if (functionName === "tokensOfOwnerSlice") {
        const [start, count] = [Number(args[2]), Number(args[3])];
        pages.push({ start, count, block: blockNumber });
        if (opts.prunedAfterFirstPage) pruned = true;
        return Array.from({ length: Math.max(0, Math.min(count, n - start)) }, (_, i) => BigInt(start + i));
      }
      throw new Error(functionName);
    },
  } as unknown as PublicClient;
  return { client, pages };
}

describe("iterateOwnedProjects", () => {
  it("pages 500 tokens at a time by default, every page at the block the walk started at", async () => {
    const o = owner(1_200);
    const got: bigint[] = [];
    for await (const t of iterateOwnedProjects(o.client, CONTRACTS, ME)) got.push(t);
    expect(got).toHaveLength(1_200);
    expect(o.pages.map((p) => [p.start, p.count])).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500],
    ]);
    expect(o.pages.every((p) => p.block === 100n)).toBe(true);
  });

  it("a consumer that pauses past the node's state window fails at the next page: an error, never a shorter list", async () => {
    const saved = { ...pinnedReadPolicy };
    pinnedReadPolicy.delayMs = 1;
    try {
      const o = owner(3, { prunedAfterFirstPage: true });
      const got: bigint[] = [];
      const walk = (async () => {
        for await (const t of iterateOwnedProjects(o.client, CONTRACTS, ME, { pageSize: 2 })) got.push(t);
      })();
      await expect(walk).rejects.toThrow(/missing trie node/);
      expect(got).toEqual([0n, 1n]); // the first page, then the error
    } finally {
      Object.assign(pinnedReadPolicy, saved);
    }
  });
});

describe("readOrgsAdministeredAcrossGenerations: which orgs a wallet administers, from the factories alone", () => {
  const NEW_FACTORY = a(0xf1);
  const OLD_FACTORY = a(0xf0);
  const addresses = {
    chunkStore: a(0xc0),
    fileStore: a(0xc2),
    directoryStore: a(0xc3),
    orgFactory: NEW_FACTORY,
    projectHook: a(0x11),
    projectEnumeration: a(0xe1),
    previousGenerations: [{ orgFactory: OLD_FACTORY, projectHook: a(0x10), projectEnumeration: a(0xe0) }],
  } as ContractAddresses;

  /** Each factory's administered list, each org's created block; `down` factories and `failing` orgs fail to read. */
  function chain(opts: { lists: Record<string, Address[]>; created: Record<string, bigint>; down?: Address[]; failing?: Address[] }) {
    const asked: string[] = [];
    const client = {
      async getBlockNumber() {
        return 100n;
      },
      async readContract({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) {
        asked.push(functionName);
        if (functionName !== "orgsAdministeredSlice") throw new Error(`unexpected ${functionName}`);
        if (opts.down?.includes(address)) throw new Error("HTTP request failed.");
        const list = opts.lists[address] ?? [];
        return list.slice(Number(args[1]), Number(args[1]) + Number(args[2]));
      },
      async multicall({ contracts }: { contracts: Array<{ args?: unknown[] }> }) {
        const org = String(contracts[0]!.args![0]) as Address;
        if (opts.failing?.includes(org)) throw new Error("HTTP request failed.");
        const ok = (result: unknown) => ({ status: "success", result });
        return [ok(true), ok(ME), ok(a(0)), ok(false), ok(opts.created[org] ?? 1n), ok(`org ${org.slice(-2)}`)];
      },
    } as unknown as PublicClient;
    return { client, asked };
  }

  it("reads every generation's administered list, never a held list, and sorts newest first", async () => {
    const { client, asked } = chain({
      lists: { [NEW_FACTORY]: [a(0xa1)], [OLD_FACTORY]: [a(0xa0), a(0xa2)] },
      created: { [a(0xa1)]: 50n, [a(0xa0)]: 10n, [a(0xa2)]: 70n },
    });
    const r = await readOrgsAdministeredAcrossGenerations(client, addresses, ME);
    expect(r.orgs.map((o) => o.org)).toEqual([a(0xa2), a(0xa1), a(0xa0)]);
    expect(r.orgs.every((o) => o.roles.length === 1 && o.roles[0] === "admin")).toBe(true);
    expect(r).toMatchObject({ failed: [], failedGenerations: [] });
    expect(r.truncated).toBeUndefined();
    expect(asked.every((f) => f === "orgsAdministeredSlice")).toBe(true);
  });

  it("a factory that cannot be read is a failed generation; an org whose record cannot be read is a failed org", async () => {
    const { client } = chain({ lists: { [NEW_FACTORY]: [a(0xa1), a(0xa3)] }, created: {}, down: [OLD_FACTORY], failing: [a(0xa3)] });
    const r = await readOrgsAdministeredAcrossGenerations(client, addresses, ME);
    expect(r.orgs.map((o) => o.org)).toEqual([a(0xa1)]);
    expect(r.failed).toEqual([a(0xa3)]);
    expect(r.failedGenerations).toEqual([OLD_FACTORY]);
  });

  it("a list past its cap is flagged truncated", async () => {
    const many = Array.from({ length: 2_001 }, (_, i) => a(0x10000 + i));
    const { client } = chain({ lists: { [NEW_FACTORY]: many }, created: {} });
    const r = await readOrgsAdministeredAcrossGenerations(client, addresses, ME);
    expect(r.truncated).toBe(true);
    expect(r.orgs).toHaveLength(2_000);
  });

  it("a chain without an org layer is refused, naming what is missing", async () => {
    const { client } = chain({ lists: {}, created: {} });
    const contentOnly = { chunkStore: a(1), fileStore: a(2), directoryStore: a(3) } as ContractAddresses;
    await expect(readOrgsAdministeredAcrossGenerations(client, contentOnly, ME)).rejects.toThrow();
  });
});
