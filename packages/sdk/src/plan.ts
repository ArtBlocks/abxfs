/**
 * Upload planning — the whole ABX FS write pipeline, with no chain attached.
 *
 * Everything about turning bytes into ids is here: apply a file codec, chunk with FastCDC, choose a backend and compute
 * the id of each chunk, pack chunk and entry trees, fold file CIDs into directories. None of it needs an RPC endpoint,
 * a wallet, or a node, so it runs in a browser, an edge function, or a CI job offline.
 *
 * This module exists because that pipeline once drifted into four implementations, each re-deriving the same CIDs.
 * Four copies of a hash preimage is a latent split-brain, so every caller plans through here, and the agreement is a
 * test rather than a comment.
 *
 * Invariants worth stating, because each is easy to violate from the outside (`specs/abx-fs.md`):
 *
 *   - **Chunk ids are backend-bound.** The backend's *address* is in every chunk id, so the same bytes planned against
 *     another backend give other ids and other CIDs. Backends always come from the caller or the address book.
 *   - **Per-chunk compression is a backend choice.** A chunk goes to the FastLZ backend (stored compressed, inflated on
 *     chain) when FastLZ shrinks it, and to the raw backend otherwise. Either way its id commits to its DATA, so the
 *     choice never changes what a reader gets, only where and how compactly it is kept.
 *   - **A file codec is off chain.** With one, the file's data is `encode(content)`, its chunks go to the raw backend
 *     (the data is already compressed), and `outputHash = keccak256(content)` pins what a reader must decode to.
 *   - **The IPFS CID is computed over content**, so it is the same whatever backends or codec were used.
 */
import type { Address } from "viem";

import { ZERO_HASH, chunkId, ipfsFileCid, keccak256Hex, sortDirectoryEntries } from "./cid.js";
import { chunkBytes } from "./chunking/index.js";
import { assertDirectoryFits, assertFileFits, resolveSingleCallCeiling } from "./gas.js";
import { packDirectory, packFile, type PackedTree } from "./nodes.js";
import { CODEC_NONE, getFileCodec, isNoCodec } from "./compression.js";
import { flzCompress } from "./fastlz.js";
import type { AbxfsCid, ContractAddresses, DirectoryEntry, FileCodec, FileDescriptor } from "./types.js";
import { assertLiteralPath, encodeEntryName } from "./names.js";
import { inferMimeType, validateRelativePath } from "./util.js";

/** The input cap of both SSTORE2 backends: EIP-170's code limit minus the STOP byte (a contract constant). */
export const SSTORE2_MAX_INPUT = 24_575;

/** The backends a plan writes through. */
export interface PlanBackends {
  /** Stores input unchanged (`Sstore2Backend`). Every chunk FastLZ does not shrink goes here. */
  raw: Address;
  /** Stores FastLZ input and inflates it on chain (`FastLzSstore2Backend`). Omit to never compress per chunk. */
  fastLz?: Address;
  /** The largest input both backends accept. Default {@link SSTORE2_MAX_INPUT}. */
  maxInputSize?: number;
}

/** One chunk of a planned file, ready for `ChunkStore.write(backend, input, dataHash, size)`. */
export interface PlannedChunk {
  id: AbxfsCid;
  backend: Address;
  /** The bytes handed to the backend: FastLZ output, or the data itself. */
  input: Uint8Array;
  inputHash: AbxfsCid;
  /** `keccak256` of the chunk's data (what the backend returns). */
  dataHash: AbxfsCid;
  /** Length of the chunk's data. */
  size: number;
}

/**
 * A single planned file: its CID and everything an uploader needs to write it.
 *
 * Named to distinguish it from `draft.PlannedFile`, which is a per-file *diff status* for a draft UI, not the plan for
 * writing one file's bytes.
 */
export interface PlannedUploadFile {
  path: string;
  cid: AbxfsCid;
  mimeType: string;
  /** The file codec label (zero for none). */
  codec: FileCodec;
  /** `keccak256(content)` when a codec is set; zero otherwise. */
  outputHash: AbxfsCid;
  /** The chunks in order: the leaves of {@link tree}. Empty for the empty file. */
  chunks: PlannedChunk[];
  /** `chunks.map(c => c.id)`. */
  chunkIds: AbxfsCid[];
  /** The chunk-node tree; `cid` is `FileStore`'s CID for its root, mime, codec and output hash, computed here. */
  tree: PackedTree;
  /** Content size: what a reader finally gets. */
  logicalSize: number;
  /** Data size: the chunks' data joined (equal to `logicalSize` without a codec). */
  dataSize: number;
  /** Bytes handed to backends: what the chain pays to keep. */
  storedSize: number;
}

