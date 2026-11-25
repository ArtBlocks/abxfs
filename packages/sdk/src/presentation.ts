/** Optional native reading and generation-specific project presentation. */
import { hexToBytes, decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { contentReaderAbi, fileDataReaderAbi } from "./abi-reader.js";
import { iProjectPresentationAbi } from "./abi-presentation.js";
import { asAbxfsCid, ProjectKind, type AbxfsCid, type ContractAddresses, type FileCodec } from "./types.js";
import { ZERO_HASH } from "./cid.js";
import { assertWalletChain } from "./wallet-chain.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { isRevertFailure, isTransportFailure } from "./multicall.js";
import { snapshotBlock, pinnedReadPolicy } from "./snapshot.js";
import { cidKind } from "./kind.js";
import { directoryEntryCount, getFileInfo, lookupEntry, readFile, resolvePath } from "./read.js";
import { viewUrlRefusedCharacter } from "./project.js";

export enum PresentationMethod { ChainGateway, Embedded, Ipfs }
export enum PresentationSelection { Latest, Version, Tag }
export enum PresentationStatus { Ready, Unpublished, InvalidTarget, UnsupportedMime, ReadFailed, IpfsFailed, UnsupportedCodec, OverBudget }
export const PresentationLock = { Content: 1, Method: 2, Endpoints: 4 } as const;
/** Historical v1 renderer limits, not limits of presentationVersion 2. */
export const MAX_EMBED_BYTES = 8_192;
export const MAX_EMBED_CHUNKS = 32;
/** Auto is an off-chain recommendation policy, independent of explicit Embedded. */
export const DEFAULT_AUTO_MAX_BYTES = 100 * 1024;
export interface PresentationAutoPolicy { maxBytes?: number; maxChunks?: number; maxCalls?: number }
export interface PresentationDiagnostic { code: string; message: string; technical: boolean }
export interface PresentationReadReach {
  inspection: "local" | "onchain" | "unresolved";
  bytes?: number;
  chunks?: number;
  nativeReadable: boolean | null;
  tokenUri: "not-measured";
}
export const EMBED_MIMES = new Set(["text/html", "image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm"]);
export async function presentationVersion(client: PublicClient, addresses: ContractAddresses): Promise<number> {
  if (!addresses.projectPresentation) return 0;
  try {
    const version = Number(await client.readContract({ address: addresses.projectPresentation,
      abi: [{ type: "function", name: "presentationVersion", stateMutability: "pure", inputs: [], outputs: [{ type: "uint256" }] }] as const,
      functionName: "presentationVersion" }));
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("invalid presentationVersion response");
    return version;
  } catch (error) {
    // An absent getter reverts on v1. Transport failures and malformed answers are not capabilities.
    if (isRevertFailure(error)) return 1;
    throw error;
  }
}
export interface PresentationConfig {
  selection: PresentationSelection;
  method: PresentationMethod;
  locks: number;
  /** v2 setter/lock intent: target=1, method=2, endpoints=4, including explicit defaults. */
  configuredFlags?: number;
  version: number;
  frozenRoot: Hex;
  tag: string;
  path: string;
  chainBase: string;
  ipfsBase: string;
}
export type PresentationTarget =
  | { selection: PresentationSelection.Latest; path?: string }
  | { selection: PresentationSelection.Version; version: number; path?: string }
  | { selection: PresentationSelection.Tag; tag: string; path?: string };
export interface PresentationRecommendation {
  method: PresentationMethod.Embedded | PresentationMethod.ChainGateway;
  reason: string;
  residualDependencies: string[];
  /** Static analysis never proves the behavior of arbitrary executable code. */
  runtimeUncertain: boolean;
  diagnostics?: PresentationDiagnostic[];
  readReach?: PresentationReadReach;
}
/** A capability an address book may lack: a generation's presentation contract, or a native reader companion. */
export type NativeCapability = "projectPresentation" | "contentReader" | "fileDataReader";
export class PresentationCapabilityError extends Error {
  constructor(readonly capability: NativeCapability, readonly factory?: Address) {
    super(capability === "projectPresentation"
      ? `org generation ${factory ?? "(unconfigured)"} does not support project presentation; it cannot inherit a newer generation's contract`
      : `this chain has no native ${capability} configured`);
    this.name = "PresentationCapabilityError";
  }
}
function requireCapability(addresses: ContractAddresses, capability: NativeCapability): Address {
  const address = addresses[capability];
  if (!address) throw new PresentationCapabilityError(capability, addresses.orgFactory);
  return address;
}
export async function readPresentation(client: PublicClient, addresses: ContractAddresses, org: Address, tokenId: bigint, blockNumber?: bigint): Promise<PresentationConfig> {
  const version = await presentationVersion(client, addresses);
  const abi = version === 1 ? iProjectPresentationAbi.filter(entry => entry.type === "function" && entry.name === "config").map(entry => ({
    ...entry, outputs: [{ type: "tuple", components: (entry as { outputs: readonly { components: readonly { name: string }[] }[] }).outputs[0]!.components.filter(component => component.name !== "configuredFlags") }],
  })) as unknown as Abi : iProjectPresentationAbi;
  return await client.readContract({ address: requireCapability(addresses, "projectPresentation"), abi, functionName: "config", args: [org, tokenId], blockNumber }) as PresentationConfig;
}
/** Exact selected root and path, including frozen content. A missing target remains explicit. */
export async function inspectPresentation(client: PublicClient, addresses: ContractAddresses, org: Address, tokenId: bigint, blockNumber?: bigint) {
  const address = requireCapability(addresses, "projectPresentation");
  blockNumber ??= await snapshotBlock(client, { fresh: true });
  const config = await readPresentation(client, addresses, org, tokenId, blockNumber);
  try {
    const [root, path] = await client.readContract({ address, abi: iProjectPresentationAbi, functionName: "target", args: [org, tokenId], blockNumber });
    return { ...config, root: asAbxfsCid(root), path, targetError: null };
  } catch (error) {
    return { ...config, root: null, targetError: error instanceof Error ? error.message : String(error) };
  }
}
export async function previewPresentation(client: PublicClient, addresses: ContractAddresses, org: Address, tokenId: bigint) {
  requireCapability(addresses, "projectPresentation");
  const blockNumber = await snapshotBlock(client, { fresh: true });
  const inspected = await inspectPresentation(client, addresses, org, tokenId, blockNumber);
  const [status, contentType, data] = await client.readContract({ address: requireCapability(addresses, "projectPresentation"), abi: iProjectPresentationAbi, functionName: "preview", args: [org, tokenId], blockNumber });
  const analysis = inspected.root ? await recommendPresentationMethod(client, addresses, inspected.root, inspected.path) : null;
  return { ...inspected, blockNumber, status: status as PresentationStatus, contentType, bytes: hexToBytes(data), residualDependencies: analysis?.residualDependencies ?? [], runtimeUncertain: analysis?.runtimeUncertain ?? true, recommendation: analysis };
}
export type PresentationClients = { publicClient: PublicClient; walletClient: WalletClient };
async function write(clients: PresentationClients, addresses: ContractAddresses, functionName: "setTarget" | "setMethod" | "setEndpoints" | "lock", args: readonly unknown[]): Promise<Hex> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  const address = requireCapability(addresses, "projectPresentation");
  const account = clients.walletClient.account;
  if (!account) throw new Error("walletClient has no account");
  const hash = await clients.walletClient.writeContract({ address, abi: iProjectPresentationAbi, functionName, args, account, chain: clients.walletClient.chain } as Parameters<WalletClient["writeContract"]>[0]);
  await waitForSuccessfulReceipt(clients.publicClient, hash, functionName);
  return hash;
}
export function configurePresentationTarget(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, target: PresentationTarget): Promise<Hex> {
  return write(clients, addresses, "setTarget", [org, tokenId, target.selection, target.selection === PresentationSelection.Version ? target.version : 0, target.selection === PresentationSelection.Tag ? target.tag : "", target.path ?? ""]);
}
export async function setPresentationMethod(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, method: PresentationMethod | "auto"): Promise<Hex> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  let concrete: PresentationMethod = method === "auto" ? PresentationMethod.ChainGateway : method;
  if (method === "auto") {
    const target = await inspectPresentation(clients.publicClient, addresses, org, tokenId);
    if (!target.root) throw new Error(`cannot choose presentation for an unresolved target: ${target.targetError}`);
    concrete = (await recommendPresentationMethod(clients.publicClient, addresses, target.root, target.path)).method;
  }
  return write(clients, addresses, "setMethod", [org, tokenId, concrete]);
}
/** Beside every character `ProjectLinks` refuses, `setEndpoints` refuses these after `https://`. */
const ENDPOINT_REFUSED = "?#";
function describeCharacter(c: string): string {
  const code = `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  return c > " " && c < "\x7f" ? `'${c}' (${code})` : code;
}
/**
 * Why `endpoint` must not be saved as a presentation `chainBase` or `ipfsBase`, or `null` when it may. Empty selects
 * the default. This is everything `setEndpoints` checks: `https://` and a host, at most 512 bytes, no trailing slash,
 * visible ASCII without `" ' < > \ ? #` or the backtick, and for an IPFS base a bare host name (dot-separated labels of
 * letters, digits and inner hyphens) of at most 196 bytes. A chain base reaches `animation_url` verbatim, and the
 * contract accepts `& ( ) [ ] ^ { | }` in it; they end a Markdown link or a CSS `url()`, or are not URI characters at
 * all, so they are refused here as `ProjectLinks` refuses them (see {@link viewUrlRefusedCharacter}). So is an empty
 * host (`https:///…`), as the deployment check refuses one in the default gateway base.
 */
export function presentationEndpointProblem(endpoint: string, kind: "chainBase" | "ipfsBase"): string | null {
  if (endpoint === "") return null;
  if (!endpoint.startsWith("https://")) return "must start with https://";
  for (const c of endpoint) {
    if (ENDPOINT_REFUSED.includes(c) || viewUrlRefusedCharacter(c) !== null) return `must not contain ${describeCharacter(c)}`;
  }
  // Every character is ASCII from here, so the length is the byte length the contract measures.
  const max = kind === "ipfsBase" ? 196 : 512;
  if (endpoint.length > max) return `must be at most ${max} bytes`;
  const host = endpoint.slice("https://".length);
  if (host === "" || host.startsWith("/")) return "must name a host after https://";
  if (endpoint.endsWith("/")) return "must not end with '/'";
  if (kind === "ipfsBase") {
    const bad = [...host].find(c => !/[A-Za-z0-9.-]/.test(c));
    if (bad) return `must be a bare host name (letters, digits, '-' and '.', no port, path or user), not ${describeCharacter(bad)}`;
    if (host.split(".").some(label => label === "" || label.startsWith("-") || label.endsWith("-")))
      return "must be a host name whose dot-separated labels are not empty and do not start or end with '-'";
  }
  return null;
}
/** Throws, before sending anything, for an endpoint {@link presentationEndpointProblem} refuses. */
export async function setPresentationEndpoints(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, endpoints: { chainBase: string; ipfsBase: string }): Promise<Hex> {
  for (const kind of ["chainBase", "ipfsBase"] as const) {
    const problem = presentationEndpointProblem(endpoints[kind], kind);
    if (problem) throw new Error(`refusing to set presentation endpoints: ${kind} ${problem}`);
  }
  return write(clients, addresses, "setEndpoints", [org, tokenId, endpoints.chainBase, endpoints.ipfsBase]);
}
/** Read at the same block as the preview the owner reviewed; never refresh inside a write. */
export async function readPresentationLockCommitment(client: PublicClient, addresses: ContractAddresses, org: Address, tokenId: bigint, mask: number, blockNumber?: bigint): Promise<Hex> {
  assertLockMask(mask);
  return client.readContract({ address: requireCapability(addresses, "projectPresentation"), abi: iProjectPresentationAbi, functionName: "lockCommitment", args: [org, tokenId, mask], blockNumber });
}
function assertLockMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 1 || mask > 7) throw new Error("presentation lock mask must be 1..7");
}
/** The part of a reviewed {@link previewPresentation} result a lock is judged by. */
export interface PresentationLockReview { locks: number; status: PresentationStatus }
/**
 * Why locking `mask` over the reviewed preview must be refused, or `null`. Judged from that preview alone, never a
 * fresh read. Once content and method are both locked nothing an owner can change alters what `render` reads, so a
 * reviewed ReadFailed or IpfsFailed status (for which `render` reverts `RenderFailed`, failing the token's whole
 * `tokenURI`) would fail for every later owner. A neutral status, such as Unpublished or UnsupportedMime, renders an
 * empty animation instead, and is the caller's to confirm.
 */
