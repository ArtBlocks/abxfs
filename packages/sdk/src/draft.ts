/**
 * Draft semantics for the web app's "edit + publish" UX. This module is purely
 * client-side compute — no on-chain writes — and is the bridge between the
 * web app's `ProjectDraft` data model and the SDK's `planUpload` flow.
 *
 * Two-step flow:
 *
 *   1. `applyDraftToBase()` — walk the base tree, apply the ops, run FastCDC
 *      on changed/added bytes, compute the new root CID and a per-file plan.
 *      No content writes, no chain mutations. Pure compute apart from the
 *      single `walkDirectory` read used to enumerate the base tree.
 *
 *   2. `planPublish()` — given the per-file plan from step 1, probe the
 *      ChunkStore / FileStore / DirectoryStore to figure out which writes
 *      are actually needed (i.e. which chunks aren't already on chain), then
 *      bucket those into multicall bundles sized under the block gas cap.
 *      Returns a fully concretized `TxPlan` the UI can render and step through.
 *
 * Why two steps? `applyDraftToBase` is cheap and deterministic — we use it both
 * for the diff/preview UI and as the input to `planPublish`. Splitting them
 * means the UI can show "here's what your new tree looks like" without paying
 * for the existence probes, and the publish path can safely re-run
 * `planPublish` to pick up new dedup hits when retrying after a partial failure.
 */

