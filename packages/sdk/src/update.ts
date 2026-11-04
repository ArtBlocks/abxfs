/**
 * Update flow: diff a local project against an on-chain directory tree, upload only the
 * changed files, build a new directory CID, and publish it as a new project version.
 *
 * The write-paths that used to live here are gone rather than ported. Ownership transfer
 * (`transferProjectOwnership` / `acceptProjectOwnership` / `cancelOwnershipTransfer`) is now an
 * ERC-721 transfer, and tag mutations moved to the hook — both in `project.ts`.
 */
import { assertValidPublishInputs } from "./validate.js";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import { cidKind } from "./kind.js";
import { emptyDirectoryChanges, walkDirectoryTree } from "./read.js";
import {
  uploadFiles,
  uploadSingleFile,
  type UploadOptions,
} from "./upload.js";
import { assertCanPublish, type ProjectContracts } from "./project.js";
import { assertHookAcceptsContent } from "./stores.js";
import { publishRootAndTag } from "./publish.js";
import type {
  AbxfsCid,
  ContractAddresses,
  FileCodec,
  FileDescriptor,
} from "./types.js";
import { ProjectKind } from "./types.js";
import { planUpload } from "./upload.js";

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  /** Expected new CID (for added / changed). */
  newCid?: AbxfsCid;
  /** Previous CID (for removed / changed / unchanged). */
  oldCid?: AbxfsCid;
}

export interface Diff {
  entries: DiffEntry[];
  changed: DiffEntry[];
  unchanged: DiffEntry[];
  /** Empty directories the local tree has that the on-chain one does not, and the reverse. */
  emptyDirectoriesAdded: string[];
  emptyDirectoriesRemoved: string[];
  rootChanged: boolean;
  newRootCid: AbxfsCid;
  oldRootCid: AbxfsCid;
}

/**
 * Compare a local set of files to the current on-chain directory tree. Returns a diff and the
 * expected new root directory CID.
 *
 * NOTE: computed CIDs use the codec and backends given (default: none, FastLZ per chunk); a file stored differently on
 * chain shows as `changed` even when its content is the same.
 */
export async function diffProject(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  existingRootCid: AbxfsCid,
  newFiles: FileDescriptor[],
  opts: { codec?: FileCodec; fastLz?: boolean; emptyDirectories?: readonly string[] } = {},
): Promise<Diff> {
  const plan = await planUpload(newFiles, { ...opts, addresses });
  const onChain = await walkDirectoryTree(publicClient, addresses, existingRootCid);

  const newMap = new Map(plan.files.map((f) => [f.path, f.cid]));
  const oldMap = new Map(onChain.files.map((f) => [f.path, f.cid]));

  const entries: DiffEntry[] = [];
  const seen = new Set<string>();

  for (const [path, newCid] of newMap) {
    seen.add(path);
    const oldCid = oldMap.get(path);
    if (!oldCid) entries.push({ path, kind: "added", newCid });
    else if (oldCid !== newCid) entries.push({ path, kind: "changed", oldCid, newCid });
    else entries.push({ path, kind: "unchanged", oldCid, newCid });
  }
  for (const [path, oldCid] of oldMap) {
    if (!seen.has(path)) entries.push({ path, kind: "removed", oldCid });
  }

  const changed = entries.filter((e) => e.kind !== "unchanged");
  const unchanged = entries.filter((e) => e.kind === "unchanged");

  const empties = emptyDirectoryChanges(onChain.emptyDirectories, opts.emptyDirectories ?? []);

  return {
    entries,
    changed,
    unchanged,
    emptyDirectoriesAdded: empties.added,
    emptyDirectoriesRemoved: empties.removed,
    rootChanged: plan.rootCid !== existingRootCid,
    newRootCid: plan.rootCid,
    oldRootCid: existingRootCid,
  };
}

