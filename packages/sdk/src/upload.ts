/**
 * Upload flow for ABX FS: chunk (with an optional file codec), choose a backend per chunk, write the chunks to
 * `ChunkStore`, build the chunk-node tree and `createFile`, then entry nodes and `createDirectory` bottom-up. All of it
 * is planned and executed by the shared pipeline in `content-write.ts`; there is no second write path.
 *
 * Chunks are deduplicated by `ChunkStore` (an existing id is a no-op) and the planner probes what already exists, so
 * re-running an interrupted upload writes only what is left.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import { uploadContent } from "./draft.js";
import { ZERO_HASH } from "./cid.js";
import {
  buildContentStages,
  probeContentPlan,
  runContentStages,
  type FileToPlan,
  type PublishPhase,
  type PublishProgress,
} from "./content-write.js";
import { assertDirectoryFits, assertFileFits, resolveBundleLimits, resolveSingleCallLimits } from "./gas.js";
import { resolveGasSchedule, type GasSchedule } from "./gas-schedule.js";
import { contentStores } from "./stores.js";
import type { AbxfsCid, ContractAddresses, DirectoryEntry, FileCodec, FileDescriptor, UploadedFile } from "./types.js";
import { inferMimeType, validateRelativePath } from "./util.js";
import {
  assertUploadPaths,
  planBackendsFor,
  planDirectoryTree,
  planFile,
  planUploadOffline,
  type PlanBackends,
  type PlannedDirectory,
  type PlannedUploadFile,
} from "./plan.js";

export interface UploadOptions {
  /** File codec for every file (off chain, decoded by readers). Default none: chunks use FastLZ where it helps. */
  codec?: FileCodec;
  /** Per-chunk FastLZ through the FastLZ backend (default true; ignored for files with a codec). */
  fastLz?: boolean;
  /** Backends to write through. Default: the address book's recommended ones (`planBackendsFor`). */
  backends?: PlanBackends;
  /** Directories to create even though no file is in them. */
  emptyDirectories?: readonly string[];
  /** Called after each file upload. Useful for progress reporting. */
  onFileUploaded?: (file: UploadedFile) => void;
  /** Called after each directory create. */
  onDirectoryCreated?: (cid: AbxfsCid, entries: DirectoryEntry[]) => void;
  /** Called after each multicall bundle is broadcast (one tx). */
  onBundleSent?: (info: { target: Address; callCount: number; estimatedGas: number; txHash: Hex }) => void;
  /** If true, only plan the upload — no transactions sent. */
  dryRun?: boolean;
  /** Phase-level callback: fires when the writer enters chunks, files or directories. */
  onPhase?: (phase: PublishPhase) => void;
  /** Node-level progress, after every content transaction: stage, level, counts, transactions done and total. */
  onProgress?: (event: PublishProgress) => void;
  /**
   * Maximum estimated gas per bundle in the dimension the per-transaction cap counts: all of it on a legacy chain, the
   * execution part under EIP-8037. Defaults to 12,000,000, always clamped to a safe fraction of 2^24. Pass
   * `blockGasLimit` to additionally clamp by the live block ceiling.
   */
  maxBundleGas?: number;
  /** When provided, a bundle's total also stays under `blockGasLimit * bundleGasSafetyFactor`. */
  blockGasLimit?: bigint;
  /** Defaults to 0.8. Only applied when `blockGasLimit` is supplied. */
  bundleGasSafetyFactor?: number;
  /** The chain's gas schedule. Default: asked of the node (`detectGasSchedule`). */
  gasSchedule?: GasSchedule;
  /**
   * Under EIP-8037, the most gas the node will simulate for one transaction (default 50M, geth's and reth's
   * `--rpc.gascap`). Raise it only for a node configured to simulate more.
   */
  simulationGasCap?: number;
}

export interface UploadPlan {
  files: Array<UploadedFile & { existedOnChain: boolean }>;
  /** Root CID for this upload: the directory root, or for a single-file upload the file CID itself. */
  rootCid: AbxfsCid;
  /** What `rootCid` resolves to — mirrors `IProjectHook.ContentKind` on chain. */
  rootKind: "directory" | "file";
  ipfsRootCid?: string;
}