import { type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import {
  assertCanPublish,
  setProjectName,
  type ProjectContracts,
} from "./project.js";
import { assertUploadPaths, planBackendsFor, planDirectoryTree, planFile, foldDirectoryCid } from "./plan.js";
import { encodeEntryName } from "./names.js";
import type { PlanBackends, PlannedChunk, PlannedDirectory } from "./plan.js";
import { CODEC_NONE } from "./compression.js";
import {
  assertDirectoryFits,
  assertFileFits,
  contentWriteGas,
  estimateProjectOp,
  fitsSingleCall,
  resolveBundleLimits,
  resolveSingleCallLimits,
} from "./gas.js";
import { LEGACY_GAS_SCHEDULE, resolveGasSchedule, type GasSchedule } from "./gas-schedule.js";
import { nodeGasEstimate } from "./node-gas.js";
import { ZERO_HASH } from "./cid.js";
import { packFile, type PackedTree } from "./nodes.js";
import { emptyDirectoryChanges, walkDirectoryTree } from "./read.js";
import { publishRootAndTag } from "./publish.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { assertValidPublishInputs } from "./validate.js";
import { assertHookAcceptsContent, contentStores } from "./stores.js";
import {
  buildContentStages,
  packStages,
  probeContentPlan,
  runContentStages,
  type ContentPlan,
  type FileToPlan,
  type PublishPhase,
  type PublishProgress,
  type StageId,
} from "./content-write.js";
import type { AbxfsCid, ContractAddresses, DirectoryEntry, FileCodec, FileDescriptor } from "./types.js";
import { inferMimeType, validateRelativePath } from "./util.js";

export type { PublishPhase, PublishProgress } from "./content-write.js";

/**
 * One operation a draft applies to the base tree. Same shape as the web app's
 * `DraftOpRuntime` but without web-only fields — keeping the SDK web-agnostic
 * means CLI / tests can reuse this directly.
 */
export type DraftOp =
  | { kind: "add"; path: string; bytes: Uint8Array; mimeType?: string }
  | { kind: "remove"; path: string }
  | {
      kind: "replace";
      path: string;
      bytes: Uint8Array;
      mimeType?: string;
    }
  | {
      kind: "edit";
      path: string;
      bytes: Uint8Array;
      mimeType?: string;
    };

/**
 * Per-file plan returned from `applyDraftToBase`. `kind` mirrors the diff
 * status the UI wants to render; `chunkIds` is empty for `removed` /
 * `unchanged` since no content is being computed for those.
 */
export interface PlannedFile {
  path: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  /** New file CID (added/changed/unchanged). Removed files don't have one. */
  newCid?: AbxfsCid;
  /** Old file CID (removed/changed/unchanged). Added files don't have one. */
  oldCid?: AbxfsCid;
  /** File codec label of the new bytes (zero for none). */
  codec?: FileCodec;
  /** MIME type recorded for the new bytes (added/changed). */
  mimeType?: string;
  /** `keccak256(content)` when a codec is set (added/changed only); zero otherwise. */
  outputHash?: AbxfsCid;
  /** Chunk ids of the new content (added/changed only). */
  chunkIds?: AbxfsCid[];
  /** The planned chunks of the new content (added/changed only), held so `planPublish` can write the missing ones. */
  newChunks?: PlannedChunk[];
  /** The new file's chunk-node tree. Derived from `newChunks` when absent. */
  tree?: PackedTree;
}

export interface AppliedDraft {
  /** Root CID of the new directory tree (post-merge). */
  newRootCid: AbxfsCid;
  /** Per-file plan — added / removed / changed / unchanged. */
  files: PlannedFile[];
  /** The backends the new chunks were planned against (echoed for the publish path). */
  backends: PlanBackends;
  /** Directories in the new tree that hold nothing: the base's, plus any the caller added. */
  emptyDirectories?: readonly string[];
}

export interface ApplyDraftOptions {
  /** File codec for every changed/added file. Default none (FastLZ per chunk where it helps). */
  codec?: FileCodec;
  /** Per-chunk FastLZ (default true). */
  fastLz?: boolean;
  /** Backends to plan against; default the address book's recommended ones. */
  backends?: PlanBackends;
  /** Directories to create even though no file is in them, besides the base's own empty directories (kept). */
  emptyDirectories?: readonly string[];
}

function draftShape(addresses: ContractAddresses, opts: ApplyDraftOptions) {
  return {
    backends: opts.backends ?? planBackendsFor(addresses),
    codec: opts.codec ?? CODEC_NONE,
    fastLz: opts.fastLz !== false,
  };
}

/**
 * Apply a list of draft ops on top of `baseRootCid` and produce the new root
 * CID + per-file plan. Walks the base tree once via `walkDirectory`; everything
 * else is local compute.
 *
 * Determinism: identical (baseRootCid, ops, backends, codec) inputs always
 * produce identical outputs. This is what lets the diff/review UI render
 * without uploading anything and trust that hitting "publish" later will land
 * the exact CIDs it previewed.
 */
export async function applyDraftToBase(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  baseRootCid: AbxfsCid,
  ops: DraftOp[],
  opts: ApplyDraftOptions = {},
): Promise<AppliedDraft> {
  const shape = draftShape(addresses, opts);

  // 1. Snapshot the base tree as `path → cid`, and its empty directories, which an edit keeps.
  const base = await walkDirectoryTree(publicClient, addresses, baseRootCid);
  const baseFiles = base.files;
  const baseByPath = new Map<string, AbxfsCid>(baseFiles.map((f) => [f.path, f.cid]));

  // 2. Bucket ops by path. Last op wins (the web layer already collapses dupes,
  //    but we re-collapse defensively so this function works for any caller). A path is in the text form of its
  //    names (`names.ts`): a base path read from chain may carry `\xHH` escapes, and anything else must be a name
  //    spelled the one way that maps back to bytes.
  const opByPath = new Map<string, DraftOp>();
  for (const op of ops) {
    validateRelativePath(op.path);
    for (const seg of op.path.split("/")) encodeEntryName(seg);
    opByPath.set(op.path, op);
  }

  // 3. Build the per-file plan.
  const files: PlannedFile[] = [];

  // Existing files first (preserves natural order of base tree → friendlier diffs).
  for (const { path, cid: oldCid } of baseFiles) {
    const op = opByPath.get(path);
    if (!op) {
      files.push({ path, kind: "unchanged", oldCid, newCid: oldCid });
      continue;
    }
    if (op.kind === "remove") {
      files.push({ path, kind: "removed", oldCid });
      continue;
    }
    // edit / replace / add-against-existing → compute new CID
    const planned = await planNewFile(op, shape);
    files.push({ ...planned, path, oldCid, kind: "changed" });
  }

  // Added files (no base entry).
  for (const [path, op] of opByPath) {
    if (baseByPath.has(path)) continue;
    if (op.kind === "remove") continue; // dropping a file that never existed — silently ignore
    const planned = await planNewFile(op, shape);
    files.push({ ...planned, path, kind: "added" });
  }

  // 4. Fold the per-file CIDs into a directory tree and compute the new root CID.
  //    We exclude `removed` files so they don't appear in the new tree.
  const treeFiles = files
    .filter((f) => f.kind !== "removed" && f.newCid !== undefined)
    .map((f) => ({ path: f.path, cid: f.newCid! }));
  // A base directory that now holds a file is no longer empty; listing it anyway is harmless (the fold only makes sure
  // it exists), but the plan reports what is really empty.
  const occupied = new Set(treeFiles.flatMap((f) => parentsOf(f.path)));
  const emptyDirectories = [...new Set([...base.emptyDirectories, ...(opts.emptyDirectories ?? [])])]
    .filter((d) => !occupied.has(d))
    .sort();
  const newRootCid = computeRootCid(treeFiles, emptyDirectories);

  return {
    newRootCid,
    files,
    backends: shape.backends,
    ...(emptyDirectories.length > 0 ? { emptyDirectories } : {}),
  };
}

/** Every directory above `path`: `a/b/c.txt` → `a`, `a/b`. */
function parentsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Compute the new file CID + chunk plan for a single staged op.
 *
 * Delegates to the shared planner in `plan.js` rather than re-deriving the pipeline: a draft whose
 * predicted CIDs drifted from what publishing writes would look like a working preview right up to
 * the transaction.
 */
async function planNewFile(
  op: Exclude<DraftOp, { kind: "remove" }>,
  shape: { backends: PlanBackends; codec: FileCodec; fastLz: boolean },
): Promise<{
  newCid: AbxfsCid;
  codec: FileCodec;
  outputHash: AbxfsCid;
  mimeType: string;
  chunkIds: AbxfsCid[];
  newChunks: PlannedChunk[];
  tree: PackedTree;
}> {
  const planned = await planFile({
    backends: shape.backends,
    bytes: op.bytes,
    mimeType: op.mimeType,
    codec: shape.codec,
    fastLz: shape.fastLz,
    path: op.path,
  });
  return {
    newCid: planned.cid,
    codec: planned.codec,
    outputHash: planned.outputHash,
    mimeType: planned.mimeType,
    chunkIds: planned.chunkIds,
    newChunks: planned.chunks,
    tree: planned.tree,
  };
}



/**
 * Pure-compute version of `buildDirectoryTree`. We re-implement it here rather
 * than importing the upload-side helper because that one writes to chain; this
 * one only computes CIDs (which is exactly what the diff preview wants).
 */
/**
 * Root CID for a set of staged files, or a zero sentinel when nothing is left.
 *
 * The empty directory is a valid root on chain, but a draft that removed every file is almost always a mistake, so it
 * reports the zero sentinel (which no store recognises) and the UI disables publishing. A draft with explicit empty
 * directories has a real root.
 */
function computeRootCid(files: Array<{ path: string; cid: AbxfsCid }>, emptyDirectories?: readonly string[]): AbxfsCid {
  if (files.length === 0 && !(emptyDirectories && emptyDirectories.length > 0)) {
    return ("0x" + "00".repeat(32)) as AbxfsCid;
  }
  return foldDirectoryCid(files, emptyDirectories ? { emptyDirectories } : {});
}

// ─── Tx plan ───────────────────────────────────────────────────────────────

/**
 * Concretized tx plan returned by `planPublish`. Designed to be rendered as-is
 * by the UI — every field maps directly to a row the user will sign for.
 *
 * A file is a tree of chunk nodes and a directory a tree of entry nodes, so beside the
 * `chunksToWrite` / `filesToCreate` / `dirsToCreate` the plan lists the missing nodes
 * (`chunkNodesToCreate`, `entryNodesToCreate`). Everything listed is MISSING: whatever already exists on chain
 * is not in the plan, which is also how an interrupted publish resumes.
 */
export interface TxPlan extends ContentPlan {
  /**
   * Bundle layout the publish flow will execute. One bundle = one wallet prompt
   * = one tx (wrapped in a multicall when it has more than one inner call).
   *
   * `kind` is the coarse bucket the web renders (`file` covers chunk nodes and `createFile`, `directory`
   * covers entry nodes and `createDirectory`); `stage`, `level` and `wave` say which. `estGas` is the node gas
   * model's estimate, not a simulation.
   */
  bundles: Array<{
    kind: "content" | "file" | "directory";
    stage: StageId;
    level?: number;
    wave?: number;
    calls: number;
    estGas: bigint;
  }>;
  /**
   * The trailing param writes, each its OWN transaction and its own wallet prompt.
   *
   * They are separate on purpose and cannot be merged as things stand: `abxfs.cid` and `abxfs.name`
   * are `configureTokenParam` calls on the ABX collection, while a tag lives on
   * `ProjectHook` — a different contract entirely, so no single-contract multicall can span
   * them.
   */
  publishVersion: { estGas: bigint };
  /** Optional `setProjectName` step — set when publishing with a name (a new project always is). */
  setName?: { name: string; estGas: bigint };
  /** Optional `setTag` step — set when the user opted to tag the new version. */
  setTag?: { tag: string; estGas: bigint };
}

export interface PlanPublishOptions {
  /** Optional tag to assign to the new version (drives the `setTag` step). */
  tag?: string;
  /**
   * Optional project name (drives the `setName` step).
   *
   * Every new project sets one, and it is its own transaction — so a plan that omits it
   * under-reports the wallet prompts by one.
   */
  name?: string;
  /**
   * Per-bundle gas budget used to pack the plan. Must match what the executor uses, or the
   * predicted transaction count is fiction, so both default to the same constant and route through
   * {@link resolveBundleLimits}.
   */
  maxBundleGas?: number;
  /** Block gas cap for bundle sizing (see {@link resolveBundleLimits}). */
  blockGasLimit?: bigint;
  /** Multiplier applied to bundle totals to leave headroom under the block cap. */
  safetyFactor?: number;
  /** The chain's gas schedule. Default: asked of the node (`detectGasSchedule`), the same answer the executor gets. */
  gasSchedule?: GasSchedule;
  /** Under EIP-8037, the most gas the node simulates for one transaction (default 50M). */
  simulationGasCap?: number;
}

/** The files and directories a draft's publish has to make exist. Pure: no reads. */
export function collectContent(applied: AppliedDraft): { files: FileToPlan[]; directories: PlannedDirectory[] } {
  const files: FileToPlan[] = [];
  for (const f of applied.files) {
    if (f.kind === "removed" || f.kind === "unchanged") continue;
    if (!f.newCid || !f.newChunks) continue;
    const mimeType = f.mimeType ?? "application/octet-stream";
    const codec = f.codec ?? CODEC_NONE;
    const outputHash = f.outputHash ?? ZERO_HASH;
    files.push({
      cid: f.newCid,
      chunks: f.newChunks,
      mimeType,
      codec,
      outputHash,
      tree:
        f.tree ??
        packFile({ chunkIds: f.newChunks.map((c) => c.id), chunkSizes: f.newChunks.map((c) => c.size), mimeType, codec, outputHash, path: f.path })
          .tree,
    });
  }
  return { files, directories: collectDirectories(applied) };
}

/** True when the draft's root is a directory (false for a file-kind project, whose root IS the one file). */
export function draftRootIsDirectory(applied: AppliedDraft): boolean {
  const live = applied.files.filter((f) => f.kind !== "removed" && f.newCid !== undefined);
  if (applied.emptyDirectories && applied.emptyDirectories.length > 0) return true;
  return !(live.length === 1 && live[0]!.newCid === applied.newRootCid);
}

/**
 * Every directory in the draft's tree, children first. Shares the fold with the uploader via `planDirectoryTree`:
 * these are the directories the publish actually creates, and a fold that disagreed with the one that computed the
 * root would leave a root whose children were never written.
 */
function collectDirectories(applied: AppliedDraft): PlannedDirectory[] {
  const live = applied.files
    .filter((f) => f.kind !== "removed" && f.newCid !== undefined)
    .map((f) => ({ path: f.path, cid: f.newCid! }));
  // A file-kind project: the root IS the single file, so there is no directory. Folding it would invent a
  // wrapping directory and change the root the hook is asked to accept.
  const empty = applied.emptyDirectories ?? [];
  if ((live.length === 0 && empty.length === 0) || !draftRootIsDirectory(applied)) return [];
  return planDirectoryTree(live, { emptyDirectories: empty }).directories;
}

/**
 * Take an `AppliedDraft` and probe the chain to figure out which chunks, nodes, files and directories actually
 * need to be created. Bundles the writes into multicalls sized under the per-transaction gas cap.
 *
 * This is the deduplication engine: whatever already exists costs nothing (no tx, no gas). With the FastCDC chunker,
 * edits to the start of a long file dedupe most of the downstream chunks, and unchanged chunk-node leaves are not
 * rewritten either. It is also the resume mechanism: run it again after a failure and it plans only what is left.
 */
export async function planPublish(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  applied: AppliedDraft,
  opts: PlanPublishOptions = {},
): Promise<TxPlan> {
  // The plan is built from the SAME calls and the SAME packer the executor uses, so the predicted
  // transaction count and gas are what actually happens rather than a parallel model of it.
  const schedule = await resolveGasSchedule(publicClient, opts.gasSchedule);
  const fitOpts = {
    schedule,
    ...(opts.blockGasLimit !== undefined ? { blockGasLimit: opts.blockGasLimit } : {}),
    ...(opts.safetyFactor !== undefined ? { safetyFactor: opts.safetyFactor } : {}),
    ...(opts.simulationGasCap !== undefined ? { simulationGasCap: opts.simulationGasCap } : {}),
  };
  const limits = resolveBundleLimits({ ...fitOpts, bundleGasBudget: opts.maxBundleGas ?? DEFAULT_BUNDLE_GAS_BUDGET });
  contentStores(addresses);

  // Refuse what cannot be written BEFORE any read: a tree past the level cap is a pure function of the plan.
  const { files, directories } = collectContent(applied);
  assertTreesFit(files, directories, fitOpts);

  const content = await probeContentPlan(publicClient, addresses, files, directories);
  assertPlanFits(content, applied, fitOpts);

  const bundles: TxPlan["bundles"] = [];
  for (const { stage, bundles: packed } of packStages(buildContentStages(addresses, content, schedule), limits)) {
    for (const b of packed) {
      bundles.push({
        kind: stage.kind,
        stage: stage.id,
        ...(stage.level !== undefined ? { level: stage.level } : {}),
        ...(stage.wave !== undefined ? { wave: stage.wave } : {}),
        calls: b.calls.length,
        estGas: BigInt(b.estimatedGas),
      });
    }
  }

  const plan: TxPlan = {
    ...content,
    bundles,
    publishVersion: { estGas: BigInt(estimateProjectOp("publishVersion")) },
  };
  if (opts.name) {
    plan.setName = { name: opts.name, estGas: BigInt(estimateProjectOp("setName")) };
  }
  if (opts.tag) {
    plan.setTag = { tag: opts.tag, estGas: BigInt(estimateProjectOp("setTag")) };
  }
  return plan;
}

/** Throw {@link PlanTooLargeError} for any file or directory of the draft that would need more than the level cap. */
function assertTreesFit(
  files: readonly FileToPlan[],
  directories: readonly PlannedDirectory[],
  opts: FitOptions,
): void {
  const schedule = opts.schedule ?? LEGACY_GAS_SCHEDULE;
  const ceiling = resolveSingleCallLimits(opts);
  // Packing already refused a level-cap breach (it throws while building the tree); this adds the per-node ceiling.
  for (const f of files) assertFileFits("", f.chunks.length, f.chunks.reduce((n, c) => n + c.input.length, 0), ceiling, schedule);
  for (const d of directories) assertDirectoryFits(d.path, d.entries, ceiling, schedule);
}

/** What decides whether one call fits: the chain's schedule, and the block and simulation bounds when known. */
type FitOptions = { blockGasLimit?: bigint | number; safetyFactor?: number; schedule?: GasSchedule; simulationGasCap?: number };

/**
 * Refuse a plan that cannot be written, before any content is paid for: a node whose estimated gas is above what one
 * transaction may use (only reachable with an explicitly tiny ceiling, or a hand-built plan), or a chunk larger than a
 * transaction can store. A big file or directory is NOT refused; it is more nodes. Pure, no reads, and checked by
 * `planPublish` AND by every executor, so a plan handed in from elsewhere cannot skip it.
 */
export function assertPlanFits(
  plan: Pick<TxPlan, "chunksToWrite"> & Partial<Pick<TxPlan, "chunkNodesToCreate" | "entryNodesToCreate" | "filesToCreate" | "dirsToCreate">>,
  applied: AppliedDraft,
  opts: FitOptions = {},
): void {
  void applied;
  const schedule = opts.schedule ?? LEGACY_GAS_SCHEDULE;
  const ceiling = resolveSingleCallLimits(opts);
  for (const n of [...(plan.chunkNodesToCreate ?? []), ...(plan.entryNodesToCreate ?? [])]) {
    const est = nodeGasEstimate(n, schedule);
    if (!fitsSingleCall(est, ceiling)) {
      throw new Error(
        `a level-${n.level} node needs about ${est.execution + est.state} gas, more than one transaction can use on this network ` +
          `(${ceiling.maxGas}). Nothing was written.`,
      );
    }
  }
  for (const c of plan.chunksToWrite) {
    if (!fitsSingleCall(contentWriteGas(c.input.length, { dataLength: c.size, input: c.input, schedule }), ceiling)) {
      throw new Error(`a chunk of ${c.input.length} input bytes is more than one transaction can store on this network`);
    }
  }
}

// ─── Publish executor (delta-only) ─────────────────────────────────────────

/**
 * Default per-bundle gas budget.
 *
 * Below the 2^24 per-transaction cap with margin — see {@link resolveBundleLimits}. The old
 * value of 24,000,000 was chosen against the block gas limit, which is the wrong constraint: a node
 * will happily include a 24M-gas transaction it refuses to simulate, so the bundle failed before it
 * was ever sent.
 */
const DEFAULT_BUNDLE_GAS_BUDGET = 12_000_000;

/**
 * The ONE place an executor turns its options into limits: what `planPublish` is asked for, what `assertPlanFits`
 * checks and what the bundles are packed under. All three see the same schedule, block gas limit, safety factor,
 * simulation cap and bundle budget, so a plan shown to the user is the plan that runs, and a known block gas limit
 * bounds every bundle (it once bounded only the fit check). Exported for tests.
 */
export function executorPacking(
  opts: Pick<ExecuteDraftPublishOptions, "maxBundleGas" | "blockGasLimit" | "bundleGasSafetyFactor" | "simulationGasCap"> & {
    blockGasLimit?: number | bigint;
  },
  schedule: GasSchedule,
): { planOptions: PlanPublishOptions; fit: FitOptions; limits: ReturnType<typeof resolveBundleLimits> } {
  const fit: FitOptions = {
    schedule,
    ...(opts.simulationGasCap !== undefined ? { simulationGasCap: opts.simulationGasCap } : {}),
    ...(opts.blockGasLimit !== undefined ? { blockGasLimit: opts.blockGasLimit } : {}),
    ...(opts.bundleGasSafetyFactor !== undefined ? { safetyFactor: opts.bundleGasSafetyFactor } : {}),
  };
  const planOptions: PlanPublishOptions = {
    gasSchedule: schedule,
    ...(opts.simulationGasCap !== undefined ? { simulationGasCap: opts.simulationGasCap } : {}),
    ...(opts.maxBundleGas !== undefined ? { maxBundleGas: opts.maxBundleGas } : {}),
    ...(opts.blockGasLimit !== undefined ? { blockGasLimit: BigInt(opts.blockGasLimit) } : {}),
    ...(opts.bundleGasSafetyFactor !== undefined ? { safetyFactor: opts.bundleGasSafetyFactor } : {}),
  };
  // Through `resolveBundleLimits` rather than used raw: the per-transaction cap applies to every bundle regardless of
  // what a caller passes, and packing above it fails at simulation.
  const limits = resolveBundleLimits({ ...fit, bundleGasBudget: opts.maxBundleGas ?? DEFAULT_BUNDLE_GAS_BUDGET });
  return { planOptions, fit, limits };
}

export interface ExecuteDraftPublishOptions {
  /** Optional tag to assign to the new version after `publishVersion` succeeds. */
  tag?: string;
  /**
   * Per-bundle gas budget for `multicall` packing. Defaults to 24M, mirroring
   * the SDK's existing publish path so behaviour is identical across flows.
   */
  maxBundleGas?: number;
  /** Block gas cap. Forwarded to `resolveBundleLimits`. */
  blockGasLimit?: number;
  /** Multiplier applied under the block cap. Forwarded to `resolveBundleLimits`. */
  bundleGasSafetyFactor?: number;
  /** The chain's gas schedule. Default: asked of the node (`detectGasSchedule`). */
  gasSchedule?: GasSchedule;
  /** Under EIP-8037, the most gas the node simulates for one transaction (default 50M). */
  simulationGasCap?: number;
  /** Phase-level lifecycle callback. Fires on entry to each phase. */
  onPhase?: (phase: PublishPhase) => void;
  /**
   * The plan already computed (and shown to the user) by {@link planPublish}. When given, the executor
   * does NOT re-plan and re-probe the chain: it writes exactly what the plan lists, and every later read is
   * a batched confirmation of what was just written. Omit it and the executor plans once itself, which also
   * skips anything another publisher has written since.
   */
  plan?: TxPlan;
  /**
   * What the project's head must be for this publish to go ahead: `null` = still unpublished (a first
   * publish), a CID = exactly that (an update built on it). Checked, together with ownership of the token,
   * BEFORE the first content write: content is permanent and paid for, and the publish that follows is
   * authorized by `ownerOf` alone. Omit to check ownership only.
   */
  expectedHead?: AbxfsCid | null;
  /**
   * Node-level progress: fired after every content transaction with the stage (chunks, chunk nodes, files, entry
   * nodes, directories), level, wave, calls carried, counts done and total, and transactions done and total.
   */
  onProgress?: (event: PublishProgress) => void;
  /** Per-bundle progress for the content phases (one call per transaction). Mirrors `uploadFiles`. */
  onBundleSent?: (info: {
    target: Address;
    callCount: number;
    estimatedGas: number;
    txHash: Hex;
  }) => void;
}

export interface ExecuteDraftPublishResult {
  newRootCid: AbxfsCid;
  /** Assigned by the hook and read back after the publish lands — never predicted. */
  versionNumber: bigint;
  publishTxHash: Hex;
  /** Set only when `opts.tag` was supplied. A tagged publish is two txs — see `publishRoot`. */
  tagTxHash?: Hex;
  /** All tx hashes emitted, in submission order. Useful for explorer links. */
  txHashes: Hex[];
}

/**
 * Execute a draft publish using the delta-only path planned by `planPublish`.
 *
 * Unlike `updateProject` (which re-uploads every file in the new tree), this
 * path only writes:
 *   - chunks that aren't already in `ChunkStore`
 *   - file CIDs that aren't already in `FileStore`
 *   - directory CIDs that aren't already in `DirectoryStore`
 * before calling `publishVersion`. This is what makes incremental updates
 * cheap when paired with the FastCDC chunker — an unchanged file with the
 * same chunks costs zero gas across the entire publish.
 *
 * Which plan runs: `opts.plan`, when given, is executed EXACTLY as handed in. It is NOT re-probed here
 * (the confirmations between stages are batched reads of what was just written, not a second plan), so a
 * plan that has gone stale (another publisher wrote an overlapping chunk, or an earlier attempt of this
 * publish already landed part of it) would rewrite what is already on chain. A caller that may be running a
 * retry must call {@link planPublish} again right before executing and pass THAT plan (the web does, at the
 * start of every attempt). Without `opts.plan` the executor plans once itself, which skips whatever is
 * already present. Either way {@link assertPlanFits} runs first, so a plan holding a call no transaction
 * can execute is refused before any content is written.
 */
export async function executeDraftPublish(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  addresses: ContractAddresses,
  project: ProjectContracts,
  tokenId: bigint,
  applied: AppliedDraft,
  opts: ExecuteDraftPublishOptions = {},
): Promise<ExecuteDraftPublishResult> {
  assertValidPublishInputs({ tag: opts.tag });
  const txHashes: Hex[] = [];
  // Before ANY content is written: the token exists, the signer holds it, and the head is what this
  // update was built on. See `assertCanPublish`.
  await assertCanPublish(clients.publicClient, project, tokenId, clients.walletClient.account?.address, {
    ...(opts.expectedHead !== undefined ? { expectedHead: opts.expectedHead } : {}),
  });
  // The hook validates a root against ITS OWN store pair, so content written to other stores would be vetoed
  // after it is paid for. Refuse here, while it is still free to.
  await assertHookAcceptsContent(clients.publicClient, addresses, project.hook);
  const schedule = await resolveGasSchedule(clients.publicClient, opts.gasSchedule);
  const packing = executorPacking(opts, schedule);
  const plan = opts.plan ?? (await planPublish(clients.publicClient, addresses, applied, { tag: opts.tag, ...packing.planOptions }));
  // A plan handed in is checked too: refuse before the first content transaction, not after paying for it.
  assertPlanFits(plan, applied, packing.fit);
  const limits = packing.limits;


  await runContentStages(
    clients,
    addresses,
    buildContentStages(addresses, plan, schedule),
    limits,
    txHashes,
    {
      rootCid: applied.newRootCid,
      rootIsDirectory: draftRootIsDirectory(applied),
      ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.onBundleSent ? { onBundleSent: opts.onBundleSent } : {}),
    },
  );

  // 4) Publish the new root, plus the tag when one was requested.
  const { publishTxHash, tagTxHash, versionNumber } = await publishRoot(
    clients,
    project,
    tokenId,
    applied.newRootCid,
    opts,
    txHashes,
  );

  opts.onPhase?.("complete");
  return {
    newRootCid: applied.newRootCid,
    versionNumber,
    publishTxHash,
    tagTxHash,
    txHashes,
  };
}