export interface UpdateProjectArgs {
  /** The ABX collection + hook this project lives in. */
  project: ProjectContracts;
  /** The project's token id — what used to be `projectId`. */
  tokenId: bigint;
  existingRootCid: AbxfsCid;
  /**
   * New content for the project. Pass an array (length ≥ 1) for directory-kind projects;
   * pass a single {@link FileDescriptor} for file-kind projects. The kind is derived from
   * the project's existing root via {@link cidKind} and a mismatch (e.g. supplying an
   * array for a file project) throws before any tx is sent.
   */
  newContent: FileDescriptor[] | FileDescriptor;
  opts?: UploadOptions;
  /** Point this tag at the new version once it is proven to be the one just published. */
  tag?: string;
}

/**
 * Upload delta + publish a new version. Branches on the project's existing root kind (derived by
 * probing `FileStore` / `DirectoryStore`) to run either the multi-file directory path or the
 * single-file path.
 *
 * The resulting root is published by writing the `abxfs.cid` PostParam on the project's ABX token.
 * The kind check below is a client-side courtesy that fails before any gas is spent; the binding
 * one is the configure hook, which re-derives the kind on-chain and reverts `RootKindLocked`.
 */
export async function updateProject(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  addresses: ContractAddresses,
  args: UpdateProjectArgs,
): Promise<{ newRootCid: AbxfsCid; txHash: Hex; tagTxHash?: Hex; versionNumber: bigint }> {
  assertValidPublishInputs({ tag: args.tag });
  const existingKind = await cidKind(
    clients.publicClient,
    addresses,
    args.existingRootCid,
  );
  // `cidKind` reports `Unset` (not null) for a CID in neither store, matching the hook's `kindOf`.
  // Checking for null here silently passed an unresolvable root through to the upload path, where it
  // failed much later with an unrelated message.
  if (existingKind === ProjectKind.Unset) {
    throw new Error(
      `updateProject: existing root CID ${args.existingRootCid} is not registered in either content store`,
    );
  }

  const isSingleFile = !Array.isArray(args.newContent);
  if (existingKind === ProjectKind.File && !isSingleFile) {
    throw new Error(
      "updateProject: project is file-kind but `newContent` is an array — pass a single FileDescriptor instead.",
    );
  }
  if (existingKind === ProjectKind.Directory && isSingleFile) {
    throw new Error(
      "updateProject: project is directory-kind but `newContent` is a single FileDescriptor — pass an array of FileDescriptors instead.",
    );
  }

  // Before ANY content is uploaded: the signer holds the token and the head is what this update builds on.
  await assertCanPublish(clients.publicClient, args.project, args.tokenId, clients.walletClient.account?.address, {
    expectedHead: args.existingRootCid,
  });
  // A hook bound to other stores would veto the root after the upload was paid for.
  await assertHookAcceptsContent(clients.publicClient, addresses, args.project.hook);

  let newRootCid: AbxfsCid;
  if (existingKind === ProjectKind.File) {
    const result = await uploadSingleFile(
      clients,
      addresses,
      args.newContent as FileDescriptor,
      args.opts ?? {},
    );
    newRootCid = result.rootCid;
  } else {
    const result = await uploadFiles(
      clients,
      addresses,
      args.newContent as FileDescriptor[],
      args.opts ?? {},
    );
    newRootCid = result.rootCid;
  }

  if (newRootCid === args.existingRootCid) {
    throw new Error("new content is identical to existing root; nothing to publish");
  }
  // The shared publish-and-tag path: counts before, takes the version from the receipt's own event,
  // proves it with a settled read, and only then tags. See publish.ts.
  const published = await publishRootAndTag(
    clients,
    args.project,
    args.tokenId,
    newRootCid,
    args.tag ? { tag: args.tag } : {},
  );
  return {
    newRootCid,
    txHash: published.publishTxHash,
    ...(published.tagTxHash ? { tagTxHash: published.tagTxHash } : {}),
    versionNumber: published.versionNumber,
  };
}
