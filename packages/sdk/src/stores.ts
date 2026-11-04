/**
 * The content stores an address book names, and whether a project hook validates against them.
 *
 * ABX FS has one store pair per deployment (`ChunkStore` underneath `FileStore` and `DirectoryStore`); a root is in
 * exactly one of the two (the CID domain prefixes are disjoint). An org's hook is bound to one pair forever, so before
 * publishing into an org it is worth checking that the hook asks the same stores the content was written to.
 */
import type { Address, PublicClient } from "viem";

import { chunkStoreAbi, directoryStoreAbi, fileStoreAbi } from "./abi.js";
import type { ContractAddresses } from "./types.js";

/**
 * `fileStoreAbi` plus the `ChunkStore` errors a `FileStore` call bubbles up unchanged: a leaf naming a chunk that is not
 * written reverts `ChunkNotFound` from `putChunkNode`, and `readChunk` passes on `RetrieveFailed` and `DataMismatch`.
 * Every FileStore call site decodes through this, so those read as what they are rather than as raw selectors. The
 * mirror itself stays exactly what `forge inspect` reports for `FileStore` (the abi-drift test).
 */
export const fileStoreCallAbi = [...fileStoreAbi, ...chunkStoreAbi.filter((e) => e.type === "error")] as const;

/**
 * Errors a content WRITE can revert with that a store's own ABI may not declare, because they are raised in a library
 * or a backend and bubble up unchanged: Solady SSTORE2's `DeploymentFailed()` (a CREATE2 that returned no address,
 * which is how running out of gas while storing code surfaces), and CodeStore's `DataSize(uint256)` and
 * `NoFreeAddress()` (raised inside an SSTORE2 backend under `ChunkStore.write`; FileStore and DirectoryStore declare
 * them).
 */
export const contentWriteErrorsAbi = [
  { type: "error", name: "DeploymentFailed", inputs: [] },
  { type: "error", name: "DataSize", inputs: [{ name: "size", type: "uint256" }] },
  { type: "error", name: "NoFreeAddress", inputs: [] },
] as const;

/** `abi` plus each error of `extra` it does not already declare (by name), so a decoder never sees a duplicate. */
function withErrors(abi: readonly unknown[], extra: readonly { type: "error"; name: string }[]): readonly unknown[] {
  const have = new Set(
    (abi as ReadonlyArray<{ type: string; name?: string }>).filter((e) => e.type === "error").map((e) => e.name),
  );
  return [...abi, ...extra.filter((e) => !have.has(e.name))];
}

/**
 * The ABIs the content stages are simulated and sent with: each store's, plus {@link contentWriteErrorsAbi}, so every
 * revert a write can bubble decodes by name. The mirrors in `abi.ts` stay exactly what `forge inspect` reports.
 */
export const chunkStoreWriteAbi = withErrors(chunkStoreAbi, contentWriteErrorsAbi);
export const fileStoreWriteAbi = withErrors(fileStoreCallAbi, contentWriteErrorsAbi);
export const directoryStoreWriteAbi = withErrors(directoryStoreAbi, contentWriteErrorsAbi);

/** The three content stores. */
export interface ContentStores {
  chunkStore: Address;
  fileStore: Address;
  directoryStore: Address;
}

/** The content stores of an address book, or a clear error naming what is missing. */
export function contentStores(addresses: ContractAddresses): ContentStores {
  const { chunkStore, fileStore, directoryStore } = addresses;
  if (!chunkStore || !fileStore || !directoryStore) {
    throw new Error(
      "this address book has no ABX FS content stores (`chunkStore`, `fileStore`, `directoryStore`): the chain has no " +
        "deployment, or the configuration is incomplete. Nothing was read or written.",
    );
  }
  return { chunkStore, fileStore, directoryStore };
}

const hookStoresAbi = [
  { type: "function", name: "fileStore", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "directoryStore", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Does `hook` (a `ProjectHook`) validate roots against the store pair in `addresses`?
 *
 * A hook is immutable and asks only ITS OWN stores whether a root exists, so publishing a root into an org whose hook
 * is bound to other stores is vetoed `RootNotFound` after the content has been paid for. This reads the binding
 * straight from the hook, which is the only authority. Returns false (never throws) when the hook cannot be read.
 */
export async function hookAcceptsContent(
  client: PublicClient,
  addresses: ContractAddresses,
  hook: Address,
): Promise<boolean> {
  try {
    const stores = contentStores(addresses);
    const [f, d] = await Promise.all([
      client.readContract({ address: hook, abi: hookStoresAbi, functionName: "fileStore" }),
      client.readContract({ address: hook, abi: hookStoresAbi, functionName: "directoryStore" }),
    ]);
    return (
      (f as string).toLowerCase() === stores.fileStore.toLowerCase() &&
      (d as string).toLowerCase() === stores.directoryStore.toLowerCase()
    );
  } catch {
    return false;
  }
}

/** Refuse, before any content is written, to publish into a hook bound to other stores. */
export async function assertHookAcceptsContent(
  client: PublicClient,
  addresses: ContractAddresses,
  hook: Address,
): Promise<void> {
  if (await hookAcceptsContent(client, addresses, hook)) return;
  throw new Error(
    `the project hook ${hook} does not validate roots against this deployment's stores (or could not be read), so it ` +
      "would veto the root after the content was paid for. Use an org of this deployment's generation. Nothing was written.",
  );
}