/**
 * The trailing publish step, shared by the update and new-project flows.
 *
 * A tagged publish is two transactions, and that is not an oversight: the CID write lands on the ABX
 * collection while the tag lands on the hook, so no single-contract multicall can span the two.
 *
 * A wallet supporting EIP-5792 `wallet_sendCalls` can still present it as one approval by batching
 * them; that belongs in the UI layer, which knows the wallet's capabilities, rather than being faked
 * here.
 */
async function publishRoot(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  project: ProjectContracts,
  tokenId: bigint,
  rootCid: AbxfsCid,
  opts: { tag?: string; onPhase?: (phase: PublishPhase) => void },
  txHashes: Hex[],
): Promise<{ publishTxHash: Hex; tagTxHash?: Hex; versionNumber: bigint }> {
  // The one shared implementation (publish.ts). Do not add a local copy: a fix to the publish-and-tag
  // race must reach every path.
  return publishRootAndTag(clients, project, tokenId, rootCid, opts, txHashes);
}

// ─── New-project publish (the draft pipeline for create-from-scratch) ──
//
// The create flow shares the draft pipeline's plumbing, which batches every phase into multicalls. Its
// public surface mirrors `applyDraftToBase` / `executeDraftPublish` so the web app and CLI present the
// same step-by-step UX for create and update.

