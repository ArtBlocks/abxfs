/**
 * Pin ABX FS content (a directory tree or a single file) to IPFS.
 *
 *   1. Read the content from chain, each distinct file and directory once, and derive its IPFS DAG with the SDK's
 *      profile (CIDv1, sha2-256, 256 KiB raw leaves, balanced dag-pb files, flat dag-pb directories), keeping every
 *      block the derivation hashes. A file's IPFS form is its content: FastLZ chunks inflated, a codec decoded.
 *   2. Write those blocks to a CARv1 whose root is the derived root.
 *   3. Hand the CAR to a provider, which imports the blocks and pins the root.
 *   4. Compare the root the provider reports with the derived one.
 *
 * The provider rebuilds nothing, so the pinned DAG is the derived DAG for any tree: an empty directory, an empty file
 * and a codec file need no special handling.
 */
import {
  type Ancestry,
  type AbxfsClient,
  type AbxfsCid,
  type IpfsBlock,
  type IpfsCid,
  ProjectKind,
  TraversalBudget,
  type TraversalLimits,
  CodecNotSupportedOnChainError,
  DirectoryNeedsShardingError,
  IPFS_SHARD_THRESHOLD_BYTES,
  autoRegisterNodeCodecs,
  descend,
  entryNameBytes,
  ipfsDirectoryCid,
  ipfsDirectoryEstimate,
  ipfsDirectoryNeedsSharding,
  ipfsFileCidWithSize,
  locateContent,
  readDirectory,
  readFile,
} from "@abxfs/sdk";

import { CAR_MEDIA_TYPE, encodeCar } from "./car.js";
import type { PinnedFile, PinningProvider } from "./types.js";

/**
 * Thrown when a directory is one IPFS would shard (`ipfsDirectoryNeedsSharding`): its flat dag-pb CID is not what
 * `ipfs add -r` produces, and the sharded form is not derived here, so nothing is pinned. A `DirectoryNeedsShardingError`,
 * under its own name (callers match this one by name).
 */
export class DirectoryTooLargeForFlatIpfsError extends DirectoryNeedsShardingError {
  override readonly name = "DirectoryTooLargeForFlatIpfsError";
  constructor(
    readonly directoryCid: string,
    readonly entryCount: number,
    /** The IPFS size estimate (name bytes plus child CID bytes) that passed the threshold. */
    readonly blockBytes: number,
  ) {
    super(directoryCid, blockBytes);
    this.message =
      `directory ${directoryCid} has ${entryCount} entries: needs sharding, not supported. Its IPFS size estimate is ${blockBytes} bytes, ` +
      `over the ${IPFS_SHARD_THRESHOLD_BYTES} at which IPFS shards a directory (HAMT), and ABX FS does not derive that form yet, so no ` +
      "correct IPFS CID can be produced. Nothing was pinned. Split the directory into subdirectories, or fetch it from an ABX FS gateway.";
  }
}

/** What an ABX FS root is. */
export type ContentKind = "file" | "directory";

export interface DeriveCarArgs {
  client: AbxfsClient;
  /** An ABX FS root: a directory or a file. */
  root: AbxfsCid;
  /** What `root` is, when the caller knows. Otherwise both stores are asked. */
  kind?: ContentKind;
  /** Fired once per distinct file, with the first path it was found at, as it is read and hashed. */
  onFile?: (file: PinnedFile) => void;
  /**
   * Caps on the walk: distinct nodes (default 100,000) and total bytes read (default 1 GiB). A tree that exceeds
   * either fails with `LimitExceededError`. Every distinct directory and file is read once however often a (possibly
   * hostile) DAG links it, and a directory that lists itself as a descendant fails rather than hangs.
   */
  limits?: TraversalLimits;
}

export interface DerivedCar {
  /** The derived IPFS root. */
  root: IpfsCid;
  kind: ContentKind;
  /** A CARv1 naming {@link root}: the root block first, then every other block of the DAG once. */
  car: Blob;
  blockCount: number;
  /** Each distinct file once, at the first path it was found (`""` for a file root). */
  files: PinnedFile[];
}

export interface PinArgs extends DeriveCarArgs {
  provider: PinningProvider;
  /**
   * Throw when the root the provider reports differs from the derived root (default true). With `false` the result
   * says so in {@link PinResult.verified} instead.
   */
  verify?: boolean;
  /** A label for providers that keep one (Pinata). Defaults to the derived IPFS root. */
  name?: string;
}