export interface UploadResult extends UploadPlan {
  txHashes: Hex[];
}

function backendsOf(addresses: ContractAddresses, opts: UploadOptions): PlanBackends {
  return opts.backends ?? planBackendsFor(addresses);
}

/** Upload a flat list of files and build a directory tree (rooted at ""). Paths are POSIX and may nest. */
export async function uploadFiles(
  clients: { publicClient: PublicClient; walletClient?: WalletClient },
  addresses: ContractAddresses,
  files: FileDescriptor[],
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const backends = backendsOf(addresses, opts);
  // Before anything is planned or sent: valid, literal, and each path once.
  assertUploadPaths(files.map((f) => f.path), opts.emptyDirectories);
  const described = files.map((f) => ({ ...f, mimeType: f.mimeType || inferMimeType(f.path) }));
  const shape = {
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.fastLz !== undefined ? { fastLz: opts.fastLz } : {}),
    ...(opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {}),
  };

  if (opts.dryRun) {
    // Pure: every CID and the whole node tree, no chain. Refuses (PlanTooLargeError) what could not be written.
    const plan = await planUploadOffline(described, { backends, ...shape });
    const uploaded = plan.files.map((p, i) => toUploaded(p, described[i]!.bytes, false));
    for (const u of uploaded) opts.onFileUploaded?.(u);
    for (const d of plan.directories) opts.onDirectoryCreated?.(d.cid, d.entries);
    return { files: uploaded, rootCid: plan.rootCid, rootKind: "directory", txHashes: [] };
  }

  if (!clients.walletClient) throw new Error("walletClient required for writes");
  // The batched pipeline shared with the web (`uploadContent`): every file's chunks share bundles, every probe is
  // one batched read, and what already exists is not written again.
  const { applied, plan, txHashes: hashes } = await uploadContent(
    { publicClient: clients.publicClient, walletClient: clients.walletClient },
    addresses,
    described,
    {
      backends,
      ...shape,
      ...(opts.maxBundleGas !== undefined ? { maxBundleGas: opts.maxBundleGas } : {}),
      ...(opts.blockGasLimit !== undefined ? { blockGasLimit: Number(opts.blockGasLimit) } : {}),
      ...(opts.bundleGasSafetyFactor !== undefined ? { bundleGasSafetyFactor: opts.bundleGasSafetyFactor } : {}),
      ...(opts.gasSchedule ? { gasSchedule: opts.gasSchedule } : {}),
      ...(opts.simulationGasCap !== undefined ? { simulationGasCap: opts.simulationGasCap } : {}),
      ...(opts.onBundleSent ? { onBundleSent: opts.onBundleSent } : {}),
      ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    },
  );
  const created = new Set(plan.filesToCreate.map((f) => f.cid));
  const byPath = new Map(described.map((f) => [f.path, f]));
  const uploaded = applied.files.map((p) => {
    const src = byPath.get(p.path)!;
    const entry: UploadedFile & { existedOnChain: boolean } = {
      cid: p.newCid!,
      codec: p.codec ?? ZERO_HASH,
      chunkIds: p.chunkIds ?? [],
      storedBytesLength: (p.newChunks ?? []).reduce((n, c) => n + c.input.length, 0),
      outputHash: p.outputHash ?? ZERO_HASH,
      mimeType: p.mimeType ?? src.mimeType,
      bytes: src.bytes,
      path: p.path,
      existedOnChain: !created.has(p.newCid!),
    };
    opts.onFileUploaded?.(entry);
    return entry;
  });
  const { directories } = planDirectoryTree(
    uploaded.map((u) => ({ path: u.path, cid: u.cid })),
    opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {},
  );
  for (const dir of directories) opts.onDirectoryCreated?.(dir.cid, dir.entries);
  return { files: uploaded, rootCid: applied.newRootCid, rootKind: "directory", txHashes: hashes };
}