/**
 * Apply a replacement to a **file-kind** project.
 *
 * A file-kind project's root IS the file — there is no directory in its tree at all. The ordinary
 * update path cannot handle one: its first move is `walkDirectory(baseRootCid)`, which reverts
 * against a file root, so editing a project the CLI published with `--kind file` failed before it
 * began.
 *
 * That mattered because the kind is permanent. `ProjectHook` locks it on the first publish
 * (`RootKindLocked`), so such a project can never be "migrated" to a directory to make the normal
 * path work — a file-kind project is either editable as a file or not editable at all.
 *
 * The web only ever creates directory projects, so this exists purely for compatibility with
 * projects made elsewhere. Returns the same {@link AppliedDraft} shape, with a single `replace`
 * entry and the file's own CID as the root; `collectDirEntries` recognises that shape and registers
 * no directories.
 */
export async function applyFileReplacement(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  baseRootCid: AbxfsCid,
  replacement: { bytes: Uint8Array; mimeType?: string; path?: string },
  opts: ApplyDraftOptions = {},
): Promise<AppliedDraft> {
  void publicClient;
  const shape = draftShape(addresses, opts);

  // The path is cosmetic for a file-kind project — nothing addresses into it — but the draft model
  // and every diff view key on one, so it carries the old name by default.
  const path = replacement.path ?? "file";

  const planned = await planFile({
    backends: shape.backends,
    bytes: replacement.bytes,
    mimeType: replacement.mimeType,
    codec: shape.codec,
    fastLz: shape.fastLz,
    path,
  });

  return {
    // The file's CID *is* the root. No fold, no directory.
    newRootCid: planned.cid,
    files: [
      {
        path,
        kind: planned.cid === baseRootCid ? "unchanged" : "changed",
        newCid: planned.cid,
        oldCid: baseRootCid,
        codec: planned.codec,
        mimeType: planned.mimeType,
        outputHash: planned.outputHash,
        chunkIds: planned.chunkIds,
        newChunks: planned.chunks,
        tree: planned.tree,
      },
    ],
    backends: shape.backends,
  };
}

