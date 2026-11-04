/**
 * Canonical packing for ABX FS: turn a list of chunk ids or directory entries into a tree of immutable nodes, and
 * compute the file and directory CIDs locally, byte for byte as the contracts do. Pure: no chain, no wallet. See
 * `specs/abx-fs.md` §5.
 *
 * **Canonical packing is a client convention, not a contract rule**, so identical content must always pack the
 * same way or it gets different CIDs. The rules, all deterministic:
 *
 *   - Node boundaries are CONTENT-DEFINED (`node-gas.ts` states the exact rules): a leaf or branch ends after an item
 *     whose hash falls under a threshold, between a minimum and a maximum size. So an edit rewrites only the nodes
 *     around it, never every node after it.
 *   - Chunk leaf records are `chunkId:32 || size:6`; file branches carry cumulative bytes as well as counts, so the
 *     store can find any byte offset in one descent.
 *   - No items is the empty tree: root zero and no nodes (the empty file, the empty directory).
 *   - Entries are in unsigned byte order of the name's bytes (UTF-8 for any name the SDK writes; a name read from chain
 *     keeps its exact bytes, UTF-8 or not: `names.ts`).
 *   - As many branch levels are stacked as it takes to reach a single root. The contracts cap the level at 3;
 *     a tree that would need more is refused here, at plan time ({@link PlanTooLargeError}).
 *   - A tree of one node has that node as its root (a leaf, level 0).
 *
 * Nodes are returned children-first, which is the only order they can be created in.
 */
import { keccak256, type Hex } from "viem";

import { PlanTooLargeError } from "./gas.js";
import {
  ENTRY_LEAF_GAS_CAP,
  NODE_MAX_LEVEL,
  branchBlobSize,
  branchGroupSizes,
  chunkLeafBlobSize,
  entryLeafBlobSize,
  estimateBranch,
  estimateChunkLeaf,
  estimateEntryLeaf,
  hashKey,
  nameKey,
  partitionChunkLeaves,
  partitionEntryLeaves,
} from "./node-gas.js";
import { ZERO_HASH } from "./cid.js";
import { decodeEntryName, encodeEntryName, entryNameBytes } from "./names.js";
import type { AbxfsCid, DirectoryEntry, FileCodec } from "./types.js";
import { concatBytes, fromHex, toHex } from "./util.js";

import { CHUNK_LEAF_MAX_HASHES as CHUNK_LEAF_MAX_HASHES_, branchLevelsNeeded } from "./node-gas.js";

export {
  BRANCH_MAX_CHILDREN,
  CHUNK_LEAF_MAX_HASHES,
  ENTRY_LEAF_GAS_CAP,
  NODE_MAX_BYTES,
  NODE_MAX_LEVEL,
} from "./node-gas.js";

/** CID and node-id domain prefixes, one per kind (chunk ids use `0x30`). */
export const FILE_CID_PREFIX = 0x31;
export const DIRECTORY_CID_PREFIX = 0x32;
export const CHUNK_NODE_PREFIX = 0x41;
export const ENTRY_NODE_PREFIX = 0x42;

/** The contract's name rules for a directory entry. */
export const MAX_ENTRY_NAME_BYTES = 255;
/** `FileStore.createFile`'s mime bound. */
export const MAX_MIME_BYTES = 127;
/** The largest byte total a chunk node records (`uint48`): `FileStore` refuses a leaf or branch whose total is larger. */
export const MAX_NODE_BYTES_TOTAL = 2 ** 48 - 1;

const utf8 = new TextEncoder();

/** One immutable node, ready for `putChunkNode` / `putEntryNode`. */
export interface PackedNode {
  /** `keccak256(prefix || blob)`: what the store returns and indexes the node under. */
  id: Hex;
  blob: Uint8Array;
  /** 0 for a leaf, 1..3 for a branch. */
  level: number;
  /** Items (chunk hashes or entries) in the whole subtree. */
  count: number;
  /** Stored bytes in the whole subtree (chunk nodes; 0 for directory nodes). */
  size: number;
  /** Child node ids (branches only), in order. */
  childIds: Hex[];
  /** Estimated gas of the creating call alone, from the node gas model. */
  estimatedGas: number;
}