export function presentationLockProblem(reviewed: PresentationLockReview, mask: number): string | null {
  const frozen = PresentationLock.Content | PresentationLock.Method;
  if (((reviewed.locks | mask) & frozen) !== frozen) return null;
  if (reviewed.status !== PresentationStatus.ReadFailed && reviewed.status !== PresentationStatus.IpfsFailed) return null;
  return `the reviewed presentation is ${PresentationStatus[reviewed.status]}, so render reverts and the token's tokenURI fails, ` +
    "and with content and method both locked no owner could ever change that; choose a target or method that previews Ready first";
}
/**
 * The caller must supply the commitment from the reviewed snapshot, for every lock mask, and that snapshot's preview as
 * `reviewed`, which refuses before sending a lock that would freeze a failing render ({@link presentationLockProblem}).
 */
export async function lockPresentation(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, mask: number, expectedCommitment: Hex, reviewed: PresentationLockReview): Promise<Hex> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  assertLockMask(mask);
  if (!expectedCommitment || !/^0x[0-9a-fA-F]{64}$/.test(expectedCommitment) || expectedCommitment === ZERO_HASH)
    throw new Error("presentation lock requires a nonzero expectedCommitment from the reviewed snapshot");
  if (!reviewed) throw new Error("presentation lock requires the reviewed preview (previewPresentation at the commitment's block)");
  const problem = presentationLockProblem(reviewed, mask);
  if (problem) throw new Error(`refusing to lock presentation: ${problem}`);
  return write(clients, addresses, "lock", [org, tokenId, mask, expectedCommitment]);
}
export interface NativeReadLimits { maxBytes: bigint; maxChunks: bigint }
export async function readNativeFile(client: PublicClient, addresses: ContractAddresses, cid: AbxfsCid, limits: NativeReadLimits) {
  const [mimeType, data] = await client.readContract({ address: requireCapability(addresses, "contentReader"), abi: contentReaderAbi, functionName: "readFile", args: [cid, limits.maxBytes, limits.maxChunks] });
  return { mimeType, bytes: hexToBytes(data) };
}
export async function readNativePath(client: PublicClient, addresses: ContractAddresses, root: AbxfsCid, path: string, limits: NativeReadLimits) {
  const [mimeType, data] = await client.readContract({ address: requireCapability(addresses, "contentReader"), abi: contentReaderAbi, functionName: "readPath", args: [root, path, limits.maxBytes, limits.maxChunks] });
  return { mimeType, bytes: hexToBytes(data) };
}
/** maxBytes includes entire decoded boundary chunks, not only returned bytes. */
export async function readNativeFileRange(client: PublicClient, addresses: ContractAddresses, cid: AbxfsCid, start: bigint, length: bigint, limits: NativeReadLimits) {
  const [mimeType, data] = await client.readContract({ address: requireCapability(addresses, "contentReader"), abi: contentReaderAbi, functionName: "readFileRange", args: [cid, start, length, limits.maxBytes, limits.maxChunks] });
  return { mimeType, bytes: hexToBytes(data) };
}
/** A file's stored data as `FileDataReader` returns it: labelled with its codec and `outputHash`, never decoded. */
export interface NativeFileData {
  mimeType: string;
  /** The file codec label, zero for none. */
  codec: FileCodec;
  /** `keccak256(content)` when a codec is set, zero otherwise. */
  outputHash: AbxfsCid;
  /** The chunks' data joined: the content itself when `codec` is zero, otherwise its encoding. */
  data: Uint8Array;
}
/**
 * A file's stored data in one `eth_call` to `FileDataReader`, for any codec (`readNativeFile` refuses codec files).
 * This is what a contract reading the file gets. The data is not decoded: pass it to `decodeFileData` for the content,
 * checked against `outputHash`. Ordinary SDK reads (`readFile`) need no companion and page large files.
 */