/**
 * Build an `AppliedDraft` whose every entry is `kind: "added"`. No on-chain read.
 *
 * Use this to feed `planPublish` and `executeNewProjectPublish` for the
 * create-from-scratch path. Equivalent semantics to:
 *
 *     applyDraftToBase(client, addrs, EMPTY_DIR, descriptors.map(d => ({
 *       kind: "add", path: d.path, bytes: d.bytes, mimeType: d.mimeType,
 *     })))
 *
 * but without the no-op `walkDirectory` round-trip.
 */
export async function applyNewProject(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  descriptors: FileDescriptor[],
  opts: ApplyDraftOptions = {},
): Promise<AppliedDraft> {
  void publicClient;
  if (descriptors.length === 0 && !(opts.emptyDirectories && opts.emptyDirectories.length > 0)) {
    throw new Error("nothing to upload: no files and no empty directories");
  }
  // Before anything is planned: valid, literal paths (a file system's names), each once.
  assertUploadPaths(descriptors.map((d) => d.path), opts.emptyDirectories);
  const shape = draftShape(addresses, opts);

  const files: PlannedFile[] = [];
  for (const d of descriptors) {
    const planned = await planNewFile({ kind: "add", path: d.path, bytes: d.bytes, mimeType: d.mimeType }, shape);
    files.push({ ...planned, path: d.path, kind: "added" });
  }

  const treeFiles = files
    .filter((f) => f.newCid !== undefined)
    .map((f) => ({ path: f.path, cid: f.newCid! }));
  const newRootCid = computeRootCid(treeFiles, opts.emptyDirectories);
  return {
    newRootCid,
    files,
    backends: shape.backends,
    ...(opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {}),
  };
}

