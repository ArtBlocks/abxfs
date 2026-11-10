/**
 * Factory generations: an org is frozen against the factory that made it, so a superseded factory
 * has to stay in the registry or every URL under its orgs dies. What is checked here is which
 * generation answers for an org, and that a broken one can never make an address look like an org.
 */
import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { addressesForOrg, generationOfOrg, orgGenerations } from "../src/org.js";
import type { ContractAddresses } from "../src/types.js";
import { PresentationCapabilityError, readNativeFile } from "../src/presentation.js";
import { asAbxfsCid } from "../src/types.js";

const a = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const F2 = a(2), H2 = a(22), F1 = a(1), H1 = a(11), M1 = a(111), E1 = a(112), L1 = a(113);
const ORG_OLD = a(900), ORG_NEW = a(901), STRANGER = a(999);

const addresses: ContractAddresses = {
  sstore2Backend: a(50),
  fastLzBackend: a(54),
  chunkStore: a(51),
  fileStore: a(52),
  directoryStore: a(53),
  orgFactory: F2,
  projectHook: H2,
  lens: a(222),
  previousGenerations: [{ orgFactory: F1, projectHook: H1, orgMinter: M1, projectEnumeration: E1, lens: L1 }],
};

/** Each factory knows only the orgs it made; `throwing` factories revert like a dead contract would. */
function client(created: Record<string, Address[]>, throwing: Address[] = []): PublicClient {
  return {
    async readContract({ address, args }: { address: Address; args: readonly unknown[] }) {
      if (throwing.includes(address)) throw new Error("execution reverted");
      return (created[address] ?? []).includes(args[0] as Address);
    },
  } as unknown as PublicClient;
}

describe("orgGenerations", () => {
  it("lists the current generation first, then the earlier ones", () => {
    expect(orgGenerations(addresses).map((g) => g.orgFactory)).toEqual([F2, F1]);
  });

  it("is empty for a chain with no org layer, rather than inventing one", () => {
    expect(orgGenerations({ ...addresses, orgFactory: undefined, projectHook: undefined, previousGenerations: undefined })).toEqual([]);
  });
});

describe("generationOfOrg", () => {
  const c = client({ [F2]: [ORG_NEW], [F1]: [ORG_OLD] });

  it("finds the generation that made the org", async () => {
    expect((await generationOfOrg(c, addresses, ORG_NEW))?.projectHook).toBe(H2);
    expect((await generationOfOrg(c, addresses, ORG_OLD))?.projectHook).toBe(H1);
  });

  it("answers undefined for an address no factory made", async () => {
    expect(await generationOfOrg(c, addresses, STRANGER)).toBeUndefined();
  });

  it("never throws, and a reverting factory never makes an address an org", async () => {
    const dead = client({ [F1]: [ORG_OLD] }, [F2]);
    expect(await generationOfOrg(dead, addresses, STRANGER)).toBeUndefined();
    // The generation behind a broken one is still consulted.
    expect((await generationOfOrg(dead, addresses, ORG_OLD))?.orgFactory).toBe(F1);
  });
});

describe("addressesForOrg", () => {
  const c = client({ [F2]: [ORG_NEW], [F1]: [ORG_OLD] });

  it("swaps in the org's own generation and keeps the content layer", async () => {
    const old = await addressesForOrg(c, addresses, ORG_OLD);
    expect(old).toMatchObject({ orgFactory: F1, projectHook: H1, orgMinter: M1, projectEnumeration: E1, lens: L1 });
    expect(old?.chunkStore).toBe(addresses.chunkStore);
    expect(old?.sstore2Backend).toBe(addresses.sstore2Backend);
    expect(old?.fileStore).toBe(addresses.fileStore);
    expect(old?.previousGenerations).toBeUndefined();
  });

  it("does not leak a newer generation's optional contracts into an older one", async () => {
    const withMinter: ContractAddresses = { ...addresses, orgMinter: a(333), projectEnumeration: a(334) };
    const bare = {
      ...withMinter,
      previousGenerations: [{ orgFactory: F1, projectHook: H1 }],
    };
    const old = await addressesForOrg(c, bare, ORG_OLD);
    expect(old?.orgMinter).toBeUndefined();
    expect(old?.projectEnumeration).toBeUndefined();
  });

  it("is undefined for a stranger", async () => {
    expect(await addressesForOrg(c, addresses, STRANGER)).toBeUndefined();
  });

  it("retains the native reader only for generations using its immutable store pair", async () => {
    const native: ContractAddresses = { ...addresses, contentReader: a(700) };
    expect((await addressesForOrg(c, native, ORG_NEW))?.contentReader).toBe(a(700));
    expect((await addressesForOrg(c, native, ORG_OLD))?.contentReader).toBe(a(700));
    const samePair: ContractAddresses = {
      ...native,
      previousGenerations: [{ orgFactory: F1, projectHook: H1, fileStore: addresses.fileStore, directoryStore: addresses.directoryStore }],
    };
    expect((await addressesForOrg(c, samePair, ORG_OLD))?.contentReader).toBe(a(700));
    const differentPair: ContractAddresses = {
      ...native,
      previousGenerations: [{ orgFactory: F1, projectHook: H1, fileStore: a(701), directoryStore: a(702) }],
    };
    const old = await addressesForOrg(c, differentPair, ORG_OLD);
    expect(old).toMatchObject({ fileStore: a(701), directoryStore: a(702) });
    expect(old?.contentReader).toBeUndefined();
    await expect(readNativeFile(c, old!, asAbxfsCid(`0x${"00".repeat(32)}`), { maxBytes: 1n, maxChunks: 1n }))
      .rejects.toBeInstanceOf(PresentationCapabilityError);
  });
});