/** One directory node in a planned tree. */
export interface PlannedDirectory {
  cid: AbxfsCid;
  /** POSIX path of this directory, `""` for the root. */
  path: string;
  /** Entries in unsigned byte order of name: the order of the leaves of {@link tree}. */
  entries: DirectoryEntry[];
  /** The directory's entry-node tree; `cid` is `DirectoryStore`'s CID for its root. Empty for an empty directory. */
  tree: PackedTree;
  /**
   * 0 when no entry is a subdirectory, else 1 + the tallest subdirectory's height. Directories of equal height are
   * independent of each other, which is what lets an executor batch a whole height into shared transactions.
   */
  height: number;
}

/** Plan one chunk of data: FastLZ when it shrinks the chunk and a FastLZ backend is given, the raw backend otherwise. */
export function planChunk(data: Uint8Array, backends: PlanBackends, opts: { fastLz?: boolean } = {}): PlannedChunk {
  const max = backends.maxInputSize ?? SSTORE2_MAX_INPUT;
  if (data.length === 0) throw new Error("a chunk holds at least one byte");
  let backend = backends.raw;
  let input = data;
  if (backends.fastLz && opts.fastLz !== false) {
    const packed = flzCompress(data);
    if (packed.length < data.length && packed.length <= max) {
      backend = backends.fastLz;
      input = packed;
    }
  }
  if (input.length > max) throw new Error(`chunk input of ${input.length} bytes exceeds the backend's ${max}`);
  const inputHash = keccak256Hex(input);
  const dataHash = input === data ? inputHash : keccak256Hex(data);
  return { id: chunkId(backend, inputHash, dataHash, data.length), backend, input, inputHash, dataHash, size: data.length };
}

/**
 * Plan one file: optional codec, chunking, a backend per chunk, ids, the chunk tree and the CID. Pure.
 *
 * Without a codec, chunks are FastCDC pieces of the content and each goes to FastLZ or raw on its own. With a codec,
 * the content is encoded first, the encoded stream is chunked, and every chunk goes raw. An empty file has no chunks
 * and no codec.
 */
export async function planFile(args: {
  backends: PlanBackends;
  bytes: Uint8Array;
  mimeType?: string | undefined;
  /** File codec label; default none. */
  codec?: FileCodec;
  /** Use the FastLZ backend for chunks it shrinks (default true; ignored with a codec). */
  fastLz?: boolean;
  path?: string;
}): Promise<PlannedUploadFile> {
  const { backends, bytes } = args;
  const path = args.path ?? "";
  const mimeType = args.mimeType || inferMimeType(path);
  const max = backends.maxInputSize ?? SSTORE2_MAX_INPUT;
  const codec = bytes.length === 0 ? CODEC_NONE : (args.codec ?? CODEC_NONE);
  const withCodec = !isNoCodec(codec);

  const data = withCodec ? await Promise.resolve(getFileCodec(codec).encode(bytes)) : bytes;
  const outputHash = withCodec ? keccak256Hex(bytes) : ZERO_HASH;
  const pieces = data.length === 0 ? [] : chunkBytes(data, { backendMax: max });
  const chunks = pieces.map((p) => planChunk(p, backends, { fastLz: !withCodec && args.fastLz !== false }));
  const chunkIds = chunks.map((c) => c.id);
  const { cid, tree } = packFile({
    chunkIds,
    chunkSizes: chunks.map((c) => c.size),
    mimeType,
    codec,
    outputHash,
    path,
  });

  let storedSize = 0;
  for (const c of chunks) storedSize += c.input.length;
  return {
    path,
    cid,
    mimeType,
    codec,
    outputHash,
    chunks,
    chunkIds,
    tree,
    logicalSize: bytes.length,
    dataSize: data.length,
    storedSize,
  };
}

/**
 * Refuse a set of upload paths that names one path twice. Both copies would be planned and written, and the directory
 * would keep whichever came last: content paid for and silently dropped. Checked before anything is planned or written.
 */