export type ExecuteNewProjectPublishOptions = ExecuteDraftPublishOptions;

export interface ExecuteNewProjectPublishResult {
  /** The project's token id. Supplied by the caller — nothing here assigns it. */
  tokenId: bigint;
  rootCid: AbxfsCid;
  versionNumber: bigint;
  publishTxHash: Hex;
  /** Set only when `opts.tag` was supplied. */
  tagTxHash?: Hex;
  /** Set only when a non-empty `name` was supplied. */
  nameTxHash?: Hex;
  /** All tx hashes emitted in submission order. */
  txHashes: Hex[];
}

/**
 * Execute the chunk → file → dir → publish pipeline for a project's FIRST version, sharing the
 * multicall packing and phase callbacks with the delta-publish path.
 *
 * Nothing is created on-chain here any more. A project IS an ABX token, so it exists before this
 * runs — minting is an ABX mint (open and free on the canonical collection) and is deliberately a
 * separate step, which is also what lets a caller publish into a token they already own or bought.
 * What makes this "new" rather than an update is only that the base tree is empty and the name gets
 * written alongside the first root.
 *
 * Phase ids surfaced via `opts.onPhase`:
 *
 *     "writing-chunks" → "creating-files" → "creating-directories"
 *       → "publishing-version" → "complete"
 *
 * (Reuses "publishing-version" rather than adding a phase id, so a progress modal can render one
 * set of step rows for both flows.)
 */