export interface PinResult {
  /** The IPFS root derived from chain (and named in the CAR). */
  expectedCid: IpfsCid;
  /** The root the provider reports it pinned. */
  pinnedCid: IpfsCid;
  /** True when {@link expectedCid} === {@link pinnedCid}. */
  verified: boolean;
  kind: ContentKind;
  files: PinnedFile[];
  blockCount: number;
  carBytes: number;
}

/** Derive the IPFS DAG of an ABX FS root from chain and write it as a CARv1. Uploads nothing. */
export async function deriveCar({ client, root, kind, onFile, limits }: DeriveCarArgs): Promise<DerivedCar> {
  // A file stored with a codec is read as its decoded content; this makes gzip, br, deflate (and zstd where Node has
  // it) readable. It does nothing outside Node.
  await autoRegisterNodeCodecs();
  const k = kind ?? (await probeKind(client, root));
  const ctx: Ctx = {
    client,
    budget: new TraversalBudget(limits),
    blocks: new Map(),
    dirs: new Map(),
    fileReads: new Map(),
    files: [],
    ...(onFile ? { onFile } : {}),
  };
  const top = k === "directory" ? await dirNode(ctx, root, "", undefined) : await fileNode(ctx, root, "");
  const rootBlock = ctx.blocks.get(top.cid);
  if (!rootBlock) throw new Error(`internal: the derived root ${top.cid} has no block`);
  const ordered = [rootBlock, ...[...ctx.blocks.values()].filter((b) => b !== rootBlock)];
  const car = new Blob(encodeCar(rootBlock.cidBytes, ordered) as BlobPart[], { type: CAR_MEDIA_TYPE });
  return { root: top.cid, kind: k, car, blockCount: ordered.length, files: ctx.files };
}

/**
 * Derive the CAR for `root`, have `provider` import and pin it, and check the root it reports. The provider is asked
 * first whether it answers (`preflight`), before the tree is read from chain; and where the on-chain resolver can
 * derive the IPFS CID, it must agree with the derived root before anything is uploaded, so a wrong root is never
 * pinned.
 */
export async function pinRoot({ provider, verify = true, name, ...derive }: PinArgs): Promise<PinResult> {
  await provider.preflight?.();
  const { root, kind, car, blockCount, files } = await deriveCar(derive);
  const onChain = await onChainIpfsCid(derive.client, derive.root);
  if (onChain !== undefined && onChain !== root) {
    throw new Error(
      `[abxfs-pinning] the on-chain resolver derives ${onChain} for ${derive.root}, but the tree read from chain derives ` +
        `${root}; nothing was pinned.`,
    );
  }
  const { pinnedCid } = await provider.pinCar({ root, car, name: name ?? root });
  const verified = pinnedCid === root;
  if (verify && !verified) {
    throw new Error(
      `[abxfs-pinning] provider "${provider.name}" reported root ${pinnedCid} for a CAR whose root is ${root}; ` +
        "the pin cannot be trusted.",
    );
  }
  return { expectedCid: root, pinnedCid, verified, kind, files, blockCount, carBytes: car.size };
}

/**
 * The IPFS CID the on-chain resolver derives for `root`, or `undefined` where it cannot: no resolver configured, a file
 * codec the chain does not decode, or a call the node will not run (content too large for its `eth_call` gas cap).
 * Every one of those leaves the local derivation, read from the same chain, as the only answer.
 */
async function onChainIpfsCid(client: AbxfsClient, root: AbxfsCid): Promise<IpfsCid | undefined> {
  if (!client.addresses.ipfsCidResolver) return undefined;
  try {
    return await client.verifyOnChainIpfsCid(root);
  } catch (err) {
    if (err instanceof CodecNotSupportedOnChainError) return undefined;
    // `deriveCar` refuses a directory IPFS would shard before this is reached; anything else is the node declining.
    if (err instanceof DirectoryNeedsShardingError) throw err;
    return undefined;
  }
}

/** {@link pinRoot} for a root known to be a directory. */
export function pinDirectory({ directoryCid, ...rest }: Omit<PinArgs, "root" | "kind"> & { directoryCid: AbxfsCid }): Promise<PinResult> {
  return pinRoot({ ...rest, root: directoryCid, kind: "directory" });
}

/** {@link pinRoot} for a root known to be a file. */
export function pinFile({ fileCid, ...rest }: Omit<PinArgs, "root" | "kind"> & { fileCid: AbxfsCid }): Promise<PinResult> {
  return pinRoot({ ...rest, root: fileCid, kind: "file" });
}