export function assertUniqueUploadPaths(paths: Iterable<string>): void {
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) throw new Error(`"${p.slice(0, 200)}" is in this upload twice; every path must be unique. Nothing was written.`);
    seen.add(p);
  }
}

/**
 * Check the paths of files (and empty directories) a person or a file system supplied, before anything is planned:
 * each is a valid relative path, none holds a backslash (`names.ts`: such a name is literal text and `\` is the one
 * character no name may contain), and no file path appears twice.
 */
export function assertUploadPaths(paths: readonly string[], emptyDirectories: readonly string[] = []): void {
  for (const p of [...paths, ...emptyDirectories]) {
    validateRelativePath(p);
    assertLiteralPath(p);
  }
  assertUniqueUploadPaths(paths);
}

interface TreeNode {
  files: Map<string, AbxfsCid>;
  dirs: Map<string, TreeNode>;
}

function newNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

/**
 * Fold `path → cid` pairs (and any empty directories) into a directory tree and compute every node's CID. Pure.
 *
 * Path segments are names in their text form (`names.ts`), so a name read from chain that is not UTF-8 folds back to
 * its exact bytes. A path given twice is refused, never resolved by letting one copy win.
 *
 * Returns directories **children-first**, which is the order an uploader must create them in: a parent's CID commits
 * to its children's CIDs, so a parent cannot be written before them. No files and no directories is the empty
 * directory, which exists on chain without being created.
 */
export function planDirectoryTree(
  files: Array<{ path: string; cid: AbxfsCid }>,
  opts: { emptyDirectories?: readonly string[] } = {},
): {
  rootCid: AbxfsCid;
  directories: PlannedDirectory[];
} {
  const root = newNode();
  const descend = (parts: string[]): TreeNode => {
    let cur = root;
    for (const seg of parts) {
      if (cur.files.has(seg)) throw new Error(`"${seg}" is both a file and a directory`);
      if (!cur.dirs.has(seg)) cur.dirs.set(seg, newNode());
      cur = cur.dirs.get(seg)!;
    }
    return cur;
  };
  for (const { path, cid } of files) {
    const parts = path.split("/");
    const name = parts.pop()!;
    const dir = descend(parts);
    if (dir.dirs.has(name)) throw new Error(`"${path}" is both a file and a directory`);
    if (dir.files.has(name)) throw new Error(`"${path.slice(0, 200)}" is in this tree twice; every path must be unique`);
    dir.files.set(name, cid);
  }
  for (const d of opts.emptyDirectories ?? []) {
    validateRelativePath(d);
    for (const seg of d.split("/")) encodeEntryName(seg);
    descend(d.split("/"));
  }

  const directories: PlannedDirectory[] = [];
  const rootCid = walk(root, "", directories);
  return { rootCid, directories };
}

function walk(node: TreeNode, path: string, out: PlannedDirectory[]): AbxfsCid {
  const entries: DirectoryEntry[] = [];
  const heights = new Map<AbxfsCid, number>();
  for (const [name, cid] of node.files) entries.push({ name, cid, isDirectory: false });
  for (const [name, child] of node.dirs) {
    const childPath = path ? `${path}/${name}` : name;
    const childCid = walk(child, childPath, out);
    heights.set(childCid, out[out.length - 1]!.height);
    entries.push({ name, cid: childCid, isDirectory: true });
  }
  // Packing sorts into unsigned byte order, so the insertion order above is irrelevant.
  const { cid, tree } = packDirectory(entries, { path });
  const height = heights.size === 0 ? 0 : 1 + Math.max(...heights.values());
  out.push({ cid, path, entries: sortDirectoryEntries(entries), tree, height });
  return cid;
}

/**
 * Refuse a plan that cannot be written: a directory or file that would need more than the protocol's level cap
 * (see `PlanTooLargeError`); a large one is NOT refused, it is more nodes.
 * Pure: runs on the offline plan, so the web staging panel and the CLI refuse before anything is signed, and
 * before a wallet is even asked. Names the offending directory path or file.
 */
export function assertUploadPlanFits(
  plan: Pick<UploadPlanOffline, "files" | "directories">,
  opts: { singleCallCeiling?: number } = {},
): void {
  const ceiling = opts.singleCallCeiling ?? resolveSingleCallCeiling();
  for (const f of plan.files) assertFileFits(f.path, f.chunkIds.length, f.storedSize, ceiling);
  for (const d of plan.directories) assertDirectoryFits(d.path, d.entries, ceiling);
}

