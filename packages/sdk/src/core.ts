/**
 * `@abxfs/sdk/core` — everything about the ABX FS *format*, with no chain attached.
 *
 * Import this instead of the root entry point when you want to compute rather than transact. Nothing
 * here opens an RPC connection, reads a contract, or needs a wallet, so it runs in a browser, a
 * service worker, an edge function, or a CI job with no network access at all.
 *
 * What that makes possible without a node:
 *
 *   - Look up the canonical contract addresses for a chain, including the storage backends whose addresses every
 *     chunk id is computed against, which offline derivation needs.
 *   - Plan a whole upload — every chunk id and backend choice, every file and directory CID, the root, the stored
 *     size after dedup — with `planUploadOffline`. The uploader runs this same code, so the plan is not an estimate
 *     of the upload; it is the upload's own arithmetic.
 *   - Chunk content exactly as an uploader would (FastCDC, content-defined) and get back the same boundaries, so a
 *     client can see which chunks a chain already has before spending anything.
 *   - Derive an ABX FS CID for a file or a directory tree offline. Deterministic, so two implementations can be
 *     checked against each other.
 *   - Derive the **IPFS** CIDv1 for the same content, matching what `ipfs add -r --cid-version=1` produces and what
 *     the on-chain `IpfsCidResolver` returns.
 *   - Encode and decode file codecs, and FastLZ (pure TypeScript) as the FastLZ backend stores it.
 *
 * The one thing to understand before relying on any of it: **an ABX FS CID commits to how content is stored**, the
 * backend of every chunk and any file codec included. Store the same file differently and its CID changes, while its
 * IPFS CID does not (that one is computed over the content). Everything here takes backends and codecs explicitly for
 * exactly that reason: there is no ambient default to get wrong.
 *
 * Deliberately excluded: `readFile`, `upload*`, `publishVersion`, the project layer, the log walkers.
 * Those need a chain and live at the root export. Keeping the split honest is what lets this module
 * stay usable where a chain is not available.
 */

// ─── Types and CID branding ──────────────────────────────────────────────────
export {
  ProjectKind,
  asAbxfsCid,
  asIpfsCid,
  projectKindName,
  type AbxfsCid,
  type FileCodec,
  type FileCodecImpl,
  type ContractAddresses,
  type Directory,
  type DirectoryEntry,
  type FileDescriptor,
  type IpfsCid,
  type UploadedFile,
} from "./types.js";

// ─── Canonical deployment addresses ──────────────────────────────────────────
//
// Pure data, and load-bearing for offline work: a chunk id mixes the storage backend's ADDRESS into its
// preimage, so deriving an ABX FS CID without a chain still requires knowing which backend the content
// belongs to.
export * from "./canonical.js";

// ─── CID computation, ABX FS and IPFS ────────────────────────────────────────
export * from "./cid.js";

// ─── Entry names: exact bytes, and their lossless text form ─────────────────
export * from "./names.js";

// ─── Canonical node packing and CIDs (pure) ─────────────────────────────────
export * from "./nodes.js";
export * from "./node-gas.js";
export { contentStores, type ContentStores } from "./stores.js";

// ─── Upload planning ─────────────────────────────────────────────────────────
//
// The entire write pipeline — codec, chunking, hashing, directory folding — with no chain. This is
// what lets a client compute exactly what an upload will produce and cost before a wallet is
// involved, and it is the same code path the real uploader runs, not a parallel estimate.
export * from "./plan.js";

// ─── Content-defined chunking ────────────────────────────────────────────────
//
// The chunker is the part most worth reusing: identical content produces identical boundaries, which
// is what makes an incremental update cost only the chunks that actually changed.
export * from "./chunking/index.js";

// ─── Compression ─────────────────────────────────────────────────────────────
//
// File codecs (off chain): `autoRegisterNodeCodecs` adds gzip, br, deflate and zstd on Node. FastLZ is pure
// TypeScript and always available: the planner uses it per chunk with the FastLZ storage backend, which the
// chain inflates itself.
export * from "./compression.js";
export * from "./fastlz.js";

// ─── Validation and naming ───────────────────────────────────────────────────
export * from "./validate.js";
export * from "./semver.js";

// ─── Gas estimation (pure arithmetic, no chain) ──────────────────────────────
export * from "./gas.js";

// ─── Byte helpers ────────────────────────────────────────────────────────────
export * from "./util.js";
