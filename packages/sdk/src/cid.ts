/**
 * ABX FS ids (keccak256) and IPFS CIDv1 computation (sha2-256 + dag-pb / raw).
 *
 * Matches byte-for-byte:
 *   - `ChunkStore.chunkId` (below)
 *   - `FileStore.fileCid` / `DirectoryStore.directoryCid` (`nodes.ts`)
 *   - `IpfsCidResolver` and the IPFS profile (companion spec §4.1): CIDv1, sha2-256, raw(0x55) single-block,
 *     dag-pb(0x70) directories, 256 KiB chunks, balanced DAG, raw leaves, 174 links max, byte-lexicographic order.
 */
import { keccak256, sha256, type Address } from "viem";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 as mhSha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";
import { UnixFS } from "ipfs-unixfs";

import type { AbxfsCid, IpfsCid, DirectoryEntry } from "./types.js";
import { entryNameBytes } from "./names.js";
import { fromHex, concatBytes } from "./util.js";

const sha2 = (b: Uint8Array): Uint8Array => fromHex(sha256(b));

export const IPFS_CHUNK_SIZE = 262_144; // 256 KiB
export const IPFS_MAX_LINKS = 174;

/** The zero `bytes32`: no codec, no output hash, the empty root. */
export const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as AbxfsCid;

/** Lowercase-hex bytes32 for a given Uint8Array (pre-prefixed with 0x). */
export function keccak256Hex(bytes: Uint8Array): AbxfsCid {
  return keccak256(bytes) as AbxfsCid;
}

/** The chunk-id domain prefix (`ChunkStore._CHUNK_PREFIX`). */
export const CHUNK_ID_PREFIX = 0x30;
/** Largest chunk size a record can hold: 6 bytes. */
export const MAX_CHUNK_DATA_SIZE = 2 ** 48 - 1;

/**
 * A chunk's id, exactly as `ChunkStore.chunkId` computes it:
 *
 *     keccak256(0x30 ‖ backend:20 ‖ inputHash:32 ‖ dataHash:32 ‖ size:6)
 *
 * `inputHash` is `keccak256` of the bytes handed to the backend; `dataHash` and `size` describe the chunk's DATA (what
 * the backend's `retrieve` returns, after any decoding it performs, e.g. FastLZ inflation). The backend's address is
 * part of the id, so the same data through two backends are two different chunks, and a false claim can only ever name
 * an id no honest writer computes.
 */
export function chunkId(backend: Address, inputHash: string, dataHash: string, size: number): AbxfsCid {
  const b = fromHex(backend);
  if (b.length !== 20) throw new Error(`chunkId: expected a 20-byte backend address, got ${b.length} bytes`);
  const ih = fromHex(inputHash);
  const dh = fromHex(dataHash);
  if (ih.length !== 32 || dh.length !== 32) throw new Error("chunkId: inputHash and dataHash must be 32 bytes");
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CHUNK_DATA_SIZE) {
    throw new Error(`chunkId: size ${size} is outside 1 to 2^48 - 1`);
  }
  const s = new Uint8Array(6);
  let v = size;
  for (let i = 5; i >= 0; i--) {
    s[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return keccak256(concatBytes(new Uint8Array([CHUNK_ID_PREFIX]), b, ih, dh, s)) as AbxfsCid;
}

/** Sort directory entries in lexicographic order of their name BYTES (`nameBytes`, else the text form encoded). */
export function sortDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => {
    const aa = entryNameBytes(a);
    const bb = entryNameBytes(b);
    const n = Math.min(aa.length, bb.length);
    for (let i = 0; i < n; i++) {
      const av = aa[i]!;
      const bv = bb[i]!;
      if (av !== bv) return av - bv;
    }
    return aa.length - bb.length;
  });
}

// ────────────────────────── IPFS CIDv1 computation ──────────────────────────

/**
 * Compute the IPFS CIDv1 string for raw bytes ≤ 256KB (single-block file).
 * codec = raw (0x55), hash = sha2-256.
 */
export async function ipfsRawCid(bytes: Uint8Array): Promise<IpfsCid> {
  const hash = await mhSha256.digest(bytes);
  return CID.createV1(raw.code, hash).toString() as IpfsCid;
}

/**
 * Compute the IPFS CIDv1 for a file of arbitrary size using the ABX FS profile.
 * For bytes ≤ 256KB this produces a raw CIDv1; larger files produce a single-level dag-pb DAG
 * with up to 174 raw leaves (matches the Solidity resolver). Deeper DAGs use recursive balanced
 * layout (bottom-up).
 */
