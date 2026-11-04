/**
 * LIVE throwaway rehearsal on ANY chain in the registry (docs/deploy-runbook.md, "The throwaway rehearsal"): the check
 * that must pass on a chain before its factory address is announced. Skipped unless ABXFS_REHEARSAL_CHAIN,
 * ABXFS_RPC_URL_<chain> and ABXFS_PRIVATE_KEY are set. It spends real funds on a production chain and creates an org
 * (permanent and harmless). Run from this package with the environment loaded in a subshell:
 *
 *   ( set -a; . ../../.env; set +a; ABXFS_REHEARSAL_CHAIN=8453 npx vitest run test/rehearsal-live.test.ts --reporter=verbose )
 *
 * createOrg -> publish a two-file directory to token 0 with a tag -> read the project and the version back ->
 * decode tokenURI and contractURI: the token is named after its project, its links use the frozen gateway base, and the
 * collection document (OrgMeta) carries the org's name, its description, a logo, a banner and the site link.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, sepolia } from "viem/chains";

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { requireCanonicalAddresses } from "../src/canonical.js";
import { applyNewProject, executeNewProjectPublish } from "../src/draft.js";
import { locateContent } from "../src/kind.js";
import { createOrg, requireOrgContracts } from "../src/org.js";
import { readProject, type ProjectContracts } from "../src/project.js";
import { hookAcceptsContent } from "../src/stores.js";
import { ProjectKind } from "../src/types.js";
import { iProjectHookAbi } from "../src/abi-hook.js";

const CHAINS: Record<number, Chain> = { 8453: base, 84532: baseSepolia, 1: mainnet, 11155111: sepolia, 42161: arbitrum, 421614: arbitrumSepolia };
/** The gateway base frozen into `OrgMeta` on every listed chain (`script/Deploy.s.sol`, `_gatewayAllowed`). */
const GATEWAY_BASE = "https://fs.abx.io";
const CHAIN_ID = Number(process.env.ABXFS_REHEARSAL_CHAIN ?? 0);
const chain = CHAINS[CHAIN_ID];
const RPC = process.env[`ABXFS_RPC_URL_${CHAIN_ID}`];
const KEY = process.env.ABXFS_PRIVATE_KEY;
const live = Boolean(chain && RPC && KEY);