async function probeKind(client: AbxfsClient, root: AbxfsCid): Promise<ContentKind> {
  const { kind } = await locateContent(client.publicClient, client.addresses, root);
  if (kind === ProjectKind.Directory) return "directory";
  if (kind === ProjectKind.File) return "file";
  throw new Error(`${root} is neither a file nor a directory in the content stores: nothing to pin`);
}

/** A derived node: its IPFS CID and the cumulative size a parent's `PBLink.Tsize` must carry. */
interface Sized {
  cid: IpfsCid;
  tsize: number;
}

/** Per-run state: memoised reads (a shared sub-DAG is visited once), the size budget, and the blocks kept so far. */
interface Ctx {
  client: AbxfsClient;
  budget: TraversalBudget;
  blocks: Map<string, IpfsBlock>;
  dirs: Map<string, Promise<Sized>>;
  fileReads: Map<string, Promise<Sized>>;
  files: PinnedFile[];
  onFile?: (file: PinnedFile) => void;
}

function keepBlock(ctx: Ctx): (b: IpfsBlock) => void {
  return (b) => {
    if (!ctx.blocks.has(b.cid)) ctx.blocks.set(b.cid, b);
  };
}

function fileNode(ctx: Ctx, cid: AbxfsCid, path: string): Promise<Sized> {
  const key = cid.toLowerCase();
  let p = ctx.fileReads.get(key);
  if (!p) {
    ctx.budget.node();
    p = (async () => {
      const { bytes } = await readFile(ctx.client.publicClient, ctx.client.addresses, cid);
      ctx.budget.addBytes(bytes.length);
      const sized = await ipfsFileCidWithSize(bytes, { onBlock: keepBlock(ctx) });
      const file = { path, ipfsCid: sized.cid };
      ctx.files.push(file);
      ctx.onFile?.(file);
      return { cid: sized.cid, tsize: sized.tsize };
    })();
    ctx.fileReads.set(key, p);
  }
  return p;
}

function dirNode(ctx: Ctx, cid: AbxfsCid, path: string, ancestors: Ancestry | undefined): Promise<Sized> {
  const key = cid.toLowerCase();
  // A cid commits to its children, so an honest chain holds no cycle. A hostile RPC can fake one, and the memo would
  // then hand the walk its own unfinished promise; refuse it here instead of waiting forever.
  let here: Ancestry;
  try {
    here = descend(ancestors, key);
  } catch (err) {
    return Promise.reject(err);
  }
  let p = ctx.dirs.get(key);
  if (!p) {
    ctx.budget.node();
    p = dirUncached(ctx, cid, path, here);
    ctx.dirs.set(key, p);
  }
  return p;
}

async function dirUncached(ctx: Ctx, cid: AbxfsCid, path: string, here: Ancestry): Promise<Sized> {
  const directory = await readDirectory(ctx.client.publicClient, ctx.client.addresses, cid, {
    maxEntries: ctx.budget.maxNodes,
  });
  // Refused from the listing alone, before any file under it is read, hashed or uploaded: by the rule IPFS shards by.
  if (ipfsDirectoryNeedsSharding(directory.entries)) {
    throw new DirectoryTooLargeForFlatIpfsError(cid, directory.entries.length, ipfsDirectoryEstimate(directory.entries));
  }

  // UnixFS orders links by the names' bytes, not by UTF-16 code units (they differ above U+D800). A name is its exact
  // bytes as read from chain (`nameBytes`), UTF-8 or not, so the CAR holds the directory the chain holds.
  const sorted = [...directory.entries].sort((a, b) => Buffer.compare(entryNameBytes(a), entryNameBytes(b)));

  const links: Array<{ name: string; nameBytes?: Uint8Array; cid: IpfsCid; tsize: number }> = [];
  let childrenCumulative = 0;
  for (const entry of sorted) {
    const childPath = path ? `${path}/${entry.name}` : entry.name;
    const child = entry.isDirectory
      ? await dirNode(ctx, entry.cid, childPath, here)
      : await fileNode(ctx, entry.cid, childPath);
    links.push({ name: entry.name, ...(entry.nameBytes ? { nameBytes: entry.nameBytes } : {}), cid: child.cid, tsize: child.tsize });
    childrenCumulative += child.tsize;
  }

  const { cid: ipfs, encoded } = await ipfsDirectoryCid(links, { onBlock: keepBlock(ctx), directoryCid: cid });
  // Tsize is the cumulative serialised size of the linked subtree: this block plus every block under it.
  return { cid: ipfs, tsize: encoded.length + childrenCumulative };
}
