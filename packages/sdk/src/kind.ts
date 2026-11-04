/**
 * Helpers for resolving the {@link ProjectKind} of an ABX FS root CID.
 *
 * Root CIDs are bare keccak256 hashes: the first byte does NOT encode whether the CID is a file or a directory. The only
 * authoritative way to tell is to ask the stores. `ProjectHook` runs exactly this probe at write time and locks the
 * result for the project's lifetime; {@link cidKind} runs the same probe from the SDK, on a loose CID or to predict
 * whether a publish will pass the hook's kind check before spending gas on it.
 */
import type { PublicClient } from "viem";

import { directoryStoreAbi, fileStoreAbi } from "./abi.js";
import { contentStores } from "./stores.js";
import { ProjectKind, type AbxfsCid, type ContractAddresses } from "./types.js";

/** What a root CID is. */
export interface ContentLocation {
  kind: ProjectKind;
}

/**
 * Ask both stores whether `cid` is theirs. The domain prefixes are disjoint, so a hit in both is an impossibility that
 * means a contract bug or a lying RPC, and this throws. A transport failure throws too; it never reads as "not found".
 * The empty directory always exists.
 */
export async function locateContent(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<ContentLocation> {
  const stores = contentStores(addresses);
  const [dir, file] = await Promise.all([
    publicClient.readContract({ address: stores.directoryStore, abi: directoryStoreAbi, functionName: "directoryExists", args: [cid] }),
    publicClient.readContract({ address: stores.fileStore, abi: fileStoreAbi, functionName: "fileExists", args: [cid] }),
  ]);
  if (dir === true && file === true) {
    throw new Error(
      `cidKind: ${cid} is registered as both a directory and a file — impossible under the ABX FS CID profile; a contract bug or an adversarial RPC.`,
    );
  }
  if (dir === true) return { kind: ProjectKind.Directory };
  if (file === true) return { kind: ProjectKind.File };
  return { kind: ProjectKind.Unset };
}

/**
 * The {@link ProjectKind} of `cid`: {@link ProjectKind.Unset} if neither store has it — the same value the hook's
 * `kindOf` returns for an unpublished project, so the two are directly comparable.
 */
export async function cidKind(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<ProjectKind> {
  return (await locateContent(publicClient, addresses, cid)).kind;
}
