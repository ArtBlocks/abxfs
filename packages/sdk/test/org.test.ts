/**
 * The org module's logic, against a fake client. What is being checked is what the SDK decides —
 * how it merges two on-chain indexes, validates a name, and decodes the lens — not that viem can
 * encode a call. The live test below covers the encoding against the real deployment.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector, type Abi, type Address, type Hex, type PublicClient } from "viem";

import {
  ORG_DESCRIPTION_MAX_BYTES,
  ORG_NAME_MAX_BYTES,
  PROJECT_TOKEN_NAME_MAX_BYTES,
  createOrg,
  defaultOrgName,
  projectNameShowsOnMarketplaces,
  readGlobalPublishes,
  readMyOrgs,
  readOrg,
  readOrgsAdministered,
  requireOrgContracts,
  resolveProject,
  validateOrgDescription,
  validateOrgName,
} from "../src/org.js";
import * as sdk from "../src/index.js";

const FACTORY = ("0x" + "f1".repeat(20)) as Address;
const ENUM = ("0x" + "e1".repeat(20)) as Address;
const LENS = ("0x" + "b1".repeat(20)) as Address;
const ALICE = ("0x" + "a1".repeat(20)) as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const org = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;

interface FakeOrg {
  admin: Address;
  name: string;
  createdBlock: bigint;
  open?: boolean;
  pending?: Address;
  registered?: boolean;
}

/** A client that answers the handful of reads the org module makes, from plain objects. */
function fakeClient(opts: {
  orgs: Record<string, FakeOrg>;
  administered?: Address[];
  held?: Address[];
  lens?: unknown;
  publishes?: unknown;
}): PublicClient {
  const lookup = (a: Address) => opts.orgs[a.toLowerCase()];
  return {
    async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
      switch (functionName) {
        case "orgsAdministeredSlice":
          return (opts.administered ?? []).slice(Number(args![1]), Number(args![1]) + Number(args![2]));
        case "orgsHeldCount":
          return BigInt((opts.held ?? []).length);
        case "orgsHeldSlice":
          return (opts.held ?? []).slice(Number(args![1]), Number(args![1]) + Number(args![2]));
        case "resolve":
          return opts.lens;
        case "publishRange":
          return opts.publishes;
        default:
          throw new Error(`unexpected readContract ${functionName} ${String(args)}`);
      }
    },
    async multicall({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) {
      return contracts.map((c) => {
        const target = (c.functionName === "name" ? c.address : (c.args?.[0] as Address)) as Address;
        const rec = lookup(target);
        const ok = (result: unknown) => ({ status: "success" as const, result });
        if (!rec) return ok(c.functionName === "isOrg" ? false : undefined);
        switch (c.functionName) {
          case "isOrg":
            return ok(rec.registered ?? true);
          case "adminOf":
            return ok(rec.admin);
          case "pendingAdminOf":
            return ok(rec.pending ?? ZERO);
          case "isOpen":
            return ok(rec.open ?? false);
          case "createdBlockOf":
            return ok(rec.createdBlock);
          case "name":
            return ok(rec.name);
          default:
            throw new Error(`unexpected multicall ${c.functionName}`);
        }
      });
    },
  } as unknown as PublicClient;
}

