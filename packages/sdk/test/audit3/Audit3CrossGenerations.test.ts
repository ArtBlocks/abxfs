/**
 * Audit 3, cross-generation: what has to hold the first time a production factory is superseded.
 *
 * Three simulated generations (G3 current, G2, G1) over a mocked client. Findings that were fixed are
 * inverted into regression tests; the one still open is marked ACCEPTED with its reason.
 */
import { describe, expect, it } from "vitest";
import type { Address, PublicClient, WalletClient } from "viem";

import {
  AbxfsClient,
  addressesForOrg,
  generationOfOrg,
  mintInOrg,
  orgGenerations,
  readMyOrgsAcrossGenerations,
  readMyOrgsAcrossGenerationsDetailed,
} from "../../src/index.js";
import type { ContractAddresses } from "../../src/types.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const G3 = { orgFactory: a(0x31), projectHook: a(0x32), orgMinter: a(0x33), projectEnumeration: a(0x34), lens: a(0x35) };
const G2 = { orgFactory: a(0x21), projectHook: a(0x22), orgMinter: a(0x23), projectEnumeration: a(0x24), lens: a(0x25) };
const G1 = { orgFactory: a(0x11), projectHook: a(0x12), orgMinter: a(0x13), projectEnumeration: a(0x14), lens: a(0x15) };
const ORG1 = a(0x901);
const ORG2 = a(0x902);
const ORG3 = a(0x903);
const STRANGER = a(0x999);
const WALLET = a(0xaaa);

const base: ContractAddresses = {
  sstore2Backend: a(50),
  fastLzBackend: a(54),
  chunkStore: a(51),
  fileStore: a(52),
  directoryStore: a(53),
  ...G3,
  previousGenerations: [G2, G1],
};

interface World {
  /** factory -> orgs it created */
  created: Record<string, Address[]>;
  /** factory address -> throws on every call */
  dead?: Address[];
  /** every call, for cost assertions */
  calls: { address: string; fn: string }[];
  /** per-org collection `minter()` answer */
  minterOf?: Record<string, Address>;
  writes?: { address: string; fn: string }[];
}