export async function ipfsFileCid(bytes: Uint8Array): Promise<IpfsCid> {
  return (await ipfsFileCidWithSize(bytes)).cid;
}

/**
 * Same as {@link ipfsFileCid} but also returns the {@link IpfsFileResult.tsize} a parent
 * directory should set on its `Tsize` field when linking to this file. Computing tsize at
 * file-derivation time avoids re-walking the DAG, and (more importantly) gives callers the
 * *correct* cumulative size for chunked files — see the `tsize` doc on {@link IpfsFileResult}.
 */
export async function ipfsFileCidWithSize(bytes: Uint8Array, opts: IpfsDeriveOptions = {}): Promise<IpfsFileResult> {
  if (bytes.length <= IPFS_CHUNK_SIZE) {
    const cid = CID.createV1(raw.code, await mhSha256.digest(bytes));
    opts.onBlock?.({ cid: cid.toString() as IpfsCid, cidBytes: cid.bytes, bytes });
    return { cid: cid.toString() as IpfsCid, tsize: bytes.length };
  }
  const root = await ipfsFileRoot(bytes, opts.onBlock);
  return { cid: root.cid.toString() as IpfsCid, tsize: root.cumulativeSize };
}

/** One block of a derived IPFS DAG: what a CAR file carries for it. */
export interface IpfsBlock {
  cid: IpfsCid;
  /** The binary CID (what a CAR section and a dag-pb link hold). */
  cidBytes: Uint8Array;
  bytes: Uint8Array;
}

export interface IpfsDeriveOptions {
  /**
   * Receives every block the derivation hashes (raw leaves, dag-pb file and directory nodes), so a caller can hand
   * IPFS exactly the DAG whose root it computed instead of asking a node to rebuild it.
   */
  onBlock?: (block: IpfsBlock) => void;
}

export interface IpfsFileResult {
  cid: IpfsCid;
  /**
   * The value a parent directory MUST place in its dag-pb `PBLink.Tsize` when linking to
   * this file. Per the dag-pb spec, Tsize is the cumulative serialised size of the linked
   * subtree (target node + all descendant blocks). For a raw leaf (≤ 256 KB file) that's
   * just `bytes.length`; for a chunked dag-pb file it's the dag-pb root's encoded size plus
   * every descendant block. Using the wrong Tsize changes the encoded bytes of the parent
   * and therefore changes the parent's CID — i.e. the pinner sees a verification mismatch
   * and the gateway reports "no IPFS mapping". See `pinner.ts` for the directory analogue.
   */
  tsize: number;
}

interface DagNode {
  cid: CID;
  /** Cumulative uncompressed bytes under this node (i.e. the file's payload). */
  totalSize: number;
  /** Bytes the serialised block of *this* node occupies (excludes descendants). */
  serializedSize: number;
  /**
   * Cumulative serialised size of this node's subtree (self + every descendant block).
   * This is the value a parent's `PBLink.Tsize` must contain when linking to this node;
   * it is *not* the same as `serializedSize` for any node that has dag-pb children.
   */
  cumulativeSize: number;
}

/**
 * Build the full balanced dag-pb DAG for a file > 256KB and return the root's CID and sizes. Blocks go to `onBlock`
 * when one is given and are not otherwise retained.
 */
async function ipfsFileRoot(bytes: Uint8Array, onBlock?: IpfsDeriveOptions["onBlock"]): Promise<DagNode> {
  const leaves: DagNode[] = [];
  for (let off = 0; off < bytes.length; off += IPFS_CHUNK_SIZE) {
    const chunk = bytes.subarray(off, Math.min(off + IPFS_CHUNK_SIZE, bytes.length));
    const mh = await mhSha256.digest(chunk);
    const cid = CID.createV1(raw.code, mh);
    onBlock?.({ cid: cid.toString() as IpfsCid, cidBytes: cid.bytes, bytes: chunk });
    leaves.push({
      cid,
      totalSize: chunk.length,
      serializedSize: chunk.length,
      // Raw leaves have no descendants, so cumulative == self == raw bytes.
      cumulativeSize: chunk.length,
    });
  }

  let layer = leaves;
  while (layer.length > 1) {
    const next: DagNode[] = [];
    for (let i = 0; i < layer.length; i += IPFS_MAX_LINKS) {
      const group = layer.slice(i, i + IPFS_MAX_LINKS);
      next.push(await wrapGroup(group, onBlock));
    }
    layer = next;
  }
  return layer[0]!;
}

