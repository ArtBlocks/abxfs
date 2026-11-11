/**
 * LIVE throwaway rehearsal on ANY chain in the registry (docs/deploy-runbook.md, "The throwaway rehearsal"): the check
 * that must pass on a chain before its factory address is announced. Skipped unless ABXFS_REHEARSAL_CHAIN,
 * ABXFS_RPC_URL_<chain> and ABXFS_PRIVATE_KEY are set. It spends real funds on a production chain and creates an org
 * (permanent and harmless). Run from this package with the environment loaded in a subshell:
 *
 *   ( set -a; . ../../.env; set +a; ABXFS_REHEARSAL_CHAIN=8453 npx vitest run test/rehearsal-live.test.ts --reporter=verbose )
 *
 * Set ABXFS_REHEARSAL_ADDRESSES to a JSON file containing the candidate ContractAddresses bundle
 * before canonical promotion. The presentation lane reuses token 0 for two further publishes and
 * exercises native reads, delivery choices, endpoints and a permanent reviewed content lock.
 *
 * createOrg -> publish a two-file directory to token 0 with a tag -> read the project and the version back ->
 * decode tokenURI and contractURI: the token is named after its project, its links use the frozen gateway base, and the
 * collection document (OrgMeta) carries the org's name, its description, a logo, a banner and the site link.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { rehearsalAddresses, rehearsalChain } from "./helpers/rehearsal-config.js";

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { AbxfsClient } from "../src/abxfs.js";
import { PresentationLock, PresentationMethod, PresentationSelection, PresentationStatus, presentationVersion, recommendPresentationMethod } from "../src/presentation.js";
import { lookupEntry } from "../src/read.js";
import { verifyOnChainIpfsCid } from "../src/verify.js";
import { publishRootAndTag } from "../src/publish.js";
import { applyNewProject, executeNewProjectPublish } from "../src/draft.js";
import { locateContent } from "../src/kind.js";
import { createOrg, requireOrgContracts } from "../src/org.js";
import { readProject, type ProjectContracts } from "../src/project.js";
import { hookAcceptsContent } from "../src/stores.js";
import { ProjectKind } from "../src/types.js";
import { iProjectPresentationAbi } from "../src/abi-presentation.js";
import { iProjectHookAbi } from "../src/abi-hook.js";

/** The gateway base frozen into `OrgMeta` on every listed chain (`script/Deploy.s.sol`, `_gatewayAllowed`). */
const GATEWAY_BASE = "https://fs.abx.io";
const CHAIN_ID = Number(process.env.ABXFS_REHEARSAL_CHAIN ?? 0);
const chain = rehearsalChain(CHAIN_ID);
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
    const addresses = rehearsalAddresses(CHAIN_ID, process.env.ABXFS_REHEARSAL_ADDRESSES);
    expect(await publicClient!.getChainId()).toBe(CHAIN_ID);
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
    const imageBytes = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
    const files = [
      { path: "index.html", bytes: enc.encode(`<!doctype html><title>rehearsal ${salt}</title><p>ABX FS rehearsal</p><img src="asset.gif">`), mimeType: "text/html" },
      { path: "asset.gif", bytes: imageBytes, mimeType: "image/gif" },
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
    if (addresses.projectPresentation) {
      expect(String(token.animation_url).toLowerCase()).toContain(`/g/cid/${CHAIN_ID}/${result.rootCid.toLowerCase()}/`);
    } else {
      expect(String(token.animation_url).toLowerCase()).toContain(created.org.toLowerCase().slice(2));
    }
    expect(typeof token.image).toBe("string");

    if (addresses.projectPresentation) {
      expect(addresses.contentReader).toBeDefined();
      const sdk = new AbxfsClient({ ...clients, addresses, org: created.org });
      expect(await presentationVersion(publicClient!, addresses)).toBe(2);
      const assertEvent = async (hash: Hex, eventName: string, expected: Record<string, unknown>) => {
        const receipt = await publicClient!.getTransactionReceipt({ hash });
        expect(receipt.status).toBe("success");
        const events = parseEventLogs({ abi: iProjectPresentationAbi, logs: receipt.logs })
          .filter((event) => event.address.toLowerCase() === addresses.projectPresentation!.toLowerCase() && event.eventName === eventName);
        expect(events).toHaveLength(1);
        expect(events[0]!.args).toMatchObject(expected);
      };
      // Caller-selected native-read limits; v2 presentation itself imposes no byte/chunk policy.
      const limits = { maxBytes: 102_400n, maxChunks: 64n };
      const index = await lookupEntry(publicClient!, addresses, result.rootCid, "index.html");
      expect((await sdk.readNativeFile(index.cid, limits)).bytes).toEqual(files[0]!.bytes);
      const image = await lookupEntry(publicClient!, addresses, result.rootCid, "asset.gif");
      const nativeImage = await sdk.readNativeFile(image.cid, limits);
      expect(nativeImage.mimeType).toBe("image/gif");
      expect(nativeImage.bytes).toEqual(imageBytes);
      expect((await sdk.readNativePath(result.rootCid, "index.html", limits)).bytes).toEqual(files[0]!.bytes);
      expect((await sdk.readNativePath(result.rootCid, "", limits)).bytes).toEqual(files[0]!.bytes);
      expect((await recommendPresentationMethod(publicClient!, addresses, result.rootCid)).method).toBe(PresentationMethod.ChainGateway);

      // Keep the same token. Decoded HTML exceeds the historical 8 KiB ceiling while remaining self-contained.
      const embeddedBytes = enc.encode(`<!doctype html><title>embedded ${salt}</title><p>self-contained</p><!--${"onchain ".repeat(1_200)}-->`);
      expect(embeddedBytes.length).toBeGreaterThan(8_192);
      const next = await applyNewProject(publicClient!, addresses, [{ path: "index.html", bytes: embeddedBytes, mimeType: "text/html" }]);
      const second = await executeNewProjectPublish(clients, addresses, project, 0n, "", next, { expectedHead: result.rootCid });
      expect(second.versionNumber).toBe(2n);
      expect((await recommendPresentationMethod(publicClient!, addresses, second.rootCid)).method).toBe(PresentationMethod.Embedded);
      const targetHash = await sdk.configurePresentationTarget(0n, { selection: PresentationSelection.Latest, path: "" });
      await assertEvent(targetHash, "TargetChanged", { org: created.org, tokenId: 0n, selection: PresentationSelection.Latest, version: 0, tag: "", path: "" });
      expect((await sdk.readPresentation(0n)).configuredFlags! & PresentationLock.Content).toBe(PresentationLock.Content);
      const embeddedHash = await sdk.setPresentationMethod(0n, "auto");
      await assertEvent(embeddedHash, "MethodChanged", { org: created.org, tokenId: 0n, method: PresentationMethod.Embedded });
      expect((await sdk.readPresentation(0n)).configuredFlags! & 3).toBe(3);
      let preview = await sdk.previewPresentation(0n);
      expect(preview.method).toBe(PresentationMethod.Embedded);
      expect(preview.status).toBe(PresentationStatus.Ready);
      expect(preview.contentType).toBe("text/html");
      expect(preview.bytes).toEqual(embeddedBytes);
      const embeddedToken = decodeJsonUri(await publicClient!.readContract({ address: created.org, abi: uriAbi, functionName: "tokenURI", args: [0n] }));
      expect(embeddedToken.animation_url).toBe(`data:text/html;base64,${Buffer.from(embeddedBytes).toString("base64")}`);
      const verification = await sdk.verifyPresentationTokenUri(0n, { afterTransactionHash: embeddedHash });
      expect(verification.ok).toBe(true);
      expect(verification.status).toBe("ready");
      expect((await sdk.readNativePath(second.rootCid, "", limits)).bytes).toEqual(embeddedBytes);
      console.log(`[rehearsal ${CHAIN_ID}] embedded decodedBytes=${embeddedBytes.length} presentationVersion=2 exact tokenURI bytes verified`);

      await sdk.setPresentationMethod(0n, PresentationMethod.ChainGateway);
      preview = await sdk.previewPresentation(0n);
      expect(preview.status).toBe(PresentationStatus.Ready);
      const chainUri = `${GATEWAY_BASE}/g/cid/${CHAIN_ID}/${second.rootCid}/`;
      expect(new TextDecoder().decode(preview.bytes)).toBe(chainUri);
      const endpointsHash = await sdk.setPresentationEndpoints(0n, { chainBase: "https://gateway.example", ipfsBase: "https://dweb.link" });
      await assertEvent(endpointsHash, "EndpointsChanged", { org: created.org, tokenId: 0n, chainBase: "https://gateway.example", ipfsBase: "https://dweb.link" });
      expect((await sdk.readPresentation(0n)).configuredFlags).toBe(7);
      expect(new TextDecoder().decode((await sdk.previewPresentation(0n)).bytes)).toBe(chainUri.replace(GATEWAY_BASE, "https://gateway.example"));
      const ipfsCid = await verifyOnChainIpfsCid(publicClient!, addresses, second.rootCid);
      await sdk.setPresentationMethod(0n, PresentationMethod.Ipfs);
      preview = await sdk.previewPresentation(0n);
      expect(preview.status).toBe(PresentationStatus.Ready);
      expect(new TextDecoder().decode(preview.bytes)).toBe(`https://${ipfsCid}.ipfs.dweb.link/`);
      await sdk.setPresentationEndpoints(0n, { chainBase: "", ipfsBase: "" });
      preview = await sdk.previewPresentation(0n);
      expect(new TextDecoder().decode(preview.bytes)).toBe(`ipfs://${ipfsCid}/`);
      // Derivation proves the URI, not pinning or remote availability. Finish on the chain gateway.
      await sdk.setPresentationMethod(0n, PresentationMethod.ChainGateway);
      const reviewed = await sdk.previewPresentation(0n);
      expect(reviewed.root?.toLowerCase()).toBe(second.rootCid.toLowerCase());
      const commitment = await sdk.readPresentationLockCommitment(0n, PresentationLock.Content, reviewed.blockNumber);
      const lockHash = await sdk.lockPresentation(0n, PresentationLock.Content, commitment);
      await assertEvent(lockHash, "PresentationLocked", { org: created.org, tokenId: 0n, locks: PresentationLock.Content, frozenRoot: second.rootCid });
      const third = await publishRootAndTag(clients, project, 0n, result.rootCid);
      expect(third.versionNumber).toBe(3n);
      expect((await sdk.readProject(0n)).cid?.toLowerCase()).toBe(result.rootCid.toLowerCase());
      const frozen = await sdk.inspectPresentation(0n);
      expect(frozen.root?.toLowerCase()).toBe(second.rootCid.toLowerCase());
      expect(frozen.path).toBe("");
      expect(frozen.locks & PresentationLock.Content).toBe(PresentationLock.Content);
      expect(frozen.configuredFlags).toBe(7);
      expect(new TextDecoder().decode((await sdk.previewPresentation(0n)).bytes)).toBe(chainUri);
    }
  }, 900_000);
});