const uriAbi = [
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "contractURI", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

function decodeJsonUri(uri: string): Record<string, unknown> {
  const b64 = "data:application/json;base64,";
  if (uri.startsWith(b64)) return JSON.parse(Buffer.from(uri.slice(b64.length), "base64").toString("utf8"));
  const plain = uri.indexOf(",");
  return JSON.parse(decodeURIComponent(uri.slice(plain + 1)));
}

describe.skipIf(!live)(`live: throwaway rehearsal on chain ${CHAIN_ID}`, () => {
  const account = live ? privateKeyToAccount((KEY!.startsWith("0x") ? KEY! : `0x${KEY!}`) as Hex, { nonceManager }) : undefined;
  const publicClient = live ? createPublicClient({ chain, transport: http(RPC!), pollingInterval: 1000 }) : undefined;
  const walletClient = live ? createWalletClient({ chain, transport: http(RPC!), account: account!, pollingInterval: 1000 }) : undefined;

  it("creates an org, publishes a directory with a tag, and reads the project and its metadata back", async () => {
    const addresses = requireCanonicalAddresses(CHAIN_ID);
    await autoRegisterNodeCodecs();
    const clients = { publicClient: publicClient!, walletClient: walletClient! };
    const contracts = { ...requireOrgContracts(addresses), hook: addresses.projectHook! };
    expect(await hookAcceptsContent(publicClient!, addresses, contracts.hook)).toBe(true);

    const stamp = new Date().toISOString().slice(0, 10);
    const orgName = `Rehearsal ${stamp}`;
    const description = `Throwaway rehearsal org for the ABX FS deploy on ${stamp}.\nNothing here is meant to be used.`;
    const created = await createOrg(clients, contracts.factory, { name: orgName, description });
    console.log(`[rehearsal ${CHAIN_ID}] createOrg tx ${created.txHash} org ${created.org} (token ${created.firstTokenId})`);
    const project: ProjectContracts = { collection: created.org, hook: contracts.hook };

    const empty = await readProject(publicClient!, project, 0n);
    expect(empty.cid).toBeNull();
    expect(empty.kind).toBe(ProjectKind.Unset);

    const enc = new TextEncoder();
    const salt = Date.now().toString(36);
    const files = [
      { path: "index.html", bytes: enc.encode(`<!doctype html><title>rehearsal ${salt}</title><p>ABX FS rehearsal</p><img src="a.txt">`), mimeType: "text/html" },
      { path: "a.txt", bytes: enc.encode(`rehearsal asset ${salt}`), mimeType: "text/plain" },
    ];
    const applied = await applyNewProject(publicClient!, addresses, files);
    const result = await executeNewProjectPublish(clients, addresses, project, 0n, "Rehearsal", applied, { tag: "v1" });
    console.log(`[rehearsal ${CHAIN_ID}] publish tx ${result.publishTxHash} root ${result.rootCid} version ${result.versionNumber}`);
    expect(result.versionNumber).toBe(1n);
    expect((await locateContent(publicClient!, addresses, result.rootCid)).kind).toBe(ProjectKind.Directory);

    let read = await readProject(publicClient!, project, 0n);
    for (let i = 0; i < 10 && read.name === null; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      read = await readProject(publicClient!, project, 0n);
    }
    expect(read.cid?.toLowerCase()).toBe(result.rootCid.toLowerCase());
    expect(read.kind).toBe(ProjectKind.Directory);
    expect(read.versionCount).toBe(1);
    expect(read.name).toBe("Rehearsal");
    const version = (await publicClient!.readContract({
      address: contracts.hook,
      abi: iProjectHookAbi,
      functionName: "versionAt",
      args: [created.org, 0n, 1n],
    })) as { cid: Hex };
    expect(version.cid.toLowerCase()).toBe(result.rootCid.toLowerCase());

    // Metadata: the org's own name, and links built on the frozen gateway base.
    expect(await publicClient!.readContract({ address: created.org, abi: uriAbi, functionName: "name" })).toBe(orgName);
    const token = decodeJsonUri(await publicClient!.readContract({ address: created.org, abi: uriAbi, functionName: "tokenURI", args: [0n] }));
    const collection = decodeJsonUri(await publicClient!.readContract({ address: created.org, abi: uriAbi, functionName: "contractURI" }));
    console.log(`[rehearsal ${CHAIN_ID}] tokenURI name=${String(token.name)} description=${JSON.stringify(token.description)} animation_url=${String(token.animation_url)} external_url=${String(token.external_url)}`);
    console.log(
      `[rehearsal ${CHAIN_ID}] contractURI name=${String(collection.name)} description=${JSON.stringify(collection.description)} external_link=${String(collection.external_link)} image=${String(collection.image).slice(0, 40)}… banner_image=${String(collection.banner_image).slice(0, 40)}…`,
    );
    expect(token.name).toBe("Rehearsal");
    expect(token.description).toBe(description);
    expect(collection.name).toBe(orgName);
    expect(collection.description).toBe(description);
    expect(collection.external_link).toBe(GATEWAY_BASE);
    expect(String(collection.image)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(String(collection.banner_image)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(String(token.animation_url).startsWith(`${GATEWAY_BASE}/`)).toBe(true);
    expect(String(token.external_url).startsWith(`${GATEWAY_BASE}/`)).toBe(true);
    expect(String(token.animation_url).toLowerCase()).toContain(created.org.toLowerCase().slice(2));
    expect(typeof token.image).toBe("string");
  }, 900_000);
});