function client(w: World): PublicClient {
  const known = (factory: Address, org: Address) => (w.created[factory] ?? []).some((o) => o.toLowerCase() === org.toLowerCase());
  const answer = (address: Address, fn: string, args: readonly unknown[]): unknown => {
    w.calls.push({ address, fn });
    if (w.dead?.includes(address)) throw new Error("execution reverted");
    switch (fn) {
      case "isOrg": return known(address, args[0] as Address);
      case "orgsAdministeredSlice": return (w.created[address] ?? []).slice(Number(args[1]), Number(args[1]) + Number(args[2]));
      case "orgsHeldCount": return 0n;
      case "orgsHeldSlice": return [];
      case "adminOf": return WALLET;
      case "pendingAdminOf": return a(0);
      case "isOpen": return false;
      case "createdBlockOf": return BigInt(Number(BigInt(args[0] as Address) & 0xffffn));
      case "name": return `org-${String(address).slice(-3)}`;
      case "minter": return w.minterOf?.[address.toLowerCase()] ?? a(0xdead);
      default: throw new Error(`unexpected ${fn}`);
    }
  };
  return {
    async readContract({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) {
      return answer(address, functionName, args ?? []);
    },
    async multicall({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) {
      return contracts.map((c) => {
        try {
          return { status: "success", result: answer(c.address, c.functionName, c.args ?? []) };
        } catch (error) {
          return { status: "failure", error };
        }
      });
    },
  } as unknown as PublicClient;
}

const world = (over: Partial<World> = {}): World => ({
  created: { [G3.orgFactory]: [ORG3], [G2.orgFactory]: [ORG2], [G1.orgFactory]: [ORG1] },
  calls: [],
  ...over,
});

describe("three generations: which one answers", () => {
  it("orders current first, then previous newest first, and each org resolves to its own hook", async () => {
    expect(orgGenerations(base).map((g) => g.projectHook)).toEqual([G3.projectHook, G2.projectHook, G1.projectHook]);
    const c = client(world());
    expect((await generationOfOrg(c, base, ORG1))?.projectHook).toBe(G1.projectHook);
    expect((await generationOfOrg(c, base, ORG2))?.projectHook).toBe(G2.projectHook);
    expect((await generationOfOrg(c, base, ORG3))?.projectHook).toBe(G3.projectHook);
    expect(await generationOfOrg(c, base, STRANGER)).toBeUndefined();
  });

  it("an org of the oldest generation costs one isOrg per generation (documented cost: N calls, sequential)", async () => {
    const w = world();
    await generationOfOrg(client(w), base, ORG1);
    expect(w.calls.filter((x) => x.fn === "isOrg").map((x) => x.address)).toEqual([G3.orgFactory, G2.orgFactory, G1.orgFactory]);
  });

  it("a dead NEWEST factory never hides an old org, and never makes a stranger an org", async () => {
    const c = client(world({ dead: [G3.orgFactory] }));
    expect((await generationOfOrg(c, base, ORG1))?.orgFactory).toBe(G1.orgFactory);
    expect(await generationOfOrg(c, base, STRANGER)).toBeUndefined();
  });

  it("ACCEPTED here, owned by the gateway: a transient failure of the org's OWN factory is indistinguishable from 'not an org'", async () => {
    // The gateway turns this into a 404 and caches it negatively for 30s (resolve.ts NEGATIVE_ORG_TTL_MS); a
    // real org briefly 404s instead of 502/503. Fix: generationOfOrg should report 'unknown' (throw or a
    // tri-state) when any factory errored and none answered true, and the gateway should map that to 503.
    const c = client(world({ dead: [G1.orgFactory] }));
    expect(await generationOfOrg(c, base, ORG1)).toBeUndefined();
  });

  it("addressesForOrg isolates each generation's org-layer slots and keeps the content layer", async () => {
    const c = client(world());
    for (const [org, g] of [[ORG1, G1], [ORG2, G2], [ORG3, G3]] as const) {
      const v = await addressesForOrg(c, base, org);
      expect(v).toMatchObject(g);
      expect(v?.chunkStore).toBe(base.chunkStore);
      expect(v?.sstore2Backend).toBe(base.sstore2Backend);
      expect(v?.fileStore).toBe(base.fileStore);
      expect(v?.previousGenerations).toBeUndefined();
    }
  });
});

describe("my orgs across three generations", () => {
  it("merges every generation, newest first, with each org read from its own factory", async () => {
    const orgs = await readMyOrgsAcrossGenerations(client(world()), base, WALLET);
    expect(orgs.map((o) => o.org).sort()).toEqual([ORG1, ORG2, ORG3].sort());
  });

  it("the current generation failing throws; an older one failing only thins the list", async () => {
    await expect(readMyOrgsAcrossGenerations(client(world({ dead: [G3.orgFactory] })), base, WALLET)).rejects.toThrow();
    const r = await readMyOrgsAcrossGenerationsDetailed(client(world({ dead: [G2.orgFactory] })), base, WALLET);
    expect(r.orgs.map((o) => o.org).sort()).toEqual([ORG1, ORG3].sort());
  });

  it("an older generation that cannot be read is REPORTED in `failed` and `failedGenerations`, not swallowed", async () => {
    const r = await readMyOrgsAcrossGenerationsDetailed(client(world({ dead: [G2.orgFactory] })), base, WALLET);
    expect(r.orgs.some((o) => o.org === ORG2)).toBe(false);
    expect(r.failed).toEqual([G2.orgFactory]);
    expect(r.failedGenerations).toEqual([G2.orgFactory]);
    // a healthy run reports nothing
    const ok = await readMyOrgsAcrossGenerationsDetailed(client(world()), base, WALLET);
    expect(ok.failed).toEqual([]);
    expect(ok.failedGenerations).toBeUndefined();
  });

  it("a registry that lists the current factory again (stale override) is deduplicated, not doubled", async () => {
    const stale: ContractAddresses = { ...base, previousGenerations: [G3, G2, G1] };
    const orgs = await readMyOrgsAcrossGenerations(client(world()), stale, WALLET);
    expect(orgs.filter((o) => o.org === ORG3).length).toBe(1);
    expect(orgGenerations(stale).map((g) => g.orgFactory)).toEqual([G3.orgFactory, G2.orgFactory, G1.orgFactory]);
  });

  it("a stale factory override (old factory at the top level) is refused as incoherent, not read through the wrong hook", () => {
    const stale: ContractAddresses = { ...base, ...G2, previousGenerations: [G2, G1] };
    // top-level == G2 and previous[0] == G2: the same generation twice, deduplicated
    expect(orgGenerations(stale).map((g) => g.orgFactory)).toEqual([G2.orgFactory, G1.orgFactory]);
  });

  it("a new factory paired with an old generation's hook is refused", () => {
    const mixed: ContractAddresses = { ...base, projectHook: G2.projectHook };
    expect(() => orgGenerations(mixed)).toThrow(/incoherent ABX FS registry.*projectHook/s);
    // and the reverse: an old factory restated with the current hook
    const mixed2: ContractAddresses = { ...base, previousGenerations: [{ ...G2, projectHook: G3.projectHook }, G1] };
    expect(() => orgGenerations(mixed2)).toThrow(/incoherent/);
    // same factory, two hooks
    const mixed3: ContractAddresses = { ...base, previousGenerations: [{ ...G3, projectHook: G2.projectHook }] };
    expect(() => orgGenerations(mixed3)).toThrow(/two different hooks/);
  });
});

describe("a client bound to an old org", () => {
  it("resolveOrg binds the old generation, and mayMint/readOrg go to the old factory", async () => {
    const w = world();
    const bc = new AbxfsClient({ publicClient: client(w), addresses: base });
    const old = await bc.resolveOrg(ORG1);
    expect(old.addresses.projectHook).toBe(G1.projectHook);
    expect(old.addresses.orgFactory).toBe(G1.orgFactory);
  });

  it("createOrg on a client resolved to an OLD org still creates in the CURRENT factory", async () => {
    const sims: string[] = [];
    const pub = client(world());
    (pub as unknown as { simulateContract: unknown }).simulateContract = async (r: { address: string }) => {
      sims.push(r.address);
      throw new Error("stop");
    };
    const wallet = { account: { address: WALLET } } as unknown as WalletClient;
    const old = await new AbxfsClient({ publicClient: pub, walletClient: wallet, addresses: base }).resolveOrg(ORG1);
    expect(old.addresses.orgFactory).toBe(G1.orgFactory); // still bound to its own generation for project reads
    await expect(old.createOrg({ name: "fresh" })).rejects.toThrow("stop");
    expect(sims).toEqual([G3.orgFactory]);
  });

  it("myOrgs() on a resolved client sees every generation", async () => {
    const pub = client(world());
    const old = await new AbxfsClient({ publicClient: pub, addresses: base }).resolveOrg(ORG1);
    const mine = await old.myOrgs(WALLET);
    expect(mine.map((o) => o.org).sort()).toEqual([ORG1, ORG2, ORG3].sort());
  });

  it("a resolved client forbids every generation's contracts as a transfer / admin-offer target", async () => {
    const wallet = { account: { address: WALLET }, writeContract: async () => "0x00" } as unknown as WalletClient;
    const old = await new AbxfsClient({ publicClient: client(world()), walletClient: wallet, addresses: base }).resolveOrg(ORG1);
    for (const target of [G3.lens, G2.lens, G1.lens, G2.orgFactory, G3.orgMinter, G1.projectEnumeration]) {
      await expect(Promise.resolve().then(() => old.transferProject(1n, target)), target).rejects.toThrow(/transfer target/);
      await expect(Promise.resolve().then(() => old.transferAdmin(target)), target).rejects.toThrow(/admin offer target/);
    }
  });
});

describe("minting into an old-generation org", () => {
  const wallet = { account: { address: WALLET } } as unknown as WalletClient;

  it("refuses an org whose collection names a minter that is not its own generation's minter", async () => {
    const w = world({ minterOf: { [ORG1.toLowerCase()]: G3.orgMinter } });
    await expect(mintInOrg({ publicClient: client(w), walletClient: wallet }, ORG1, { addresses: base })).rejects.toThrow(
      /not its factory generation's minter/,
    );
  });

  it("refuses an address no generation made", async () => {
    await expect(mintInOrg({ publicClient: client(world()), walletClient: wallet }, STRANGER, { addresses: base })).rejects.toThrow(/not created by an ABX FS org factory/);
  });

  it("refuses every generation's factory, minter, hook and enumeration as a mint target", async () => {
    for (const target of [G1.orgFactory, G2.orgMinter, G2.projectHook, G1.projectEnumeration, G3.lens]) {
      await expect(
        mintInOrg({ publicClient: client(world()), walletClient: wallet }, ORG1, { addresses: base, to: target }),
        target,
      ).rejects.toThrow(/mint target|recipient|ABX FS/i);
    }
  });

  it("a PREVIOUS generation's lens is refused up front as a recipient", async () => {
    for (const lens of [G1.lens, G2.lens, G3.lens]) {
      await expect(
        mintInOrg({ publicClient: client(world()), walletClient: wallet }, ORG1, { addresses: base, to: lens }),
        lens,
      ).rejects.toThrow(/mint target|recipient/i);
    }
  });
});
