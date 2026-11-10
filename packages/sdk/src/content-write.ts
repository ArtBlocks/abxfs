/**
 * Writing ABX FS content: from a set of planned files and directories to the exact calls, grouped into
 * transactions, that put them on chain. Shared by the planner and every executor, on purpose: the plan's
 * transaction count and gas are derived from these exact calls, so "what will this cost" and "what it cost" are one
 * computation.
 *
 * Content is a tree of immutable nodes, built bottom-up, so the work falls into STAGES, each of which may only be
 * simulated once the previous one is visible (see `settle.ts`: a receipt is not visibility):
 *
 *   1. `chunks`       ChunkStore.write for every chunk a missing leaf names (each through its own backend)
 *   2. `chunk-nodes`  FileStore.putChunkNode, one stage per level (leaves, then level 1, ...)
 *   3. `files`        FileStore.createFile (the empty file is a createFile with a zero root and no nodes)
 *   4. per WAVE (a wave is a directory height; a directory's children must exist before it):
 *      `entry-nodes`  DirectoryStore.putEntryNode, one stage per level, then
 *      `directories`  DirectoryStore.createDirectory (the empty directory always exists, so it is never written)
 *
 * Within a stage nothing depends on anything else, so calls are packed into `multicall` transactions under a
 * conservative gas budget. Resume is the plan itself: the planner probes what exists
 * (existence means complete, and creating an existing node is a no-op) and plans only the rest.
 */
import { encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { chunkStoreAbi, directoryStoreAbi, fileStoreAbi } from "./abi.js";
import { contentWriteGas, packBundles, type PackOptions } from "./gas.js";
import { LEGACY_GAS_SCHEDULE, type GasEstimate, type GasSchedule } from "./gas-schedule.js";
import { createDirectoryGas, createFileGas, nodeGasEstimate } from "./node-gas.js";
import { ZERO_HASH } from "./cid.js";
import { nodeBlobHex, type PackedNode, type PackedTree } from "./nodes.js";
import {
  contentWriteCall,
  probeExistence,
  sendBundles,
  type Bundle,
  type BundleableCall,
  type ProbeTarget,
} from "./multicall.js";
import type { PlannedChunk, PlannedDirectory } from "./plan.js";
import { settle } from "./settle.js";
import { chunkStoreWriteAbi, contentStores, directoryStoreWriteAbi, fileStoreCallAbi, fileStoreWriteAbi } from "./stores.js";
import type { AbxfsCid, ContractAddresses, DirectoryEntry, FileCodec } from "./types.js";

/**
 * Phase ids surfaced through `onPhase`. Stable strings (not enums) so the web layer can pattern-match without
 * importing the union type. Node stages share the phase of the object they build: `creating-files` covers chunk
 * nodes and `createFile`, `creating-directories` covers entry nodes and `createDirectory`. Finer progress (node
 * counts, stage, level) is on `onProgress`.
 */
export type PublishPhase =
  | "writing-chunks"
  | "creating-files"
  | "creating-directories"
  | "publishing-version"
  | "setting-name"
  | "setting-tag"
  | "complete";

export type StageId = "chunks" | "chunk-nodes" | "files" | "entry-nodes" | "directories";

/** One progress event, fired after every content transaction is sent. */
export interface PublishProgress {
  stage: StageId;
  phase: PublishPhase;
  /** Node level within `chunk-nodes` / `entry-nodes` stages (0 = leaves). */
  level?: number;
  /** Directory height within `entry-nodes` / `directories` stages. */
  wave?: number;
  /** Calls (chunks, nodes, files or directories) carried by the transaction just sent. */
  calls: number;
  /** Calls sent so far in this stage, and in the stage in total. */
  stageCallsDone: number;
  stageCallsTotal: number;
  /** Calls of this KIND across all stages of it (every `chunk-nodes` level counts together). */
  kindCallsDone: number;
  kindCallsTotal: number;
  /** Content transactions sent so far, and planned in total (excluding the publish itself). */
  txsDone: number;
  txsTotal: number;
  estimatedGas: number;
  txHash: Hex;
}

export interface PlannedFileToCreate {
  cid: AbxfsCid;
  chunkIds: AbxfsCid[];
  mimeType: string;
  codec: FileCodec;
  outputHash: AbxfsCid;
  /** The file's root node: what `createFile` takes (zero for the empty file). */
  root: Hex;
}

export interface PlannedDirToCreate {
  cid: AbxfsCid;
  entries: DirectoryEntry[];
  /** POSIX path of the directory ("" is the root). */
  path?: string;
  root: Hex;
  /** Directory height (see `PlannedDirectory.height`). */
  height: number;
}

/** A node to create, with the wave (directory height) it belongs to when it is an entry node. */
export type PlannedEntryNode = PackedNode & { wave: number };

/** What has to be written, after probing what already exists. */
export interface ContentPlan {
  /** Chunks to write via `ChunkStore.write`: only those a missing chunk-node leaf names. */
  chunksToWrite: PlannedChunk[];
  /** Chunk nodes missing from `FileStore`, children before parents. */
  chunkNodesToCreate: PackedNode[];
  /** Files to register via `FileStore.createFile`. */
  filesToCreate: PlannedFileToCreate[];
  /** Entry nodes missing from `DirectoryStore`, children before parents. */
  entryNodesToCreate: PlannedEntryNode[];
  /** Directories to register via `DirectoryStore.createDirectory`. */
  dirsToCreate: PlannedDirToCreate[];
}

/** A file to plan: its CID, tree, metadata and planned chunks (`plan.ts`). */
export interface FileToPlan {
  cid: AbxfsCid;
  chunks: PlannedChunk[];
  mimeType: string;
  codec: FileCodec;
  outputHash: AbxfsCid;
  tree: PackedTree;
}

function byLevel<T extends { level: number }>(nodes: readonly T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const n of nodes) {
    const list = out.get(n.level);
    if (list) list.push(n);
    else out.set(n.level, [n]);
  }
  return out;
}