async function wrapGroup(children: DagNode[], onBlock?: IpfsDeriveOptions["onBlock"]): Promise<DagNode> {
  const filesize = children.reduce((acc, c) => acc + c.totalSize, 0);
  const Data = marshalUnixFSFile(filesize, children.map((c) => c.totalSize));
  const Links = children.map((c) => ({
    Name: "",
    Hash: c.cid,
    // dag-pb spec: Tsize MUST be the cumulative serialised size of the linked subtree,
    // not the immediate child's block size. For raw leaves these happen to coincide
    // (cumulative == bytes.length), but for inner dag-pb wraps in a multi-level file
    // they differ; using the wrong value produces CIDs that don't match Kubo.
    Tsize: c.cumulativeSize,
  }));
  const node = dagPB.prepare({ Data, Links });
  const encoded = dagPB.encode(node);
  const mh = await mhSha256.digest(encoded);
  const cid = CID.createV1(dagPB.code, mh);
  onBlock?.({ cid: cid.toString() as IpfsCid, cidBytes: cid.bytes, bytes: encoded });
  const childrenCumulative = children.reduce((acc, c) => acc + c.cumulativeSize, 0);
  return {
    cid,
    totalSize: filesize,
    serializedSize: encoded.length,
    cumulativeSize: encoded.length + childrenCumulative,
  };
}

function marshalUnixFSFile(filesize: number, blocksizes: number[]): Uint8Array {
  // UnixFS Data: Type(1)=File(2), filesize(3), blocksizes(4 repeated).
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([0x08])); // tag 1, varint
  parts.push(varint(2n));
  parts.push(new Uint8Array([0x18])); // tag 3, varint
  parts.push(varint(BigInt(filesize)));
  for (const bs of blocksizes) {
    parts.push(new Uint8Array([0x20])); // tag 4, varint
    parts.push(varint(BigInt(bs)));
  }
  return concatBytes(...parts);
}

function varint(n: bigint): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v >= 128n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

// ────────────────────────── Directory sharding (HAMT) ──────────────────────────

/**
 * Where IPFS stops writing a directory as one flat dag-pb block and shards it (HAMT): Kubo (boxo's
 * `HAMTShardingSize`, 256 KiB) and `ipfs-unixfs-importer` (`shardSplitThresholdBytes`, 262,144) agree. Compared
 * strictly (`>`), as boxo 0.37 / Kubo 0.40 and the importer do; older Kubo sharded at `>=`.
 */
export const IPFS_SHARD_THRESHOLD_BYTES = 262_144;

/** Bytes of a CIDv1 with a sha2-256 multihash (version, codec, hash code, length, 32-byte digest): every CID derived here. */
export const IPFS_CID_V1_BYTES = 36;

/**
 * The size Kubo estimates for a flat directory block, the number it compares with {@link IPFS_SHARD_THRESHOLD_BYTES}:
 * the sum over EVERY entry, subdirectories included, of the name's byte length and the child CID's byte length (boxo's
 * `SizeEstimationLinks`, the default). Not the encoded size: framing and Tsize are not counted. `ipfs-unixfs-importer`
 * sums the same but leaves out subdirectories that have no CID yet while it builds, so it shards later, never sooner:
 * following Kubo keeps every flat CID derived here equal to both. Each entry gives its name bytes (or text form) and,
 * optionally, its CID's byte length (default {@link IPFS_CID_V1_BYTES}, every CID derived here).
 */
export function ipfsDirectoryEstimate(
  entries: Iterable<{ name: string; nameBytes?: Uint8Array; cidBytes?: number }>,
): number {
  let n = 0;
  for (const e of entries) n += entryNameBytes(e).length + (e.cidBytes ?? IPFS_CID_V1_BYTES);
  return n;
}

/**
 * True when IPFS would shard this directory, so its flat dag-pb CID is not the one `ipfs add -r` produces: the estimate
 * ({@link ipfsDirectoryEstimate}) is STRICTLY greater than {@link IPFS_SHARD_THRESHOLD_BYTES}, as both boxo and the
 * importer compare it. ABX FS does not derive the sharded form, so such a directory has no IPFS CID here.
 */
export function ipfsDirectoryNeedsSharding(
  entries: Iterable<{ name: string; nameBytes?: Uint8Array; cidBytes?: number }>,
): boolean {
  return ipfsDirectoryEstimate(entries) > IPFS_SHARD_THRESHOLD_BYTES;
}

/**
 * A directory IPFS would shard (see {@link ipfsDirectoryNeedsSharding}): ABX FS derives flat directories only, so no
 * correct IPFS CID exists for it here. Not a fault in the content; it has an ABX FS CID like any other.
 */