export async function readNativeFileData(client: PublicClient, addresses: ContractAddresses, cid: AbxfsCid, limits: NativeReadLimits): Promise<NativeFileData> {
  const [mimeType, codec, outputHash, data] = await client.readContract({ address: requireCapability(addresses, "fileDataReader"), abi: fileDataReaderAbi, functionName: "readFileData", args: [cid, limits.maxBytes, limits.maxChunks] });
  return { mimeType, codec: codec as FileCodec, outputHash: outputHash as AbxfsCid, data: hexToBytes(data) };
}
/**
 * `[start, start + length)` of a file's stored data through `FileDataReader`, for any codec (the data-level counterpart
 * of `readNativeFileRange`). `maxBytes` counts every chunk the range touches in full. Ranges page a file in calls that
 * each fit a gas budget: EIP-8037's 2^24 execution budget for a contract reading inside a transaction, or an endpoint's
 * `eth_call` cap (some reth versions also refuse an `eth_call` past 2^24 on EIP-8037 chains; fixed, not yet released).
 */
export async function readNativeFileDataRange(client: PublicClient, addresses: ContractAddresses, cid: AbxfsCid, start: bigint, length: bigint, limits: NativeReadLimits): Promise<NativeFileData> {
  const [mimeType, codec, outputHash, data] = await client.readContract({ address: requireCapability(addresses, "fileDataReader"), abi: fileDataReaderAbi, functionName: "readFileDataRange", args: [cid, start, length, limits.maxBytes, limits.maxChunks] });
  return { mimeType, codec: codec as FileCodec, outputHash: outputHash as AbxfsCid, data: hexToBytes(data) };
}
/** {@link readNativeFileData} for a path; a selected directory reads its `index.html`, as `readNativePath` does. */
export async function readNativePathData(client: PublicClient, addresses: ContractAddresses, root: AbxfsCid, path: string, limits: NativeReadLimits): Promise<NativeFileData> {
  const [mimeType, codec, outputHash, data] = await client.readContract({ address: requireCapability(addresses, "fileDataReader"), abi: fileDataReaderAbi, functionName: "readPathData", args: [root, path, limits.maxBytes, limits.maxChunks] });
  return { mimeType, codec: codec as FileCodec, outputHash: outputHash as AbxfsCid, data: hexToBytes(data) };
}
/** Conservative static signal. Active markup is uncertain even when no obvious network call is present. */
export function analyzePresentationDependencies(mimeType: string, bytes: Uint8Array): { residualDependencies: string[]; runtimeUncertain: boolean } {
  if (mimeType !== "text/html" && mimeType !== "image/svg+xml") return { residualDependencies: [], runtimeUncertain: false };
  const text = new TextDecoder().decode(bytes);
  const refs = new Set<string>();
  for (const match of text.matchAll(/(?:\b(?:src|href|xlink:href|poster|data|action|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const ref = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (ref && !ref.startsWith("#") && !/^data:/i.test(ref)) refs.add(ref);
  }
  for (const match of text.matchAll(/url\(\s*["']?([^)'"\s]+)|@import\s+["']([^"']+)/gi)) {
    const ref = match[1] ?? match[2] ?? "";
    if (!ref.startsWith("#") && !/^data:/i.test(ref)) refs.add(ref);
  }
  const runtimeUncertain = /<script\b|\bon[a-z]+\s*=|javascript:/i.test(text);
  // A heuristic only: straightforward inline canvas code is a useful embedded artwork. Network APIs,
  // module imports and opaque code generation retain a gateway origin even without a literal URL.
  const network = text.match(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|Worker|SharedWorker|sendBeacon)\s*\(|\bimport\s*(?:\(|["'{*]|[A-Za-z_$])|\beval\s*\(|\bFunction\s*\(|\batob\s*\(|\bcreateElement\s*\(|\.\s*(?:src|href|location)\s*=/gi) ?? [];
  for (const pattern of network) refs.add(`runtime dependency: ${pattern.trim()}`);
  if (/<\s*(?:iframe|object|embed|base)\b|\bsrcdoc\s*=|http-equiv\s*=|<!ENTITY|\\/i.test(text)) refs.add("opaque markup or escaped references");
  return { residualDependencies: [...refs], runtimeUncertain };
}
/** Auto policy only; explicit Embedded never inherits these recommendation thresholds. */
export function recommendPresentationPayload(input: {
  mimeType: string; size: number; chunkCount?: number; codec?: string; bytes?: Uint8Array;
  presentationVersion?: number; multipleFiles?: boolean; inspection?: "local" | "onchain";
}, policy: PresentationAutoPolicy = {}): PresentationRecommendation {
  const maxBytes = policy.maxBytes ?? DEFAULT_AUTO_MAX_BYTES;
  const maxChunks = policy.maxChunks ?? 256;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxChunks) || maxChunks < 1)
    throw new Error("Auto byte/chunk policy must use positive safe integers");
  const diagnostics: PresentationDiagnostic[] = [];
  const add = (code: string, message: string, technical = false) => diagnostics.push({ code, message, technical });
  const codec = Boolean(input.codec && input.codec.toLowerCase() !== ZERO_HASH);
  if (codec) add("unsupported_codec", "file-level codecs require off-chain decoding; native Embedded cannot decode them", true);
  if (!EMBED_MIMES.has(input.mimeType)) add("unsupported_mime", input.mimeType === "text/uri-list" ? "text/uri-list is reserved for locator output, not Embedded content" : "MIME type is not supported for embedding", true);
  if (input.presentationVersion === 1 && (input.size > MAX_EMBED_BYTES || (input.chunkCount ?? 0) > MAX_EMBED_CHUNKS))
    add("legacy_limit", "this historical presentation generation has an 8192-byte/32-chunk technical limit", true);
  if (input.size > maxBytes || (input.chunkCount ?? 0) > maxChunks)
    add("auto_policy", "content exceeds the configured Auto inspection recommendation; explicit Embedded remains an owner choice");
  if (input.multipleFiles) add("directory_origin", "the selected directory has multiple entries; preserve its origin and file paths");
  const analysis = input.bytes && input.size <= maxBytes ? analyzePresentationDependencies(input.mimeType, input.bytes) : { residualDependencies: [], runtimeUncertain: true };
  if (analysis.residualDependencies.length) add("dependencies", "detected references or runtime behavior require a gateway origin");
  if (!input.bytes && !diagnostics.length) add("inspection_unavailable", "content bytes could not be inspected within the read policy");
  return {
    method: diagnostics.length ? PresentationMethod.ChainGateway : PresentationMethod.Embedded,
    reason: diagnostics[0]?.message ?? (analysis.runtimeUncertain ? "supported payload within Auto policy; executable-code self-containment remains uncertain" : "supported payload within Auto policy with no detected dependencies"),
    ...analysis, diagnostics,
    readReach: { inspection: input.inspection ?? "local", bytes: input.size, ...(input.chunkCount !== undefined ? { chunks: input.chunkCount } : {}),
      nativeReadable: !diagnostics.some(d => d.technical), tokenUri: "not-measured" },
  };
}

/** Auto always resolves to Embedded or ChainGateway; it never chooses IPFS. */
export async function recommendPresentationMethod(client: PublicClient, addresses: ContractAddresses, root: AbxfsCid, path = "", policy: PresentationAutoPolicy = {}): Promise<PresentationRecommendation> {
  const version = await presentationVersion(client, addresses);
  const chain = (reason: string): PresentationRecommendation => ({ method: PresentationMethod.ChainGateway, reason, residualDependencies: [], runtimeUncertain: true,
    diagnostics: [{ code: "inspection_unavailable", message: reason, technical: false }],
    readReach: { inspection: "unresolved", nativeReadable: null, tokenUri: "not-measured" } });
  try {
    let cid = root;
    let directory = (await cidKind(client, addresses, root)) === ProjectKind.Directory;
    if (path) {
      if (!directory) return chain("a file root cannot have a nonempty path");
      const selected = await resolvePath(client, addresses, root, path);
      cid = selected.cid; directory = selected.isDirectory;
    }
    let multipleFiles = false;
    if (directory) {
      multipleFiles = (await directoryEntryCount(client, addresses, cid)) > 1;
      let index;
      try { index = await lookupEntry(client, addresses, cid, "index.html"); }
      catch (error) {
        if (!isRevertFailure(error)) throw error;
        const result = chain("the selected directory has no index.html file; select an entrypoint or use ChainGateway");
        result.diagnostics = [{ code: "missing_index", message: result.reason, technical: true }];
        result.readReach!.nativeReadable = false;
        return result;
      }
      if (index.isDirectory) {
        const result = chain("index.html is a directory, not an Embedded file");
        result.diagnostics = [{ code: "missing_index", message: result.reason, technical: true }];
        result.readReach!.nativeReadable = false;
        return result;
      }
      cid = index.cid;
    }
    const info = await getFileInfo(client, addresses, cid);
    const maxBytes = policy.maxBytes ?? DEFAULT_AUTO_MAX_BYTES;
    const maxChunks = policy.maxChunks ?? 256;
    let bytes: Uint8Array | undefined;
    if (info.size <= maxBytes && info.chunkCount <= maxChunks) {
      try { bytes = (await readFile(client, addresses, cid, { maxStoredBytes: maxBytes, maxInflateBytes: maxBytes, maxChunks, maxCalls: policy.maxCalls ?? 64 })).bytes; }
      catch (error) {
        // Metadata already proves the native codec constraint even if optional off-chain decoding fails.
        if (info.codec.toLowerCase() === ZERO_HASH) throw error;
      }
    }
    return recommendPresentationPayload({ mimeType: info.mimeType, size: info.size, chunkCount: info.chunkCount, codec: info.codec,
      bytes, presentationVersion: version, multipleFiles, inspection: "onchain" }, policy);
  } catch (error) {
    return chain(`content could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}


export interface PresentationTokenUriCheck {
  ok: boolean;
  status: "ready" | "neutral" | "read-failed";
  callerGas: bigint;
  metadataBytes?: number;
  blockNumber?: bigint;
  afterTransactionHash?: Hex;
  animationHash?: Hex;
  reason: string;
}
export interface PresentationTokenUriOptions {
  gas?: bigint;
  maxMetadataBytes?: number;
  /** Pin the call to this exact block. */
  blockNumber?: bigint;
  /** A confirmed final settings/publication transaction; read at its receipt block. */
  afterTransactionHash?: Hex;
}
const tokenUriAbi = [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] }] as const;
/** One bounded complete metadata read. Native preview success never substitutes for this check. */
export async function verifyPresentationTokenUri(client: PublicClient, org: Address, tokenId: bigint,
  options: PresentationTokenUriOptions = {}): Promise<PresentationTokenUriCheck> {
  const callerGas = options.gas ?? 50_000_000n;
  const maxMetadataBytes = options.maxMetadataBytes ?? 2 * 1024 * 1024;
  if (callerGas <= 0n || !Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1) throw new Error("invalid complete metadata read budget");
  let blockNumber = options.blockNumber;
  const afterTransactionHash = options.afterTransactionHash;
  try {
    if (afterTransactionHash) {
      const receipt = await waitForSuccessfulReceipt({ waitForTransactionReceipt: request => client.waitForTransactionReceipt({
        ...request, timeout: Math.max(1, pinnedReadPolicy.attempts) * Math.max(1, pinnedReadPolicy.delayMs) + 1_000,
        pollingInterval: Math.max(1, pinnedReadPolicy.delayMs),
      }) }, afterTransactionHash, "presentation verification prerequisite");
      if (receipt.blockNumber === undefined) throw new Error("confirmed receipt has no block number; refusing a stale latest-state check");
      if (blockNumber !== undefined && blockNumber !== receipt.blockNumber) throw new Error("explicit block does not match the confirmed receipt block");
      blockNumber = receipt.blockNumber;
    }
    let response: Awaited<ReturnType<PublicClient["call"]>>;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await client.call({ to: org, data: encodeFunctionData({ abi: tokenUriAbi, functionName: "tokenURI", args: [tokenId] }),
          gas: callerGas, ...(blockNumber !== undefined ? { blockNumber } : {}) });
        break;
      } catch (error) {
        // Match readAtBlock: retry only bounded pinned-block availability, never a genuine revert or transport error.
        if (blockNumber === undefined || isRevertFailure(error) || isTransportFailure(error) || attempt >= pinnedReadPolicy.attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, pinnedReadPolicy.delayMs));
      }
    }
    const { data } = response;
    if (!data) throw new Error("empty tokenURI response");
    const uri = decodeFunctionResult({ abi: tokenUriAbi, functionName: "tokenURI", data });
    if (uri.length > maxMetadataBytes) throw new Error("complete metadata exceeds configured response inspection budget");
    const prefix = "data:application/json;base64,";
    const json = uri.startsWith(prefix) ? new TextDecoder().decode(Uint8Array.from(atob(uri.slice(prefix.length)), char => char.charCodeAt(0)))
      : uri.startsWith("data:application/json,") ? decodeURIComponent(uri.slice("data:application/json,".length))
        : (() => { throw new Error("tokenURI is not inline JSON metadata"); })();
    const metadata = JSON.parse(json) as { animation_url?: unknown };
    if (typeof metadata.animation_url !== "string") throw new Error("metadata has no animation_url string");
    const neutral = metadata.animation_url === "data:text/plain;base64," || metadata.animation_url === "";
    return { ok: !neutral, status: neutral ? "neutral" : "ready", callerGas, blockNumber, afterTransactionHash, metadataBytes: uri.length,
      animationHash: keccak256(toBytes(metadata.animation_url)),
      reason: neutral ? "complete metadata returned a neutral animation payload; inspect presentation or choose a different delivery method"
        : "complete tokenURI returned valid metadata and a non-neutral animation; viewer execution and endpoint availability are not guaranteed" };
  } catch (error) {
    return { ok: false, status: "read-failed", callerGas, blockNumber, afterTransactionHash,
      reason: `complete tokenURI could not be verified within this caller/RPC budget: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
}