/** The chunk ids a chunk LEAF names: records are `chunkId:32 || size:6` after the one-byte level. */
function leafChunkIds(node: PackedNode): AbxfsCid[] {
  const out: AbxfsCid[] = [];
  for (let o = 1; o + 38 <= node.blob.length; o += 38) {
    let hex = "0x";
    for (let i = 0; i < 32; i++) hex += node.blob[o + i]!.toString(16).padStart(2, "0");
    out.push(hex as AbxfsCid);
  }
  return out;
}

/**
 * Probe the chain and work out what to write for `files` and `directories`.
 *
 * Three rounds of batched reads, however big the content: (1) which files and directories exist; (2) which nodes of
 * the missing ones exist; (3) which chunks the missing leaves name exist. A file that exists costs one read, however
 * many chunks it has, which is what makes re-running a half-finished upload cheap.
 */
export async function probeContentPlan(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  files: readonly FileToPlan[],
  directories: readonly PlannedDirectory[],
): Promise<ContentPlan> {
  const stores = contentStores(addresses);

  const fileByCid = new Map<AbxfsCid, FileToPlan>();
  for (const f of files) if (!fileByCid.has(f.cid)) fileByCid.set(f.cid, f);
  const dirByCid = new Map<AbxfsCid, PlannedDirectory>();
  for (const d of directories) if (!dirByCid.has(d.cid)) dirByCid.set(d.cid, d);
  const fileList = [...fileByCid.values()];
  const dirList = [...dirByCid.values()];

  // Round 1.
  const [fileExists, dirExists] = await Promise.all([
    probeExistence(publicClient, fileList.map((f) => ({ address: stores.fileStore, abi: fileStoreAbi, fn: "fileExists", arg: f.cid }))),
    probeExistence(publicClient, dirList.map((d) => ({ address: stores.directoryStore, abi: directoryStoreAbi, fn: "directoryExists", arg: d.cid }))),
  ]);
  const missingFiles = fileList.filter((_, i) => !fileExists[i]);
  const missingDirs = dirList.filter((_, i) => !dirExists[i]);

  // Round 2: the nodes of what is missing, each once however many files or directories share it.
  const chunkNodes = new Map<Hex, PackedNode>();
  for (const f of missingFiles) for (const n of f.tree.nodes) if (!chunkNodes.has(n.id)) chunkNodes.set(n.id, n);
  const entryNodes = new Map<Hex, PlannedEntryNode>();
  for (const d of missingDirs) {
    for (const n of d.tree.nodes) {
      const seen = entryNodes.get(n.id);
      // Created once, in the LOWEST wave of any directory holding it: a leaf's children are below every
      // directory that contains it, so the lowest wave already has them.
      if (!seen) entryNodes.set(n.id, { ...n, wave: d.height });
      else if (d.height < seen.wave) seen.wave = d.height;
    }
  }
  const chunkNodeList = [...chunkNodes.values()];
  const entryNodeList = [...entryNodes.values()];
  const [cnExists, enExists] = await Promise.all([
    probeExistence(publicClient, chunkNodeList.map((n) => ({ address: stores.fileStore, abi: fileStoreAbi, fn: "nodeExists", arg: n.id }))),
    probeExistence(publicClient, entryNodeList.map((n) => ({ address: stores.directoryStore, abi: directoryStoreAbi, fn: "nodeExists", arg: n.id }))),
  ]);
  const chunkNodesToCreate = chunkNodeList.filter((_, i) => !cnExists[i]);
  const entryNodesToCreate = entryNodeList.filter((_, i) => !enExists[i]);

  // Round 3: only chunks a missing LEAF names. An existing leaf is complete, so its chunks exist.
  const chunkById = new Map<string, PlannedChunk>();
  for (const f of missingFiles) {
    for (const c of f.chunks) if (!chunkById.has(c.id.toLowerCase())) chunkById.set(c.id.toLowerCase(), c);
  }
  const wanted: AbxfsCid[] = [];
  const wantedSet = new Set<AbxfsCid>();
  for (const n of chunkNodesToCreate) {
    if (n.level !== 0) continue;
    for (const h of leafChunkIds(n)) {
      if (!wantedSet.has(h)) {
        wantedSet.add(h);
        wanted.push(h);
      }
    }
  }
  const chunkExists = await probeExistence(
    publicClient,
    wanted.map((h) => ({ address: stores.chunkStore, abi: chunkStoreAbi, fn: "exists", arg: h })),
  );
  const chunksToWrite: ContentPlan["chunksToWrite"] = [];
  wanted.forEach((id, i) => {
    if (chunkExists[i]) return;
    const chunk = chunkById.get(id.toLowerCase());
    if (!chunk) throw new Error(`chunk ${id} is needed but it is not part of this plan`);
    chunksToWrite.push(chunk);
  });

  return {
    chunksToWrite,
    chunkNodesToCreate,
    filesToCreate: missingFiles.map((f) => ({
      cid: f.cid,
      chunkIds: f.chunks.map((c) => c.id),
      mimeType: f.mimeType,
      codec: f.codec,
      outputHash: f.outputHash,
      root: f.tree.root,
    })),
    entryNodesToCreate,
    dirsToCreate: missingDirs.map((d) => ({
      cid: d.cid,
      entries: d.entries,
      path: d.path,
      root: d.tree.root,
      height: d.height,
    })),
  };
}

