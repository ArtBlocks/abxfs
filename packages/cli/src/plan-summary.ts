/**
 * What an upload will cost, computed offline, for `--dry-run`: how many of each node, how many transactions the
 * executor will send, and the node gas model's estimate. Everything is assumed MISSING (nothing is probed), so it is
 * an upper bound: content that already exists on chain is skipped when the real upload runs, which is also how a
 * re-run resumes an interrupted one.
 */
import {
  buildContentStages,
  packStages,
  planBackendsFor,
  planFile,
  planUploadOffline,
  resolveBundleLimits,
  assertUploadPlanFits,
  type AbxfsCid,
  type ContentPlan,
  type ContractAddresses,
  type FileCodec,
  type FileDescriptor,
  type GasSchedule,
  type PlannedChunk,
  type PlannedDirectory,
  type PlannedUploadFile,
  type StageId,
} from "@abxfs/sdk";

export interface StageSummary {
  stage: StageId;
  level?: number;
  wave?: number;
  calls: number;
  txs: number;
  estimatedGas: number;
}

export interface UploadSummary {
  rootCid: AbxfsCid;
  rootKind: "file" | "directory";
  files: number;
  directories: number;
  uniqueChunks: number;
  /** Bytes handed to storage backends (after per-chunk FastLZ): what the chain keeps. */
  storedBytes: number;
  chunkNodes: number;
  entryNodes: number;
  txs: number;
  estimatedGas: number;
  stages: StageSummary[];
}

export function describeStage(s: { stage: StageId; level?: number | undefined; wave?: number | undefined }): string {
  const label: Record<StageId, string> = {
    chunks: "chunks",
    "chunk-nodes": "chunk nodes",
    files: "files",
    "entry-nodes": "entry nodes",
    directories: "directories",
  };
  return label[s.stage] + (s.level !== undefined ? ` L${s.level}` : "") + (s.wave !== undefined ? ` wave ${s.wave}` : "");
}

/** Plan `files` (a directory upload) or one file (`asFile`) offline and summarise the writes it would take. */
export async function summarizeUpload(args: {
  addresses: ContractAddresses;
  files: FileDescriptor[];
  /** Directories kept with nothing in them (a directory upload only). */
  emptyDirectories?: readonly string[];
  asFile?: boolean;
  codec: FileCodec;
  fastLz: boolean;
  maxBundleGas: number | undefined;
  /** The chain's gas schedule (legacy unless given): under EIP-8037 the same writes cost far more state gas. */
  gasSchedule?: GasSchedule;
}): Promise<UploadSummary> {
  const backends = planBackendsFor(args.addresses);
  const { codec, fastLz } = args;

  let planned: PlannedUploadFile[];
  let directories: PlannedDirectory[];
  let rootCid: AbxfsCid;
  if (args.asFile) {
    const f = args.files[0]!;
    const p = await planFile({ backends, bytes: f.bytes, mimeType: f.mimeType, codec, fastLz, path: f.path });
    assertUploadPlanFits({ files: [p], directories: [] });
    planned = [p];
    directories = [];
    rootCid = p.cid;
  } else {
    const plan = await planUploadOffline(args.files, {
      backends,
      codec,
      fastLz,
      ...(args.emptyDirectories ? { emptyDirectories: args.emptyDirectories } : {}),
    });
    planned = plan.files;
    directories = plan.directories;
    rootCid = plan.rootCid;
  }

  const chunks = new Map<AbxfsCid, PlannedChunk>();
  const chunkNodes = new Map<string, PlannedUploadFile["tree"]["nodes"][number]>();
  for (const f of planned) {
    for (const c of f.chunks) chunks.set(c.id, c);
    for (const n of f.tree.nodes) chunkNodes.set(n.id, n);
  }
  const entryNodes = new Map<string, PlannedDirectory["tree"]["nodes"][number] & { wave: number }>();
  for (const d of directories) {
    for (const n of d.tree.nodes) {
      const seen = entryNodes.get(n.id);
      if (!seen) entryNodes.set(n.id, { ...n, wave: d.height });
      else if (d.height < seen.wave) seen.wave = d.height;
    }
  }
  const plan: ContentPlan = {
    chunksToWrite: [...chunks.values()],
    chunkNodesToCreate: [...chunkNodes.values()],
    filesToCreate: planned.map((f) => ({
      cid: f.cid,
      chunkIds: f.chunkIds,
      mimeType: f.mimeType,
      codec: f.codec,
      outputHash: f.outputHash,
      root: f.tree.root,
    })),
    entryNodesToCreate: [...entryNodes.values()],
    dirsToCreate: directories.map((d) => ({ cid: d.cid, entries: d.entries, path: d.path, root: d.tree.root, height: d.height })),
  };
  const limits = resolveBundleLimits({
    bundleGasBudget: args.maxBundleGas ?? 12_000_000,
    ...(args.gasSchedule ? { schedule: args.gasSchedule } : {}),
  });
  const packed = packStages(buildContentStages(args.addresses, plan, args.gasSchedule), limits);
  const stages: StageSummary[] = packed.map(({ stage, bundles }) => ({
    stage: stage.id,
    ...(stage.level !== undefined ? { level: stage.level } : {}),
    ...(stage.wave !== undefined ? { wave: stage.wave } : {}),
    calls: stage.calls.length,
    txs: bundles.length,
    estimatedGas: bundles.reduce((n, b) => n + b.estimatedGas, 0),
  }));
  return {
    rootCid,
    rootKind: args.asFile ? "file" : "directory",
    files: planned.length,
    directories: directories.length,
    uniqueChunks: chunks.size,
    storedBytes: [...chunks.values()].reduce((n, c) => n + c.input.length, 0),
    chunkNodes: chunkNodes.size,
    entryNodes: entryNodes.size,
    txs: stages.reduce((n, s) => n + s.txs, 0),
    estimatedGas: stages.reduce((n, s) => n + s.estimatedGas, 0),
    stages,
  };
}
