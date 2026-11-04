/**
 * Shared types for the ABX FS SDK.
 */
import type { Address, Hex } from "viem";

/**
 * Keccak256 ABX FS content identifier (32 bytes). Same shape as `bytes32` on-chain.
 *
 * Nominally-typed via a phantom brand so the TS compiler refuses to mix it with
 * {@link IpfsCid} (sha256-based, base32-encoded) — the two address spaces are
 * distinct and not implicitly convertible. Cast through {@link asAbxfsCid} if you
 * have a `Hex` from an untyped source (RPC response, CLI arg, etc.) after
 * validating its shape.
 */
export type AbxfsCid = Hex & { readonly __abxfsCidBrand: unique symbol };

/**
 * IPFS CIDv1 string, lowercase base32 ("bafk…" / "bafy…").
 *
 * Branded for the same reason as {@link AbxfsCid} — mixing an ABX FS keccak256 CID
 * with an IPFS sha256 CID is a common-enough bug that the type system should
 * catch it at compile time. Use {@link asIpfsCid} to tag a validated string.
 */
export type IpfsCid = string & { readonly __ipfsCidBrand: unique symbol };

/**
 * Assert that a 0x-prefixed hex string is an ABX FS CID (32 bytes / 64 hex chars).
 * Use at trust boundaries (RPC decode, CLI input) to produce a typed {@link AbxfsCid}.
 */
export function asAbxfsCid(value: Hex): AbxfsCid {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`not a valid ABX FS CID (expected 0x + 64 hex chars): ${String(value)}`);
  }
  return value.toLowerCase() as AbxfsCid;
}

/**
 * Assert that a string is an IPFS CIDv1 (base32, "bafk…" or "bafy…").
 * Does a shape check only — does not validate the multicodec or multihash.
 */
export function asIpfsCid(value: string): IpfsCid {
  if (typeof value !== "string" || !/^baf[a-z2-7]+$/i.test(value)) {
    throw new Error(`not a valid IPFS CIDv1 base32 string: ${String(value)}`);
  }
  return value as IpfsCid;
}

/**
 * A file-level codec label (`specs/abx-fs.md` §6): a `bytes32` holding a lowercase ASCII token, left-aligned and
 * zero-padded. Zero means no codec. By convention the token is an IANA HTTP content coding (`gzip`, `br`, `zstd`,
 * `deflate`). The chain enforces nothing about it beyond "zero iff `outputHash` is zero"; readers refuse a token they do
 * not know. On-chain decoding is not a file codec's job: that lives in storage backends (e.g. FastLZ).
 */
export type FileCodec = Hex;

/**
 * Where ABX FS lives on one chain. Content (chunks, files, directories) is permissionless and needs only the three
 * stores; the org layer is optional. The two backends are the SDK's recommended ones: content may use any backend, and
 * the backend's address is part of every chunk id it stores.
 */
export interface ContractAddresses {
  /** `ChunkStore`: chunk records over any storage backend. */
  chunkStore: Address;
  /** `FileStore`: files as trees of chunk nodes. */
  fileStore: Address;
  /** `DirectoryStore`: directories as trees of entry nodes. */
  directoryStore: Address;
  /** `Sstore2Backend`: bytes as contract code, returned unchanged. The SDK's backend for incompressible chunks. */
  sstore2Backend: Address;
  /** `FastLzSstore2Backend`: FastLZ-compressed bytes as contract code, inflated on chain on every read. */
  fastLzBackend: Address;
  /**
   * `OrgFactory`, the entry point for orgs on this chain. An org is its own ABX collection and its tokens are the
   * projects. Optional: content is fully usable without any project.
   */
  orgFactory?: Address;
  /** `OrgMinter`, the minter every org is deployed with. */
  orgMinter?: Address;
  /** `OrgMeta`: each org's collection document and each token's name. Informational. */
  orgMeta?: Address;
  /** `Lens`: one-call project resolution and the resolved cross-org publish feed. */
  lens?: Address;
  /** `ProjectHook`: root validation, kind lock, version history, tags, both publish ledgers. */
  projectHook?: Address;
  /** `ProjectEnumeration`: owner → tokens per org, and owner → orgs. */
  projectEnumeration?: Address;
  /**
   * Earlier factory generations on this chain, newest first.
   *
   * An org is frozen the moment it exists and its hooks are immutable, so a fixed bug can only ship
   * as a new factory. Orgs the old factory made keep working against the old factory's hook, forever.
   * Dropping an old generation from here would strand every URL under it, so a superseded factory is
   * moved to this list, never removed. Reads that start from an org address use
   * {@link generationOfOrg}; the top-level `orgFactory` / `projectHook` fields are the generation new
   * orgs are created in.
   */
  previousGenerations?: OrgGeneration[];
  /** `IpfsCidResolver`: view-only IPFS CIDv1 derivation from on-chain content. */
  ipfsCidResolver?: Address;
}