function toUploaded(p: PlannedUploadFile, bytes: Uint8Array, existedOnChain: boolean): UploadedFile & { existedOnChain: boolean } {
  return {
    cid: p.cid,
    codec: p.codec,
    chunkIds: p.chunkIds,
    storedBytesLength: p.storedSize,
    outputHash: p.outputHash,
    mimeType: p.mimeType,
    bytes,
    path: p.path,
    existedOnChain,
  };
}

/** A planned file in the shape the content writer takes. */
export function fileToPlan(p: PlannedUploadFile): FileToPlan {
  return { cid: p.cid, chunks: p.chunks, mimeType: p.mimeType, codec: p.codec, outputHash: p.outputHash, tree: p.tree };
}

/**
 * Upload a single file and return it as the root of an upload plan: for a "file-kind" project, whose root CID is a
 * file rather than a directory. Pair it with `publishVersion`: the hook probes the stores to derive the kind.
 */
export async function uploadSingleFile(
  clients: { publicClient: PublicClient; walletClient?: WalletClient },
  addresses: ContractAddresses,
  file: FileDescriptor,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const txHashes: Hex[] = [];
  validateRelativePath(file.path);
  const mimeType = file.mimeType || inferMimeType(file.path);
  const uploaded = await uploadFile(clients, addresses, file.bytes, mimeType, opts, opts.dryRun ?? false, txHashes);
  uploaded.path = file.path;
  opts.onFileUploaded?.(uploaded);
  return { files: [uploaded], rootCid: uploaded.cid, rootKind: "file", txHashes };
}

type WriteClients = { publicClient: PublicClient; walletClient?: WalletClient };
type WriteOpts = Pick<
  UploadOptions,
  "maxBundleGas" | "blockGasLimit" | "bundleGasSafetyFactor" | "gasSchedule" | "simulationGasCap" | "onBundleSent" | "onPhase" | "onProgress"
>;

/**
 * Write planned files and directories through the one pipeline: probe what exists, build the stages, run them.
 * Returns which of the given file CIDs were created (the rest were already on chain).
 */
async function writePlanned(
  clients: WriteClients,
  addresses: ContractAddresses,
  files: FileToPlan[],
  directories: PlannedDirectory[],
  rootCid: AbxfsCid,
  rootIsDirectory: boolean,
  txHashes: Hex[],
  opts: WriteOpts,
): Promise<{ created: Set<AbxfsCid> }> {
  if (!clients.walletClient) throw new Error("walletClient required for writes");
  contentStores(addresses);
  const schedule = await resolveGasSchedule(clients.publicClient, opts.gasSchedule);
  const limitOpts = {
    schedule,
    ...(opts.blockGasLimit !== undefined ? { blockGasLimit: opts.blockGasLimit } : {}),
    ...(opts.bundleGasSafetyFactor !== undefined ? { safetyFactor: opts.bundleGasSafetyFactor } : {}),
    ...(opts.simulationGasCap !== undefined ? { simulationGasCap: opts.simulationGasCap } : {}),
  };
  const ceiling = resolveSingleCallLimits(limitOpts);
  // Before the first read: a tree past the level cap (or a node above a tiny ceiling) is refused while it is free to.
  for (const f of files) assertFileFits("", f.chunks.length, f.chunks.reduce((n, c) => n + c.input.length, 0), ceiling, schedule);
  for (const d of directories) assertDirectoryFits(d.path, d.entries, ceiling, schedule);

  const plan = await probeContentPlan(clients.publicClient, addresses, files, directories);
  const limits = resolveBundleLimits({ ...limitOpts, bundleGasBudget: opts.maxBundleGas ?? 12_000_000 });
  await runContentStages(
    { publicClient: clients.publicClient, walletClient: clients.walletClient },
    addresses,
    buildContentStages(addresses, plan, schedule),
    limits,
    txHashes,
    {
      rootCid,
      rootIsDirectory,
      ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.onBundleSent ? { onBundleSent: opts.onBundleSent } : {}),
    },
  );
  return { created: new Set(plan.filesToCreate.map((f) => f.cid)) };
}