export interface PackedTree {
  kind: "chunks" | "entries";
  /** The root node id: what `createFile` / `createDirectory` take. Zero for the empty tree. */
  root: Hex;
  /** The root's level (0 when the tree is one leaf). */
  rootLevel: number;
  /** Items in the whole tree. */
  count: number;
  /** Every node, children before parents (all leaves, then level 1, then level 2, ...). Empty for the empty tree. */
  nodes: PackedNode[];
}

/** A file whose bytes pass what a chunk node can record: the contract would refuse it, so no CID is computed for it. */
function fileTooLarge(path: string, total: number): Error {
  return new Error(
    `${path ? `the file "${path}"` : "this file"} totals ${total} bytes in one node, more than the ${MAX_NODE_BYTES_TOTAL} a chunk node can ` +
      "record (`uint48`); FileStore refuses it. Nothing was written.",
  );
}

/** No items: root zero, no nodes. */
function emptyTree(kind: PackedTree["kind"]): PackedTree {
  return { kind, root: ZERO_HASH, rootLevel: 0, count: 0, nodes: [] };
}

function nodeId(prefix: number, blob: Uint8Array): Hex {
  const pre = new Uint8Array(1 + blob.length);
  pre[0] = prefix;
  pre.set(blob, 1);
  return keccak256(pre);
}

/** A field written into a node must fit it: a wrapped value would give a node the contract refuses or reads otherwise. */
function fits(n: number, max: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${what} ${n} does not fit a node field (0 to ${max})`);
}
function u16(n: number): Uint8Array {
  fits(n, 0xffff, "u16");
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}
function u32(n: number): Uint8Array {
  fits(n, 0xffff_ffff, "u32");
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u48(n: number): Uint8Array {
  fits(n, MAX_NODE_BYTES_TOTAL, "u48");
  const out = new Uint8Array(6);
  let v = BigInt(n);
  for (let i = 5; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytes32(hex: string, what: string): Uint8Array {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${what} must be a 32-byte hex string, got ${String(hex)}`);
  }
  return fromHex(hex);
}

/**
 * Stack branches over `leaves` until one root remains. Throws {@link PlanTooLargeError} past the level cap. For a
 * directory, `edges` gives each leaf's first and last name length: a directory branch's gas follows the names its
 * ordering check compares (see `node-gas.ts`).
 */
function stackBranches(
  prefix: number,
  leaves: PackedNode[],
  ctx: { kind: "file" | "directory"; path: string; size: number },
  edges?: Map<string, { first: number; last: number }>,
): PackedNode[] {
  const withBytes = ctx.kind === "file";
  const stride = withBytes ? 42 : 36;
  const all: PackedNode[] = [...leaves];
  let current = leaves;
  let level = 0;
  while (current.length > 1) {
    level++;
    if (level > NODE_MAX_LEVEL) {
      throw new PlanTooLargeError({
        kind: ctx.kind,
        reason: "levels",
        path: ctx.path,
        levelsNeeded: level,
        levelCap: NODE_MAX_LEVEL,
        ...(ctx.kind === "file" ? { chunkCount: ctx.size } : { entryCount: ctx.size }),
      });
    }
    const next: PackedNode[] = [];
    let at = 0;
    for (const groupSize of branchGroupSizes(current.map((k) => hashKey(k.id)))) {
      const kids = current.slice(at, at + groupSize);
      at += groupSize;
      const blob = new Uint8Array(branchBlobSize(kids.length, withBytes));
      blob[0] = level;
      blob.set(u16(kids.length), 1);
      let running = 0;
      let runningBytes = 0;
      kids.forEach((k, i) => {
        running += k.count;
        runningBytes += k.size;
        // `NodeTree` refuses a branch whose running total passes `uint48` (it can never equal the 6-byte field).
        if (withBytes && runningBytes > MAX_NODE_BYTES_TOTAL) throw fileTooLarge(ctx.path, runningBytes);
        const o = 3 + i * stride;
        blob.set(fromHex(k.id), o);
        blob.set(u32(running), o + 32);
        if (withBytes) blob.set(u48(runningBytes), o + 36);
      });
      let edgeNameBytes: number | undefined;
      if (edges) {
        edgeNameBytes = 0;
        for (let i = 1; i < kids.length; i++) {
          edgeNameBytes += (edges.get(kids[i - 1]!.id)?.last ?? 255) + (edges.get(kids[i]!.id)?.first ?? 255);
        }
      }
      const id = nodeId(prefix, blob);
      if (edges) {
        edges.set(id, { first: edges.get(kids[0]!.id)?.first ?? 255, last: edges.get(kids[kids.length - 1]!.id)?.last ?? 255 });
      }
      next.push({
        id,
        blob,
        level,
        count: running,
        size: runningBytes,
        childIds: kids.map((k) => k.id),
        estimatedGas: estimateBranch(kids.length, withBytes, { level, ...(edgeNameBytes !== undefined ? { edgeNameBytes } : {}) }),
      });
    }
    all.push(...next);
    current = next;
  }
  return all;
}