export async function executeNewProjectPublish(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  addresses: ContractAddresses,
  project: ProjectContracts,
  tokenId: bigint,
  name: string,
  applied: AppliedDraft,
  opts: ExecuteNewProjectPublishOptions = {},
): Promise<ExecuteNewProjectPublishResult> {
  assertValidPublishInputs({ tag: opts.tag, name });
  const txHashes: Hex[] = [];
  // Before ANY content is written (see `assertCanPublish`): a first publish goes to a token the signer
  // holds that has no content yet. Anything else is refused while it is still free to refuse.
  await assertCanPublish(clients.publicClient, project, tokenId, clients.walletClient.account?.address, {
    expectedHead: opts.expectedHead === undefined ? null : opts.expectedHead,
  });
  // See `executeDraftPublish`: a hook bound to other stores would veto the root after the content is paid for.
  await assertHookAcceptsContent(clients.publicClient, addresses, project.hook);
  // Plan once, here, unless the caller hands over the plan it already showed the user: a plan passed in is
  // executed as given, with no second pass of probes. Without one, the single batched plan also skips
  // anything another publisher has written since `applyNewProject`.
  const schedule = await resolveGasSchedule(clients.publicClient, opts.gasSchedule);
  const packing = executorPacking(opts, schedule);
  const plan = opts.plan ?? (await planPublish(clients.publicClient, addresses, applied, { tag: opts.tag, ...packing.planOptions }));
  // A plan handed in is checked too: refuse before the first content transaction, not after paying for it.
  assertPlanFits(plan, applied, packing.fit);
  const limits = packing.limits;


  await runContentStages(
    clients,
    addresses,
    buildContentStages(addresses, plan, schedule),
    limits,
    txHashes,
    {
      rootCid: applied.newRootCid,
      rootIsDirectory: draftRootIsDirectory(applied),
      ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.onBundleSent ? { onBundleSent: opts.onBundleSent } : {}),
    },
  );

  const { publishTxHash, tagTxHash, versionNumber } = await publishRoot(
    clients,
    project,
    tokenId,
    applied.newRootCid,
    opts,
    txHashes,
  );

  // The name is a separate `abxfs.name` param write, so it is a separate tx. It is sent AFTER the
  // root on purpose: a project with content and no name is a cosmetic gap, whereas a named project
  // with no content is an empty shell in every listing.
  let nameTxHash: Hex | undefined;
  if (name) {
    opts.onPhase?.("setting-name");
    nameTxHash = await setProjectName(clients.walletClient, project, tokenId, name);
    txHashes.push(nameTxHash);
    await waitForSuccessfulReceipt(clients.publicClient, nameTxHash, "setName");
  }

  opts.onPhase?.("complete");
  return {
    tokenId,
    rootCid: applied.newRootCid,
    versionNumber,
    publishTxHash,
    tagTxHash,
    nameTxHash,
    txHashes,
  };
}