export class DirectoryNeedsShardingError extends Error {
  constructor(
    /** The ABX FS directory, when known. */
    readonly cid: string,
    /** {@link ipfsDirectoryEstimate} of its links. */
    readonly estimate: number,
  ) {
    super(
      `directory ${cid} needs sharding: its IPFS size estimate is ${estimate} bytes, over the ${IPFS_SHARD_THRESHOLD_BYTES} at which IPFS ` +
        "shards a directory (HAMT). Sharded directories are not supported, so it has no IPFS CID here. Split it into subdirectories.",
    );
    this.name = "DirectoryNeedsShardingError";
  }
}

/**
 * Compute the IPFS CIDv1 for a directory (dag-pb). Links are written in order of their name bytes, whatever the order
 * of `entries`.
 *
 * A name is its exact bytes: `nameBytes` when given (what a read from chain carries), else the text form encoded
 * (`names.ts`). The block is encoded here rather than by `@ipld/dag-pb`, whose `Name` is a JS string that it UTF-8
 * encodes: a name that is not UTF-8 would lose bytes there. For UTF-8 names the two encodings are byte-identical (a
 * test pins it). Throws {@link DirectoryNeedsShardingError} for a directory IPFS would shard.
 *
 * Each `entries[i].tsize` MUST be the *cumulative* serialised size of the linked subtree
 * (target node + every descendant block), per the dag-pb spec — not just the child's own
 * block size. For a file, use {@link ipfsFileCidWithSize}.tsize. For a sub-directory,
 * recurse and sum the sub-directory's encoded length plus all of its child Tsizes, as
 * `verifyLocalIpfsCid` and `@abxfs/pinning` do for on-chain trees. Any other value (0, say)
 * produces CIDs that do NOT match Kubo for a nested directory.
 */
export async function ipfsDirectoryCid(
  entries: Array<{ name: string; nameBytes?: Uint8Array; cid: IpfsCid; tsize: number }>,
  opts: IpfsDeriveOptions & { directoryCid?: string } = {},
): Promise<{ cid: IpfsCid; encoded: Uint8Array }> {
  const links = entries.map((e) => ({ name: entryNameBytes(e), hash: CID.parse(e.cid).bytes, tsize: e.tsize }));
  const estimate = ipfsDirectoryEstimate(links.map((l) => ({ name: "", nameBytes: l.name, cidBytes: l.hash.length })));
  if (estimate > IPFS_SHARD_THRESHOLD_BYTES) throw new DirectoryNeedsShardingError(opts.directoryCid ?? "(derived)", estimate);
  // UnixFS orders links by name bytes (as `dagPB.prepare` sorts them); one name twice is not a directory.
  links.sort((a, b) => compareBytes(a.name, b.name));
  for (let i = 1; i < links.length; i++) {
    if (compareBytes(links[i - 1]!.name, links[i]!.name) === 0) throw new Error("ipfsDirectoryCid: two entries have the same name");
  }
  const encoded = encodeDagPbNode(links, new UnixFS({ type: "directory" }).marshal());
  const mh = await mhSha256.digest(encoded);
  const cid = CID.createV1(dagPB.code, mh);
  opts.onBlock?.({ cid: cid.toString() as IpfsCid, cidBytes: cid.bytes, bytes: encoded });
  return { cid: cid.toString() as IpfsCid, encoded };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * A dag-pb node in the form `@ipld/dag-pb` writes (links first, each Hash, Name, Tsize; then Data), with each link's
 * name given as bytes.
 */
function encodeDagPbNode(links: ReadonlyArray<{ name: Uint8Array; hash: Uint8Array; tsize: number }>, data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const l of links) {
    if (!Number.isSafeInteger(l.tsize) || l.tsize < 0) throw new Error(`Tsize ${l.tsize} cannot be encoded`);
    const body = concatBytes(
      new Uint8Array([0x0a]), varint(BigInt(l.hash.length)), l.hash,
      new Uint8Array([0x12]), varint(BigInt(l.name.length)), l.name,
      new Uint8Array([0x18]), varint(BigInt(l.tsize)),
    );
    parts.push(new Uint8Array([0x12]), varint(BigInt(body.length)), body);
  }
  parts.push(new Uint8Array([0x0a]), varint(BigInt(data.length)), data);
  return concatBytes(...parts);
}

/** The sha2-256 digest of `bytes` as a 0x-prefixed hex string. */
export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes);
}

export { keccak256, sha256 };
export { sha2 as sha2Bytes };