/**
 * Throw {@link PlanTooLargeError} (`reason: "levels"`) if `leafCount` leaves would need more than {@link NODE_MAX_LEVEL}
 * levels of branches. Called before any node is hashed; exported so the cap itself is testable without 1e9 items.
 */
export function assertTreeLevels(leafCount: number, kind: "file" | "directory", path: string, size: number): void {
  const levels = branchLevelsNeeded(leafCount);
  if (levels > NODE_MAX_LEVEL) {
    throw new PlanTooLargeError({
      kind,
      reason: "levels",
      path,
      levelsNeeded: levels,
      levelCap: NODE_MAX_LEVEL,
      ...(kind === "file" ? { chunkCount: size } : { entryCount: size }),
    });
  }
}

/**
 * Pack a file's chunks (ids and data sizes, in order) into a chunk-node tree. No chunks is the empty file (root zero).
 * Throws on a size outside 1 to 2^48 - 1 and {@link PlanTooLargeError} past the level cap, before anything is written.
 */
export function packChunkTree(
  chunkHashes: readonly string[],
  chunkSizes: readonly number[],
  opts: { path?: string } = {},
): PackedTree {
  const path = opts.path ?? "";
  if (chunkSizes.length !== chunkHashes.length) throw new Error("one size per chunk id");
  if (chunkHashes.length === 0) return emptyTree("chunks");
  assertTreeLevels(Math.ceil(chunkHashes.length / CHUNK_LEAF_MAX_HASHES_), "file", path, chunkHashes.length);
  const encoded = chunkHashes.map((h) => bytes32(h, "chunk hash"));
  const sizes = partitionChunkLeaves(chunkHashes.map(hashKey));

  const leaves: PackedNode[] = [];
  let at = 0;
  for (const n of sizes) {
    const blob = new Uint8Array(chunkLeafBlobSize(n));
    blob[0] = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const size = chunkSizes[at + i]!;
      if (!Number.isSafeInteger(size) || size < 1 || size > 2 ** 48 - 1) {
        throw new Error(`chunk ${at + i} has size ${size}; sizes are 1 to 2^48 - 1`);
      }
      blob.set(encoded[at + i]!, 1 + 38 * i);
      blob.set(u48(size), 33 + 38 * i);
      total += size;
    }
    // `FileStore._validateLeaf` refuses a leaf whose total passes `uint48`, and a parent's running bytes include it.
    if (total > MAX_NODE_BYTES_TOTAL) throw fileTooLarge(path, total);
    at += n;
    leaves.push({ id: nodeId(CHUNK_NODE_PREFIX, blob), blob, level: 0, count: n, size: total, childIds: [], estimatedGas: estimateChunkLeaf(n) });
  }
  const nodes = stackBranches(CHUNK_NODE_PREFIX, leaves, { kind: "file", path, size: chunkHashes.length });
  const root = nodes[nodes.length - 1]!;
  return { kind: "chunks", root: root.id, rootLevel: root.level, count: chunkHashes.length, nodes };
}