describe("org names", () => {
  it("accepts 1 to 64 bytes and counts bytes, not characters", () => {
    expect(() => validateOrgName("a")).not.toThrow();
    expect(() => validateOrgName("a".repeat(ORG_NAME_MAX_BYTES))).not.toThrow();
    expect(() => validateOrgName("")).toThrow(/needs a name/);
    expect(() => validateOrgName("a".repeat(ORG_NAME_MAX_BYTES + 1))).toThrow(/limit/);
  });

  it("mirrors the contract policy exactly: printable ASCII 0x20..0x7e, not all spaces", () => {
    expect(() => validateOrgName("€")).toThrow(/printable ASCII/);
    expect(() => validateOrgName("caf\u00e9")).toThrow(/printable ASCII/);
    expect(() => validateOrgName("a\u202eb")).toThrow(/printable ASCII/); // bidi override
    expect(() => validateOrgName("a\u200bb")).toThrow(/printable ASCII/); // zero-width space
    expect(() => validateOrgName("a\nb")).toThrow(/printable ASCII/);
    expect(() => validateOrgName("a\x7fb")).toThrow(/printable ASCII/);
    expect(() => validateOrgName("   ")).toThrow(/only spaces/);
    expect(() => validateOrgName(" a ")).not.toThrow(); // one non-space is enough, as on chain
    expect(() => validateOrgName("~ !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")).not.toThrow();
    expect(() => validateOrgName("x".repeat(1_000_000))).toThrow(/limit/); // refused without being encoded
  });

  it("derives a default that fits the limit and cannot pass as a brand", () => {
    const name = defaultOrgName(ALICE);
    expect(name).toBe("0xa1a1..a1a1");
    expect(() => validateOrgName(name)).not.toThrow();
  });

  /**
   * The card renders an org's name through a sanitizer that keeps printable ASCII only. A typographic
   * ellipsis in the default would be dropped on the card, which then showed `0x666314aF` — neither the
   * name nor an address. Caught by looking at a real card, so it is pinned here.
   */
  it("is printable ASCII, so the card shows it exactly as named", () => {
    expect(defaultOrgName(ALICE)).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("org descriptions", () => {
  it("is optional, and accepts up to 1000 bytes", () => {
    expect(() => validateOrgDescription("")).not.toThrow();
    expect(() => validateOrgDescription("a")).not.toThrow();
    expect(() => validateOrgDescription("a".repeat(ORG_DESCRIPTION_MAX_BYTES))).not.toThrow();
    expect(() => validateOrgDescription("a".repeat(ORG_DESCRIPTION_MAX_BYTES + 1))).toThrow(/limit is 1000/);
    expect(() => validateOrgDescription("x".repeat(1_000_000))).toThrow(/limit/);
  });

  it("mirrors the contract policy exactly: printable ASCII 0x20..0x7e or newline, not only whitespace", () => {
    expect(() => validateOrgDescription("Line one\nLine two\n\n- a list")).not.toThrow();
    expect(() => validateOrgDescription("~ !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")).not.toThrow();
    expect(() => validateOrgDescription(" a\n")).not.toThrow(); // one non-space is enough, as on chain
    expect(() => validateOrgDescription("café")).toThrow(/printable ASCII.*character 4/);
    expect(() => validateOrgDescription("a\tb")).toThrow(/printable ASCII/); // a tab is not a newline
    expect(() => validateOrgDescription("a\r\nb")).toThrow(/printable ASCII/); // CR is refused, only LF passes
    expect(() => validateOrgDescription("a‮b")).toThrow(/printable ASCII/);
    expect(() => validateOrgDescription("a\x7fb")).toThrow(/printable ASCII/);
    expect(() => validateOrgDescription("   ")).toThrow(/only spaces and newlines/);
    expect(() => validateOrgDescription("\n\n")).toThrow(/only spaces and newlines/);
    expect(() => validateOrgDescription(" \n ")).toThrow(/only spaces and newlines/);
  });

  it("is exported from the package entry point", () => {
    expect(sdk.validateOrgDescription).toBe(validateOrgDescription);
    expect(sdk.projectNameShowsOnMarketplaces).toBe(projectNameShowsOnMarketplaces);
  });
});

describe("project names on marketplaces", () => {
  it("shows a project's own name when it is 1..128 bytes of printable ASCII and not all spaces", () => {
    expect(projectNameShowsOnMarketplaces("My site")).toBe(true);
    expect(projectNameShowsOnMarketplaces(" a ")).toBe(true);
    expect(projectNameShowsOnMarketplaces("a".repeat(PROJECT_TOKEN_NAME_MAX_BYTES))).toBe(true);
  });

  it("falls back to '<org name> #<id>' otherwise", () => {
    expect(projectNameShowsOnMarketplaces("")).toBe(false);
    expect(projectNameShowsOnMarketplaces("   ")).toBe(false);
    expect(projectNameShowsOnMarketplaces("a".repeat(PROJECT_TOKEN_NAME_MAX_BYTES + 1))).toBe(false);
    expect(projectNameShowsOnMarketplaces("café")).toBe(false);
    expect(projectNameShowsOnMarketplaces("a\nb")).toBe(false); // newlines are fine in a description, not here
    expect(projectNameShowsOnMarketplaces("\u{1f600}")).toBe(false);
    expect(projectNameShowsOnMarketplaces("-")).toBe(false); // the on-chain "cleared" marker
  });
});

describe("createOrg calldata", () => {
  const WALLET = { account: { address: ALICE } };
  const SALT = ("0x" + "00".repeat(32)) as Hex;

  /** Captures what createOrg would simulate, encodes it as viem would, and stops before sending. */
  function capture() {
    const calls: { args: readonly unknown[]; data: Hex }[] = [];
    const publicClient = {
      async simulateContract(p: { abi: Abi; functionName: string; args: readonly unknown[] }) {
        calls.push({ args: p.args, data: encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args }) });
        throw new Error("stop");
      },
    } as unknown as PublicClient;
    return { calls, clients: { publicClient, walletClient: WALLET as never } };
  }

  const selector = toFunctionSelector("createOrg(string,string,bytes32)");

  it("passes an empty description by default, through the three-argument createOrg", async () => {
    const { calls, clients } = capture();
    await expect(createOrg(clients, FACTORY, { name: "Studio" })).rejects.toThrow("stop");
    expect(calls[0]!.args).toEqual(["Studio", "", SALT]);
    expect(calls[0]!.data.slice(0, 10)).toBe(selector);
  });

  it("passes the description it is given", async () => {
    const { calls, clients } = capture();
    await expect(createOrg(clients, FACTORY, { name: "Studio", description: "We make sites.\nOn chain." })).rejects.toThrow("stop");
    expect(calls[0]!.args).toEqual(["Studio", "We make sites.\nOn chain.", SALT]);
    expect(calls[0]!.data.slice(0, 10)).toBe(selector);
  });

  it("refuses a bad description before simulating anything", async () => {
    const { calls, clients } = capture();
    await expect(createOrg(clients, FACTORY, { name: "Studio", description: "café" })).rejects.toThrow(/printable ASCII/);
    await expect(createOrg(clients, FACTORY, { name: "Studio", description: "  " })).rejects.toThrow(/only spaces/);
    expect(calls).toHaveLength(0);
  });
});

describe("requireOrgContracts", () => {
  it("names what is missing instead of failing later in a read", () => {
    expect(() => requireOrgContracts({} as never)).toThrow(/no ABX FS org factory/);
  });

  it("carries the optional pieces only when present", () => {
    const c = requireOrgContracts({ orgFactory: FACTORY, projectEnumeration: ENUM } as never);
    expect(c).toEqual({ factory: FACTORY, enumeration: ENUM });
  });
});

describe("readOrg", () => {
  it("returns null for an address the factory does not know", async () => {
    const client = fakeClient({ orgs: {} });
    expect(await readOrg(client, FACTORY, org(1))).toBeNull();
  });

  it("reads the record, treating the zero address as no pending admin", async () => {
    const client = fakeClient({
      orgs: { [org(1)]: { admin: ALICE, name: "Acme", createdBlock: 7n, open: true } },
    });
    expect(await readOrg(client, FACTORY, org(1))).toEqual({
      org: org(1),
      name: "Acme",
      admin: ALICE,
      pendingAdmin: null,
      open: true,
      createdBlock: 7n,
    });
  });

  it("surfaces a pending admin offer", async () => {
    const bob = ("0x" + "b0".repeat(20)) as Address;
    const client = fakeClient({
      orgs: { [org(1)]: { admin: ALICE, name: "Acme", createdBlock: 1n, pending: bob } },
    });
    expect((await readOrg(client, FACTORY, org(1)))?.pendingAdmin).toBe(bob);
  });
});

describe("readMyOrgs", () => {
  const orgs = {
    [org(1)]: { admin: ALICE, name: "old", createdBlock: 10n },
    [org(2)]: { admin: ALICE, name: "newer", createdBlock: 30n },
    [org(3)]: { admin: org(99), name: "someone else's", createdBlock: 20n },
  };

  it("merges administered and held, and says why each is there", async () => {
    const client = fakeClient({ orgs, administered: [org(1), org(2)], held: [org(2), org(3)] });
    const mine = await readMyOrgs(client, { factory: FACTORY, enumeration: ENUM }, ALICE);

    const byName = Object.fromEntries(mine.map((o) => [o.name, [...o.roles].sort()]));
    expect(byName).toEqual({
      old: ["admin"],
      newer: ["admin", "holder"],
      "someone else's": ["holder"],
    });
  });

  it("orders newest first, so the default org is the latest one", async () => {
    const client = fakeClient({ orgs, administered: [org(1), org(2)], held: [org(3)] });
    const mine = await readMyOrgs(client, { factory: FACTORY, enumeration: ENUM }, ALICE);
    expect(mine.map((o) => o.name)).toEqual(["newer", "someone else's", "old"]);
  });

  it("lists each org once however it matched, and ignores addresses the factory dropped", async () => {
    const client = fakeClient({
      orgs: { ...orgs, [org(4)]: { admin: ALICE, name: "x", createdBlock: 1n, registered: false } },
      administered: [org(1), org(1), org(4)],
      held: [org(1)],
    });
    const mine = await readMyOrgs(client, { factory: FACTORY, enumeration: ENUM }, ALICE);
    expect(mine.map((o) => o.name)).toEqual(["old"]);
    expect(mine[0]?.roles.sort()).toEqual(["admin", "holder"]);
  });

  it("works without an enumeration hook, as administered-only", async () => {
    const client = fakeClient({ orgs, administered: [org(1)], held: [org(3)] });
    const mine = await readMyOrgs(client, { factory: FACTORY }, ALICE);
    expect(mine.map((o) => o.name)).toEqual(["old"]);
  });

  it("is empty for an address with nothing, which is the signal to create a personal org", async () => {
    const mine = await readMyOrgs(fakeClient({ orgs }), { factory: FACTORY, enumeration: ENUM }, ALICE);
    expect(mine).toEqual([]);
  });
});

describe("resolveProject", () => {
  const cid = ("0x" + "ab".repeat(32)) as Hex;

  it("maps the lens result, decoding the gateway and treating a zero CID as unpublished", async () => {
    const gateway = ("0x" + Buffer.from("https://gw.example/ipfs/").toString("hex")) as Hex;
    const client = fakeClient({
      orgs: {},
      lens: { registered: true, kind: 1, cid, owner: ALICE, gateway },
    });
    const r = await resolveProject(client, LENS, org(1), 0n);
    expect(r).toMatchObject({ registered: true, kind: 1, cid, owner: ALICE, gateway: "https://gw.example/ipfs/" });

    const empty = fakeClient({
      orgs: {},
      lens: { registered: true, kind: 0, cid: ("0x" + "00".repeat(32)) as Hex, owner: ALICE, gateway: "0x" },
    });
    const u = await resolveProject(empty, LENS, org(1), 0n);
    expect(u.cid).toBeNull();
    expect(u.gateway).toBeNull();
  });

  it("passes an unregistered org through as registered:false", async () => {
    const client = fakeClient({
      orgs: {},
      lens: { registered: false, kind: 0, cid: ("0x" + "00".repeat(32)) as Hex, owner: ZERO, gateway: "0x" },
    });
    expect((await resolveProject(client, LENS, org(9), 0n)).registered).toBe(false);
  });
});

describe("readGlobalPublishes", () => {
  it("flattens the lens records into one shape a crawler can store", async () => {
    const cid = ("0x" + "cd".repeat(32)) as Hex;
    const client = fakeClient({
      orgs: {},
      publishes: [
        { org: org(1), record: { cid, publisher: ALICE, publishedAt: 1_700_000_000n, version: 2n, tokenId: 5n } },
      ],
    });
    expect(await readGlobalPublishes(client, LENS, { start: 3n, count: 10 })).toEqual([
      { org: org(1), tokenId: 5n, cid, publisher: ALICE, publishedAt: 1_700_000_000, version: 2 },
    ]);
  });
});

describe("readOrgsAdministered pages the factory's list", () => {
  it("reads in clamped slices until a short page, and stops at max", async () => {
    const all = Array.from({ length: 450 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    const windows: [number, number][] = [];
    const client = {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        expect(functionName).toBe("orgsAdministeredSlice");
        const [start, count] = [Number(args[1]), Number(args[2])];
        windows.push([start, count]);
        return all.slice(start, start + count);
      },
    } as unknown as PublicClient;
    const factory = `0x${"f".repeat(40)}` as Address;
    expect(await readOrgsAdministered(client, factory, all[0]!)).toEqual(all);
    expect(windows).toEqual([[0, 200], [200, 200], [400, 200]]);
    windows.length = 0;
    expect(await readOrgsAdministered(client, factory, all[0]!, { max: 250 })).toHaveLength(250);
    // At the cap, one 1-org probe says whether the list goes on (`truncated`, delta audit).
    expect(windows).toEqual([[0, 200], [200, 50], [250, 1]]);
  });
});