// ─── Stages ──────────────────────────────────────────────────────────────────

/** One stage of the content pipeline: the calls to send and how to confirm they landed. */
export interface ContentStage {
  id: StageId;
  kind: "content" | "file" | "directory";
  phase: "writing-chunks" | "creating-files" | "creating-directories";
  level?: number;
  wave?: number;
  target: Address;
  abi: readonly unknown[];
  calls: BundleableCall[];
  /** What must be readable before the NEXT stage may be simulated. */
  confirm: ProbeTarget[];
}

function call(
  target: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  estimate: GasEstimate,
  label: string,
): BundleableCall {
  return {
    target,
    data: encodeFunctionData({ abi: abi as never, functionName, args } as never) as Hex,
    estimatedGas: estimate.execution + estimate.state,
    estimatedStateGas: estimate.state,
    label,
  };
}

function hexOf(b: Uint8Array): Hex {
  let out = "0x";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out as Hex;
}

/**
 * Build the stages, in the order they must run, from a plan. Empty stages are omitted. Each call's estimate is priced
 * under `schedule` (see `gas-schedule.ts`): the state a write creates costs 7.65x more under EIP-8037.
 */
export function buildContentStages(
  addresses: ContractAddresses,
  plan: ContentPlan,
  schedule: GasSchedule = LEGACY_GAS_SCHEDULE,
): ContentStage[] {
  const stores = contentStores(addresses);
  const stages: ContentStage[] = [];
  const zero = ZERO_HASH.toLowerCase();

  if (plan.chunksToWrite.length > 0) {
    stages.push({
      id: "chunks",
      kind: "content",
      phase: "writing-chunks",
      target: stores.chunkStore,
      abi: chunkStoreWriteAbi,
      calls: plan.chunksToWrite.map((c, i) =>
        contentWriteCall(
          stores.chunkStore,
          { backend: c.backend, input: hexOf(c.input), dataHash: c.dataHash, size: c.size },
          contentWriteGas(c.input.length, { dataLength: c.size, input: c.input, schedule }),
          `ChunkStore.write[${i}]`,
        ),
      ),
      confirm: plan.chunksToWrite.map((c) => ({
        address: stores.chunkStore,
        abi: chunkStoreAbi as readonly unknown[],
        fn: "exists",
        arg: c.id,
      })),
    });
  }

  const cn = byLevel(plan.chunkNodesToCreate);
  for (const level of [...cn.keys()].sort((a, b) => a - b)) {
    const nodes = cn.get(level)!;
    stages.push({
      id: "chunk-nodes",
      kind: "file",
      phase: "creating-files",
      level,
      target: stores.fileStore,
      abi: fileStoreWriteAbi,
      calls: nodes.map((n) =>
        call(stores.fileStore, fileStoreCallAbi, "putChunkNode", [nodeBlobHex(n)], nodeGasEstimate(n, schedule), `putChunkNode[L${n.level}]`),
      ),
      confirm: nodes.map((n) => ({ address: stores.fileStore, abi: fileStoreAbi as readonly unknown[], fn: "nodeExists", arg: n.id })),
    });
  }

  if (plan.filesToCreate.length > 0) {
    stages.push({
      id: "files",
      kind: "file",
      phase: "creating-files",
      target: stores.fileStore,
      abi: fileStoreWriteAbi,
      calls: plan.filesToCreate.map((f) =>
        call(
          stores.fileStore,
          fileStoreCallAbi,
          "createFile",
          [f.root, f.mimeType, f.codec, f.outputHash],
          createFileGas(
            {
              mimeBytes: new TextEncoder().encode(f.mimeType).length,
              hasRoot: f.root.toLowerCase() !== zero,
              hasCodec: f.codec.toLowerCase() !== zero,
            },
            schedule,
          ),
          "createFile",
        ),
      ),
      confirm: plan.filesToCreate.map((f) => ({ address: stores.fileStore, abi: fileStoreAbi as readonly unknown[], fn: "fileExists", arg: f.cid })),
    });
  }

  const waves = new Set<number>([...plan.entryNodesToCreate.map((n) => n.wave), ...plan.dirsToCreate.map((d) => d.height)]);
  for (const wave of [...waves].sort((a, b) => a - b)) {
    const en = byLevel(plan.entryNodesToCreate.filter((n) => n.wave === wave));
    for (const level of [...en.keys()].sort((a, b) => a - b)) {
      const nodes = en.get(level)!;
      stages.push({
        id: "entry-nodes",
        kind: "directory",
        phase: "creating-directories",
        level,
        wave,
        target: stores.directoryStore,
        abi: directoryStoreWriteAbi,
        calls: nodes.map((n) =>
          call(stores.directoryStore, directoryStoreAbi, "putEntryNode", [nodeBlobHex(n)], nodeGasEstimate(n, schedule), `putEntryNode[L${n.level}]`),
        ),
        confirm: nodes.map((n) => ({ address: stores.directoryStore, abi: directoryStoreAbi as readonly unknown[], fn: "nodeExists", arg: n.id })),
      });
    }
    const dirs = plan.dirsToCreate.filter((d) => d.height === wave);
    if (dirs.length > 0) {
      stages.push({
        id: "directories",
        kind: "directory",
        phase: "creating-directories",
        wave,
        target: stores.directoryStore,
        abi: directoryStoreWriteAbi,
        calls: dirs.map((d) => call(stores.directoryStore, directoryStoreAbi, "createDirectory", [d.root], createDirectoryGas(schedule), "createDirectory")),
        confirm: dirs.map((d) => ({ address: stores.directoryStore, abi: directoryStoreAbi as readonly unknown[], fn: "directoryExists", arg: d.cid })),
      });
    }
  }
  return stages;
}