/**
 * Throw unless `name` is a legal entry name under the contract's rules (length 1..255 bytes, not `.` or `..`, no `/` or
 * `\`), and return its bytes. A string is a name's text form (`names.ts`), so a name read from chain that is not
 * UTF-8 passes as it was read; bytes are checked as they are.
 */
export function assertEntryName(name: string | Uint8Array): Uint8Array {
  const b = typeof name === "string" ? encodeEntryName(name) : name;
  const shown = typeof name === "string" ? name : decodeEntryName(name);
  if (b.length === 0 || b.length > MAX_ENTRY_NAME_BYTES) {
    throw new Error(`entry name "${shown.slice(0, 40)}" is ${b.length} bytes; names are 1 to ${MAX_ENTRY_NAME_BYTES} bytes`);
  }
  if (b[0] === 0x2e && (b.length === 1 || (b.length === 2 && b[1] === 0x2e))) throw new Error(`entry name "${shown}" is reserved`);
  for (const c of b) {
    if (c === 0x2f || c === 0x5c) throw new Error(`entry name "${shown.slice(0, 40)}" contains "/" or "\\"`);
  }
  return b;
}

/** Unsigned byte-lexicographic compare, shorter prefix first (the contract's `_compare`). */
export function compareNameBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Pack directory entries into an entry-node tree. Entries may be passed in any order: they are sorted in unsigned
 * byte order of their names' bytes (NOT UTF-16 order, which differs for astral characters): `nameBytes` when present,
 * else the text form encoded. No entries is the empty directory (root zero). Throws on an illegal or duplicate name and
 * {@link PlanTooLargeError} past the level cap.
 */
export function packEntryTree(
  entries: readonly DirectoryEntry[],
  opts: { path?: string; leafGasCap?: number } = {},
): PackedTree {
  if (entries.length === 0) return emptyTree("entries");
  const encoded = entries.map((e) => ({ e, nameBytes: assertEntryName(entryNameBytes(e)), cid: bytes32(e.cid, "entry cid") }));
  encoded.sort((a, b) => compareNameBytes(a.nameBytes, b.nameBytes));
  for (let i = 1; i < encoded.length; i++) {
    if (compareNameBytes(encoded[i - 1]!.nameBytes, encoded[i]!.nameBytes) === 0) {
      throw new Error(`duplicate entry name "${encoded[i]!.e.name.slice(0, 40)}"`);
    }
  }

  const cap = opts.leafGasCap ?? ENTRY_LEAF_GAS_CAP;
  const path = opts.path ?? "";
  const counts = partitionEntryLeaves(
    encoded.map((r) => ({ nameLength: r.nameBytes.length, key: nameKey(r.nameBytes) })),
    cap,
  );
  const groups: Array<typeof encoded> = [];
  let from = 0;
  for (const n of counts) {
    groups.push(encoded.slice(from, from + n));
    from += n;
  }
  assertTreeLevels(groups.length, "directory", path, entries.length);

  const edges = new Map<string, { first: number; last: number }>();
  const leaves: PackedNode[] = groups.map((g) => {
    const nb = g.reduce((n, r) => n + r.nameBytes.length, 0);
    const blob = new Uint8Array(entryLeafBlobSize(g.length, nb));
    blob[0] = 0;
    blob.set(u16(g.length), 1);
    let off = 0;
    let pos = 3 + 2 * g.length;
    g.forEach((r, i) => {
      blob.set(u16(off), 3 + 2 * i);
      blob[pos] = r.nameBytes.length;
      blob.set(r.nameBytes, pos + 1);
      blob[pos + 1 + r.nameBytes.length] = r.e.isDirectory ? 1 : 0;
      blob.set(r.cid, pos + 2 + r.nameBytes.length);
      const len = 1 + r.nameBytes.length + 1 + 32;
      pos += len;
      off += len;
    });
    const id = nodeId(ENTRY_NODE_PREFIX, blob);
    edges.set(id, { first: g[0]!.nameBytes.length, last: g[g.length - 1]!.nameBytes.length });
    return {
      id,
      blob,
      level: 0,
      count: g.length,
      size: 0,
      childIds: [],
      estimatedGas: estimateEntryLeaf(g.length, nb),
    };
  });
  const nodes = stackBranches(ENTRY_NODE_PREFIX, leaves, { kind: "directory", path, size: entries.length }, edges);
  const root = nodes[nodes.length - 1]!;
  return { kind: "entries", root: root.id, rootLevel: root.level, count: entries.length, nodes };
}