/** The org-layer contracts one factory deployed: what an org it created reads and writes through. */
export interface OrgGeneration {
  orgFactory: Address;
  projectHook: Address;
  /**
   * The store pair this generation's hook was constructed with, when it differs from the address book's. The hook asks
   * only `fileExists` / `directoryExists` of ITS pair, so a root is publishable into this generation's orgs only if it
   * lives in these stores.
   */
  fileStore?: Address;
  directoryStore?: Address;
  orgMinter?: Address;
  projectEnumeration?: Address;
  lens?: Address;
}

export interface FileDescriptor {
  /** Relative path (POSIX, forward slashes). e.g. "src/index.html" */
  path: string;
  /** Raw file bytes. Uncompressed. */
  bytes: Uint8Array;
  /** IANA MIME type. */
  mimeType: string;
}

export interface UploadedFile extends FileDescriptor {
  cid: AbxfsCid;
  /** The file-level codec label (zero for none). */
  codec: FileCodec;
  /** Chunk ids, in order. */
  chunkIds: AbxfsCid[];
  /** Total bytes handed to backends (after any file codec and per-chunk compression). */
  storedBytesLength: number;
  /** `keccak256` of the file's content when a codec is set; zero otherwise. */
  outputHash: AbxfsCid;
}

/**
 * What an ABX FS root CID resolves to. Mirrors `IProjectHook.ContentKind` exactly.
 *
 * `Unset` is 0 so "this project has never published" is representable and distinguishable from
 * "this project's root is a directory". The retired `IProjectStore.ContentKind` numbered
 * `Directory` as 0 and had no `Unset` member, so any value persisted under the old encoding decodes
 * a directory as unset — do not carry one across this boundary.
 */
export const ProjectKind = {
  Unset: 0,
  Directory: 1,
  File: 2,
} as const;
export type ProjectKind = (typeof ProjectKind)[keyof typeof ProjectKind];

/** Human-readable label for a {@link ProjectKind}, for logs and CLI output. */
export function projectKindName(kind: ProjectKind): "unset" | "directory" | "file" {
  return kind === ProjectKind.Directory ? "directory" : kind === ProjectKind.File ? "file" : "unset";
}

export interface DirectoryEntry {
  /**
   * The name's text form (`names.ts`): its UTF-8 text, a leading U+FEFF included, with `\xHH` for each byte that is not
   * UTF-8. Lossless, so it is safe to display, to key on and to build paths from; packing encodes it back exactly.
   */
  name: string;
  /** The name's exact bytes, set on every entry read from chain. When present, packing and IPFS derivation use it. */
  nameBytes?: Uint8Array;
  cid: AbxfsCid;
  isDirectory: boolean;
}

export interface Directory {
  cid: AbxfsCid;
  entries: DirectoryEntry[];
}

/** A file-level codec implementation (`compression.ts`). Encoding happens before chunking; decoding after joining. */
export interface FileCodecImpl {
  /** The `bytes32` label written into the file record. */
  label: FileCodec;
  /** The ASCII token ("gzip", "br", …). */
  name: string;
  encode(input: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Must throw (not return) once output would exceed `opts.maxOutputBytes`. */
  decode(input: Uint8Array, opts?: { maxOutputBytes?: number }): Uint8Array | Promise<Uint8Array>;
}