/**
 * Pack every stage into bundles exactly as the executor will. `limits` is a total-gas ceiling (legacy) or the
 * schedule's limits from `resolveBundleLimits`.
 */
export function packStages(
  stages: readonly ContentStage[],
  limits: number | Omit<PackOptions, "maxCalls">,
): Array<{ stage: ContentStage; bundles: Bundle[] }> {
  const opts = typeof limits === "number" ? { maxBundleGas: limits } : limits;
  return stages.map((stage) => ({ stage, bundles: packBundles(stage.calls, opts) }));
}

/**
 * Wait until a set of content addresses reads back as present.
 *
 * Every stage is simulated before it is sent, and a receipt does not mean the node answering that simulation has the
 * write: public RPCs load balance across replicas a block or two apart. Bounded and non-fatal: if reads never
 * converge, the real revert is a better error than one invented here. See `settle.ts`.
 */
export async function waitForPresence(publicClient: PublicClient, targets: readonly ProbeTarget[]): Promise<void> {
  if (targets.length === 0) return;
  // Only what has not yet been seen present is asked about again.
  let pending: ProbeTarget[] = [...targets];
  await settle(async () => {
    const present = await probeExistence(publicClient, pending);
    pending = pending.filter((_, i) => !present[i]);
    return pending.length === 0;
  });
}