/**
 * Write a set of files and their directory tree to the content stores, with no project involved: the
 * batched chunk -> file -> directory pipeline (the one the web uses), for callers that only want content on
 * chain (the CLI's `upload`, `uploadFiles`).
 *
 * This replaced a per-file loop that wrote each file's chunks, then its `createFile`, as separate
 * transactions with their own existence reads and confirmations: ~4 reads and 2 transactions per file. Here
 * every file's chunks share bundles, every probe is a batched multicall, and nothing is re-planned between
 * stages. `plan` is what was actually written (empty lists mean "already on chain").
 */
export async function uploadContent(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  addresses: ContractAddresses,
  descriptors: FileDescriptor[],
  opts: ApplyDraftOptions &
    Pick<
      ExecuteDraftPublishOptions,
      "maxBundleGas" | "blockGasLimit" | "bundleGasSafetyFactor" | "gasSchedule" | "simulationGasCap" | "onPhase" | "onProgress" | "onBundleSent"
    > & {
      applied?: AppliedDraft;
      plan?: TxPlan;
    } = {},
): Promise<{ applied: AppliedDraft; plan: TxPlan; txHashes: Hex[] }> {
  const applied = opts.applied ?? (await applyNewProject(clients.publicClient, addresses, descriptors, opts));
  const schedule = await resolveGasSchedule(clients.publicClient, opts.gasSchedule);
  // Planned with the same limits the executor packs with, so the predicted transactions are the ones that run.
  const packing = executorPacking(opts, schedule);
  const plan = opts.plan ?? (await planPublish(clients.publicClient, addresses, applied, packing.planOptions));
  assertPlanFits(plan, applied, packing.fit);
  const limits = packing.limits;
  const txHashes: Hex[] = [];
  await runContentStages(clients, addresses, buildContentStages(addresses, plan, schedule), limits, txHashes, {
    rootCid: applied.newRootCid,
    rootIsDirectory: draftRootIsDirectory(applied),
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.onBundleSent ? { onBundleSent: opts.onBundleSent } : {}),
  });
  return { applied, plan, txHashes };
}

// ─── diffRoots: compare two on-chain trees ────────────────────────────────

export interface DiffRootsEntry {
  path: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  fromCid?: AbxfsCid;
  toCid?: AbxfsCid;
}

export interface DiffRootsResult {
  entries: DiffRootsEntry[];
  added: DiffRootsEntry[];
  removed: DiffRootsEntry[];
  changed: DiffRootsEntry[];
  unchanged: DiffRootsEntry[];
  /** Empty directories in `to` that `from` does not have as empty directories, and the reverse. */
  emptyDirectoriesAdded: string[];
  emptyDirectoriesRemoved: string[];
  fromRootCid: AbxfsCid;
  toRootCid: AbxfsCid;
}

/**
 * Compare two on-chain root CIDs file-by-file, and their empty directories. Both sides are walked via
 * `walkDirectoryTree` (in parallel) and joined by path. Cheap — only chain reads on the directory layer,
 * never the actual file bytes.
 */
export async function diffRoots(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  fromRootCid: AbxfsCid,
  toRootCid: AbxfsCid,
): Promise<DiffRootsResult> {
  const [fromTree, toTree] = await Promise.all([
    walkDirectoryTree(publicClient, addresses, fromRootCid),
    walkDirectoryTree(publicClient, addresses, toRootCid),
  ]);
  const fromMap = new Map(fromTree.files.map((f) => [f.path, f.cid]));
  const toMap = new Map(toTree.files.map((f) => [f.path, f.cid]));
  const empties = emptyDirectoryChanges(fromTree.emptyDirectories, toTree.emptyDirectories);

  const entries: DiffRootsEntry[] = [];
  const seen = new Set<string>();
  for (const [path, toCid] of toMap) {
    seen.add(path);
    const fromCid = fromMap.get(path);
    if (!fromCid) entries.push({ path, kind: "added", toCid });
    else if (fromCid !== toCid) entries.push({ path, kind: "changed", fromCid, toCid });
    else entries.push({ path, kind: "unchanged", fromCid, toCid });
  }
  for (const [path, fromCid] of fromMap) {
    if (!seen.has(path)) entries.push({ path, kind: "removed", fromCid });
  }
  // Stable sort by path so callers don't have to re-sort for display.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    entries,
    added: entries.filter((e) => e.kind === "added"),
    removed: entries.filter((e) => e.kind === "removed"),
    changed: entries.filter((e) => e.kind === "changed"),
    unchanged: entries.filter((e) => e.kind === "unchanged"),
    emptyDirectoriesAdded: empties.added,
    emptyDirectoriesRemoved: empties.removed,
    fromRootCid,
    toRootCid,
  };
}

/**
 * Convenience: convert a draft's per-file plan into the `FileDescriptor[]`
 * shape the existing `uploadFiles` / `updateProject` SDK helpers expect, so
 * callers that prefer the existing publish flow can get there from a draft.
 *
 * Loses the chunk-reuse optimisation (those callers re-chunk + re-upload every
 * file's bytes), so this is only useful when the draft includes ALL files —
 * not merged with a base tree. Provided for completeness; the recommended
 * path is `applyDraftToBase` → `planPublish` → `executePlan` (Phase 3 cont).
 */
export function draftFilesToDescriptors(
  ops: Extract<DraftOp, { kind: "add" | "edit" | "replace" }>[],
): FileDescriptor[] {
  return ops.map((op) => ({
    path: op.path,
    bytes: op.bytes,
    mimeType: op.mimeType ?? inferMimeType(op.path),
  }));
}