/** Upload a single file: plan it (codec, chunks, backends, tree) and write what is missing. */
export async function uploadFile(
  clients: WriteClients,
  addresses: ContractAddresses,
  bytes: Uint8Array,
  mimeType: string,
  opts: Pick<UploadOptions, "codec" | "fastLz" | "backends"> & WriteOpts,
  dryRun: boolean,
  txHashes: Hex[],
): Promise<UploadedFile & { existedOnChain: boolean; path: string }> {
  // The planning pipeline lives in `plan.ts` and is shared with the dry-run and draft paths. Sharing it is the point:
  // a dry-run that disagrees with the upload it predicts is worse than no dry-run.
  const planned = await planFile({
    backends: backendsOf(addresses, opts),
    bytes,
    mimeType,
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.fastLz !== undefined ? { fastLz: opts.fastLz } : {}),
  });
  let existedOnChain = false;
  if (!dryRun) {
    const { created } = await writePlanned(clients, addresses, [fileToPlan(planned)], [], planned.cid, false, txHashes, opts);
    existedOnChain = !created.has(planned.cid);
  }
  return { ...toUploaded(planned, bytes, existedOnChain), path: "" };
}

type PathedFile = { path: string; cid: AbxfsCid };

/**
 * Create a directory hierarchy from already-uploaded files and return the root CID. The tree is folded with the
 * shared planner (so these are the CIDs a dry-run predicted) and written children-first, in waves by height. No files
 * and no empty directories is the empty directory, which needs no write.
 */
export async function buildDirectoryTree(
  clients: WriteClients,
  addresses: ContractAddresses,
  files: PathedFile[],
  opts: UploadOptions,
  txHashes: Hex[],
): Promise<AbxfsCid> {
  const { rootCid, directories } = planDirectoryTree(
    files,
    opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {},
  );
  if (!opts.dryRun) await writePlanned(clients, addresses, [], directories, rootCid, true, txHashes, opts);
  for (const dir of directories) opts.onDirectoryCreated?.(dir.cid, dir.entries);
  return rootCid;
}

/**
 * Compute the expected CIDs for an upload without touching the chain: a thin wrapper around {@link planUploadOffline}
 * that takes the backends from an address book. Pure; also importable from `@abxfs/sdk/core`.
 */
export async function planUpload(
  files: FileDescriptor[],
  opts: {
    codec?: FileCodec;
    fastLz?: boolean;
    emptyDirectories?: readonly string[];
    backends?: PlanBackends;
    addresses?: ContractAddresses;
  } = {},
): Promise<{
  files: Array<{
    path: string;
    cid: AbxfsCid;
    chunkIds: AbxfsCid[];
    /** Each chunk's data size, in the same order. */
    chunkSizes: number[];
    codec: FileCodec;
    outputHash: AbxfsCid;
    mimeType: string;
    ipfsCid: string;
    storedSize: number;
  }>;
  rootCid: AbxfsCid;
  rootKind: "directory";
  uniqueChunks: number;
  storedBytes: number;
  logicalBytes: number;
}> {
  const backends = opts.backends ?? (opts.addresses ? planBackendsFor(opts.addresses) : undefined);
  if (!backends) {
    throw new Error("planUpload: pass `backends` or `addresses` — chunk ids are bound to the backend addresses");
  }
  const plan = await planUploadOffline(files, {
    backends,
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.fastLz !== undefined ? { fastLz: opts.fastLz } : {}),
    ...(opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {}),
    ipfsCids: true,
  });
  return {
    files: plan.files.map((f) => ({
      path: f.path,
      cid: f.cid,
      chunkIds: f.chunkIds,
      chunkSizes: f.chunks.map((c) => c.size),
      codec: f.codec,
      outputHash: f.outputHash,
      mimeType: f.mimeType,
      ipfsCid: plan.ipfsCids![f.path]!,
      storedSize: f.storedSize,
    })),
    rootCid: plan.rootCid,
    rootKind: "directory",
    uniqueChunks: plan.uniqueChunks,
    storedBytes: plan.storedBytes,
    logicalBytes: plan.logicalBytes,
  };
}
