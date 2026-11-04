/**
 * Reads the REAL Base Sepolia org deployment. Skipped unless `ABXFS_RPC_URL_84532` is set, so CI
 * without a node is unaffected.
 *
 * It exists because the fake client in `org.test.ts` can only prove the module's own logic; this
 * proves the ABIs in `abi-org.ts` encode calls the deployed contracts actually answer. Writes are
 * simulated, never sent: `eth_call` from the account needs no key and spends nothing.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address, type Chain } from "viem";
import { baseSepolia } from "viem/chains";

/** Widened to `Chain`: viem's OP-stack formatters on `baseSepolia` make its client types unassignable to the SDK's `PublicClient`. */
const chain: Chain = baseSepolia;

import { requireCanonicalAddresses } from "../src/canonical.js";
import {
  readGlobalPublishCount,
  readMyOrgs,
  readOrg,
  readOrgCount,
  readOrgs,
  requireOrgContracts,
} from "../src/org.js";
import { iOrgFactoryAbi } from "../src/abi-org.js";

const url = process.env.ABXFS_RPC_URL_84532;

describe.skipIf(!url)("live Base Sepolia org layer", () => {
  const client = createPublicClient({ chain, transport: http(url) });
  // Only when live: a skipped suite's body still runs while collecting, and the registry refuses a chain with no
  // deployment (it needs a deployment on Base Sepolia to run at all).
  const addresses = url ? requireCanonicalAddresses(84532) : (undefined as never);
  const contracts = url ? requireOrgContracts(addresses) : (undefined as never);

  it("has at least the org created when the factory was proven", async () => {
    expect(await readOrgCount(client, contracts.factory)).toBeGreaterThan(0n);
    const [first] = await readOrgs(client, contracts.factory, { count: 1 });
    expect(first).toBeTruthy();

    const org = await readOrg(client, contracts.factory, first as Address);
    expect(org).not.toBeNull();
    expect(org?.name.length).toBeGreaterThan(0);
    expect(org?.createdBlock).toBeGreaterThan(0n);
  });

  it("finds that org for its admin through the factory's own index", async () => {
    const [first] = await readOrgs(client, contracts.factory, { count: 1 });
    const org = await readOrg(client, contracts.factory, first as Address);
    const mine = await readMyOrgs(client, contracts, org!.admin);
    expect(mine.map((o) => o.org.toLowerCase())).toContain((first as string).toLowerCase());
    expect(mine.find((o) => o.org === first)?.roles).toContain("admin");
  });

  it("reports an unknown address as not an org", async () => {
    expect(await readOrg(client, contracts.factory, "0x000000000000000000000000000000000000dEaD")).toBeNull();
  });

  it("reads the cross-org ledger", async () => {
    expect(await readGlobalPublishCount(client, addresses.projectHook!)).toBeGreaterThanOrEqual(0n);
  });

  it("simulates createOrg from any account without sending anything", async () => {
    const { result } = await client.simulateContract({
      address: contracts.factory,
      abi: iOrgFactoryAbi,
      functionName: "createOrg",
      args: ["SDK simulation", "", "0x0000000000000000000000000000000000000000000000000000000000000000"],
      account: "0x00000000000000000000000000000000000a11ce",
    });
    expect(typeof result).toBe("string");
  });
});