/** Convenience: just the root CID for a set of `path → cid` pairs. */
export function foldDirectoryCid(
  files: Array<{ path: string; cid: AbxfsCid }>,
  opts: { emptyDirectories?: readonly string[] } = {},
): AbxfsCid {
  return planDirectoryTree(files, opts).rootCid;
}

/** A complete offline upload plan. */
export interface UploadPlanOffline {
  files: PlannedUploadFile[];
  directories: PlannedDirectory[];
  rootCid: AbxfsCid;
  rootKind: "directory";
  /**
   * Distinct chunk ids across the whole upload. Lower than the sum of per-file chunk counts whenever files share
   * content: identical chunks are stored once, so this is what the upload actually writes.
   */
  uniqueChunks: number;
  /** Bytes handed to backends, after dedup within this upload. */
  storedBytes: number;
  /** Logical bytes a reader gets back. */
  logicalBytes: number;
}

/**
 * Plan an entire upload offline: every file CID, every directory CID, the root, and what it stores.
 *
 * `backends` is required and has no default, because chunk ids are bound to the backend addresses.
 * {@link planBackendsFor} takes them from an address book.
 */
export async function planUploadOffline(
  files: FileDescriptor[],
  opts: {
    backends: PlanBackends;
    /** File codec for every file; default none (and FastLZ per chunk). */
    codec?: FileCodec;
    /** Per-chunk FastLZ (default true). */
    fastLz?: boolean;
    /** Directories to create even though no file is in them. */
    emptyDirectories?: readonly string[];
    /** Also derive the IPFS CIDv1 for each file. Costs a SHA-256 pass over the content. */
    ipfsCids?: boolean;
    /** Most estimated gas one `createDirectory` / `createFile` may need. Default: see `resolveSingleCallCeiling`. */
    singleCallCeiling?: number;
  },
): Promise<UploadPlanOffline & { ipfsCids?: Record<string, string> }> {
  // Before anything is planned: a duplicate path would otherwise be planned twice and silently resolved.
  assertUploadPaths(files.map((f) => f.path), opts.emptyDirectories);
  const planned: PlannedUploadFile[] = [];
  for (const f of files) {
    planned.push(
      await planFile({
        backends: opts.backends,
        bytes: f.bytes,
        mimeType: f.mimeType,
        ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
        ...(opts.fastLz !== undefined ? { fastLz: opts.fastLz } : {}),
        path: f.path,
      }),
    );
  }

  const { rootCid, directories } = planDirectoryTree(
    planned.map((p) => ({ path: p.path, cid: p.cid })),
    opts.emptyDirectories ? { emptyDirectories: opts.emptyDirectories } : {},
  );

  // A directory or file no single transaction can register is refused here, before anything is paid for.
  assertUploadPlanFits(
    { files: planned, directories },
    opts.singleCallCeiling !== undefined ? { singleCallCeiling: opts.singleCallCeiling } : {},
  );

  const seen = new Set<string>();
  let storedBytes = 0;
  let logicalBytes = 0;
  for (const p of planned) {
    logicalBytes += p.logicalSize;
    for (const c of p.chunks) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      storedBytes += c.input.length;
    }
  }

  const plan: UploadPlanOffline & { ipfsCids?: Record<string, string> } = {
    files: planned,
    directories,
    rootCid,
    rootKind: "directory",
    uniqueChunks: seen.size,
    storedBytes,
    logicalBytes,
  };

  if (opts.ipfsCids) {
    const ipfsCids: Record<string, string> = {};
    for (const f of files) ipfsCids[f.path] = await ipfsFileCid(f.bytes);
    plan.ipfsCids = ipfsCids;
  }

  return plan;
}

/** The SDK's recommended backends from an address book (the raw and FastLZ SSTORE2 backends). */
export function planBackendsFor(addresses: Pick<ContractAddresses, "sstore2Backend" | "fastLzBackend">): PlanBackends {
  if (!addresses.sstore2Backend) {
    throw new Error(
      "the address book has no `sstore2Backend`: chunk ids are bound to the backend address, so a plan needs one",
    );
  }
  return {
    raw: addresses.sstore2Backend,
    ...(addresses.fastLzBackend ? { fastLz: addresses.fastLzBackend } : {}),
    maxInputSize: SSTORE2_MAX_INPUT,
  };
}