export interface RunStagesOptions {
  /**
   * The root about to be published. Confirmed last, always, including when no stage ran because the root already
   * existed on chain: the configure hook asks the stores whether it exists and vetoes `RootNotFound` otherwise.
   */
  rootCid?: AbxfsCid;
  rootIsDirectory?: boolean;
  onPhase?: (p: PublishPhase) => void;
  onProgress?: (e: PublishProgress) => void;
  onBundleSent?: (info: { target: Address; callCount: number; estimatedGas: number; txHash: Hex }) => void;
}

/**
 * Run the stages in order, confirming each is visible before the next is simulated. The confirmation is not
 * belt-and-braces: `createFile` reverts `ChunkMissing`, and a node reverts `NodeMissing`, for children that are
 * demonstrably on chain, when the replica answering the simulation is a block behind. See `settle.ts`.
 */
export async function runContentStages(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  addresses: ContractAddresses,
  stages: ContentStage[],
  limits: number | Omit<PackOptions, "maxCalls">,
  txHashes: Hex[],
  opts: RunStagesOptions = {},
): Promise<void> {
  const stores = contentStores(addresses);
  const packed = packStages(stages, limits);
  const txsTotal = packed.reduce((n, p) => n + p.bundles.length, 0);
  const kindTotals = new Map<StageId, number>();
  for (const { stage } of packed) kindTotals.set(stage.id, (kindTotals.get(stage.id) ?? 0) + stage.calls.length);
  const kindDone = new Map<StageId, number>();

  let confirmed: ProbeTarget[] = [];
  let confirmedBlock: bigint | undefined;
  let txsDone = 0;
  let lastPhase: PublishPhase | undefined;

  for (const { stage, bundles } of packed) {
    // Everything the previous stage wrote must be readable before this one is simulated.
    await waitForPresence(clients.publicClient, confirmed);
    if (stage.phase !== lastPhase) {
      opts.onPhase?.(stage.phase);
      lastPhase = stage.phase;
    }
    let stageDone = 0;
    await sendBundles(clients, bundles, stage.abi as never, {
      simulationBlockNumber: confirmedBlock,
      onBundleConfirmed: (blockNumber) => { confirmedBlock = blockNumber; },
      onBundleSent: (b, _i, txHash) => {
        stageDone += b.calls.length;
        txsDone++;
        txHashes.push(txHash);
        const kd = (kindDone.get(stage.id) ?? 0) + b.calls.length;
        kindDone.set(stage.id, kd);
        opts.onBundleSent?.({ target: b.target as Address, callCount: b.calls.length, estimatedGas: b.estimatedGas, txHash });
        opts.onProgress?.({
          stage: stage.id,
          phase: stage.phase,
          ...(stage.level !== undefined ? { level: stage.level } : {}),
          ...(stage.wave !== undefined ? { wave: stage.wave } : {}),
          calls: b.calls.length,
          stageCallsDone: stageDone,
          stageCallsTotal: stage.calls.length,
          kindCallsDone: kd,
          kindCallsTotal: kindTotals.get(stage.id) ?? stage.calls.length,
          txsDone,
          // A bundle the node refused for gas is sent as halves (`sendBundles`): one more transaction than planned.
          txsTotal: Math.max(txsTotal, txsDone),
          estimatedGas: b.estimatedGas,
          txHash,
        });
      },
    });
    confirmed = stage.confirm;
  }

  await waitForPresence(clients.publicClient, confirmed);

  if (opts.rootCid) {
    const isDir = opts.rootIsDirectory !== false;
    await waitForPresence(clients.publicClient, [
      {
        address: isDir ? stores.directoryStore : stores.fileStore,
        abi: (isDir ? directoryStoreAbi : fileStoreAbi) as readonly unknown[],
        fn: isDir ? "directoryExists" : "fileExists",
        arg: opts.rootCid,
      },
    ]);
  }
}