/**
 * A file CID, exactly as `FileStore.fileCid` computes it:
 * `keccak256(0x31 || rootNode || keccak256(mimeType) || codec || outputHash)`.
 * Throws on what `createFile` would revert: a mime of 0 or more than 127 bytes, a codec without an output hash or the
 * reverse, or a codec on the empty file (root zero).
 */
export function fileCid(root: Hex, mimeType: string, codec: FileCodec = ZERO_HASH, outputHash: Hex = ZERO_HASH): AbxfsCid {
  const mime = utf8.encode(mimeType);
  if (mime.length === 0 || mime.length > MAX_MIME_BYTES) throw new Error(`mime type must be 1 to ${MAX_MIME_BYTES} bytes`);
  const rootBytes = bytes32(root, "root");
  const codecBytes = bytes32(codec, "codec");
  const out = bytes32(outputHash, "outputHash");
  const noCodec = codecBytes.every((b) => b === 0);
  const noOutput = out.every((b) => b === 0);
  if (noCodec !== noOutput) throw new Error("a file codec and its outputHash are both zero or both set");
  if (!noCodec && rootBytes.every((b) => b === 0)) throw new Error("the empty file has no codec");
  return keccak256(
    concatBytes(new Uint8Array([FILE_CID_PREFIX]), rootBytes, fromHex(keccak256(mime)), codecBytes, out),
  ) as AbxfsCid;
}

/** A directory CID, exactly as `DirectoryStore.directoryCid` computes it: `keccak256(0x32 || rootNode)`. */
export function directoryCid(root: Hex): AbxfsCid {
  return keccak256(concatBytes(new Uint8Array([DIRECTORY_CID_PREFIX]), bytes32(root, "root"))) as AbxfsCid;
}

/** The empty directory (`DirectoryStore.EMPTY_DIRECTORY`): exists on chain without being created. */
export const EMPTY_DIRECTORY: AbxfsCid = directoryCid(ZERO_HASH);

/** A packed file: its tree and CID. */
export function packFile(args: {
  chunkIds: readonly string[];
  /** Each chunk's data size, in the same order. */
  chunkSizes: readonly number[];
  mimeType: string;
  codec?: FileCodec;
  outputHash?: Hex;
  path?: string;
}): { cid: AbxfsCid; tree: PackedTree } {
  const tree = packChunkTree(args.chunkIds, args.chunkSizes, args.path !== undefined ? { path: args.path } : {});
  return { cid: fileCid(tree.root, args.mimeType, args.codec ?? ZERO_HASH, args.outputHash ?? ZERO_HASH), tree };
}

/** A packed directory: its tree and CID. */
export function packDirectory(
  entries: readonly DirectoryEntry[],
  opts: { path?: string; leafGasCap?: number } = {},
): { cid: AbxfsCid; tree: PackedTree } {
  const tree = packEntryTree(entries, opts);
  return { cid: directoryCid(tree.root), tree };
}

/** `0x`-hex of a node blob, as `putChunkNode` / `putEntryNode` take it. */
export function nodeBlobHex(node: PackedNode): Hex {
  return toHex(node.blob);
}
