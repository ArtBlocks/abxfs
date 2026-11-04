/**
 * LIVE end-to-end proof of the current org-factory generation (bound to the ABX FS stores) on Base Sepolia.
 * Skipped unless ABXFS_RPC_URL_84532 and ABXFS_PRIVATE_KEY are set: it spends testnet ETH and creates an org
 * (permanent and harmless). The addresses come from the canonical registry, so it also needs a deployment there.
 * Run from this package with the environment loaded in a subshell:
 *
 *   ( set -a; . ../../.env; set +a; npx vitest run test/org-content-live.test.ts --reporter=verbose )
 *
 * createOrg -> mint -> publish a small directory through `executeNewProjectPublish` -> read the project back, and
 * confirm the hook refuses a root its stores do not hold (it asks only ITS stores).
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Chain, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Widened to `Chain`: viem's OP-stack formatters on `baseSepolia` make its client types unassignable to the SDK's `PublicClient`. */
const chain: Chain = baseSepolia;

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { requireCanonicalAddresses } from "../src/canonical.js";
import { applyNewProject, executeNewProjectPublish } from "../src/draft.js";
import { locateContent } from "../src/kind.js";
import { createOrg, mintInOrg, requireOrgContracts } from "../src/org.js";
import { PROJECT_PARAM_KEYS, encodeParamKey, readProject, type ProjectContracts } from "../src/project.js";
import { hookAcceptsContent } from "../src/stores.js";
import { ProjectKind, type AbxfsCid } from "../src/types.js";
import { iProjectHookAbi } from "../src/abi-hook.js";

const RPC = process.env.ABXFS_RPC_URL_84532;
const KEY = process.env.ABXFS_PRIVATE_KEY;
const live = Boolean(RPC && KEY);

describe.skipIf(!live)("live: the current org generation (ABX FS stores) on Base Sepolia", () => {
  const account = live ? privateKeyToAccount((KEY!.startsWith("0x") ? KEY! : `0x${KEY!}`) as Hex, { nonceManager }) : undefined; // nonceManager, as the CLI does: a load-balanced RPC lags
  const publicClient = live ? createPublicClient({ chain, transport: http(RPC!), pollingInterval: 1000 }) : undefined;
  const walletClient = live
    ? createWalletClient({ chain, transport: http(RPC!), account: account!, pollingInterval: 1000 })
    : undefined;

  it("creates an org, publishes a directory into it, reads it back, and refuses a root its stores do not hold", async () => {
    // Looked up here, not while collecting: a skipped suite's body still runs, and the registry refuses a chain
    // with no deployment.
    const addresses = requireCanonicalAddresses(84532);
    await autoRegisterNodeCodecs();
    const clients = { publicClient: publicClient!, walletClient: walletClient! };
    const contracts = { ...requireOrgContracts(addresses), hook: addresses.projectHook! };
    expect(await hookAcceptsContent(publicClient!, addresses, contracts.hook)).toBe(true);

    const stamp = new Date().toISOString().slice(0, 10);
    const created = await createOrg(clients, contracts.factory, { name: `Org Rehearsal ${stamp}` });
    console.log(`[live] createOrg tx ${created.txHash} org ${created.org} (token ${created.firstTokenId})`);

    const project: ProjectContracts = { collection: created.org, hook: contracts.hook };

    // Token 0 was minted by createOrg and has no content yet.
    const empty = await readProject(publicClient!, project, 0n);
    expect(empty.cid).toBeNull();
    expect(empty.kind).toBe(ProjectKind.Unset);

    // A small directory: index.html plus one asset, content-addressed in the stores.
    const enc = new TextEncoder();
    const salt = Date.now().toString(36);
    const files = [
      { path: "index.html", bytes: enc.encode(`<!doctype html><title>rehearsal ${salt}</title><img src="a.txt">`), mimeType: "text/html" },
      { path: "a.txt", bytes: enc.encode(`rehearsal asset ${salt}`), mimeType: "text/plain" },
    ];
    const applied = await applyNewProject(publicClient!, addresses, files);
    const located = await locateContent(publicClient!, addresses, applied.newRootCid).catch(() => undefined);
    void located; // not written yet; only meaningful after the publish below

    const result = await executeNewProjectPublish(clients, addresses, project, 0n, "Org rehearsal", applied, { tag: "v1" });
    console.log(`[live] publish tx ${result.publishTxHash} root ${result.rootCid} version ${result.versionNumber}`);
    expect(result.versionNumber).toBe(1n);
    expect((await locateContent(publicClient!, addresses, result.rootCid)).kind).toBe(ProjectKind.Directory);

    // The name is a separate, later transaction, and a load-balanced RPC may serve this read from a lagging replica:
    // retry the read until the name is visible (the same hazard `settle.ts` exists for).
    let read = await readProject(publicClient!, project, 0n);
    for (let i = 0; i < 10 && read.name === null; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      read = await readProject(publicClient!, project, 0n);
    }
    expect(read.cid?.toLowerCase()).toBe(result.rootCid.toLowerCase());
    expect(read.kind).toBe(ProjectKind.Directory);
    expect(read.versionCount).toBe(1);
    expect(read.name).toBe("Org rehearsal");
    const versions = (await publicClient!.readContract({
      address: contracts.hook,
      abi: iProjectHookAbi,
      functionName: "versionAt",
      args: [created.org, 0n, 1n],
    })) as { cid: Hex };
    expect(versions.cid.toLowerCase()).toBe(result.rootCid.toLowerCase());

    // A root its stores do not hold is refused. (A root from another store pair is the case that matters in practice;
    // to the hook it is the same thing: neither of ITS stores has it.)
    const strangerRoot = keccak256(toBytes(`not a root ${salt}`)) as AbxfsCid;
    expect((await locateContent(publicClient!, addresses, strangerRoot)).kind).toBe(ProjectKind.Unset);

    const second = await mintInOrg(clients, created.org, { addresses });
    await expect(
      publicClient!.simulateContract({
        address: created.org,
        abi: [
          {
            type: "function",
            name: "configureTokenParam",
            stateMutability: "nonpayable",
            inputs: [
              { name: "tokenId", type: "uint256" },
              { name: "key", type: "bytes32" },
              { name: "value", type: "bytes32" },
            ],
            outputs: [],
          },
        ] as const,
        functionName: "configureTokenParam",
        args: [second.tokenId, encodeParamKey(PROJECT_PARAM_KEYS.cid), strangerRoot],
        account: account!,
      }),
    ).rejects.toThrow(/0x9cb63a6e|RootNotFound/);
    console.log(`[live] root ${strangerRoot} refused by the hook (RootNotFound) on token ${second.tokenId}`);
  }, 600_000);
});
