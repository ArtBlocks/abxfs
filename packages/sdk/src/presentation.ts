/** Optional native reading and generation-specific project presentation. */
import { hexToBytes, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { contentReaderAbi } from "./abi-reader.js";
import { iProjectPresentationAbi } from "./abi-presentation.js";
import { asAbxfsCid, ProjectKind, type AbxfsCid, type ContractAddresses } from "./types.js";
import { ZERO_HASH } from "./cid.js";
import { assertWalletChain } from "./wallet-chain.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { snapshotBlock } from "./snapshot.js";
import { cidKind } from "./kind.js";
import { directoryEntryCount, getFileInfo, lookupEntry, readFile, resolvePath } from "./read.js";

export enum PresentationMethod { ChainGateway, Embedded, Ipfs }
export enum PresentationSelection { Latest, Version, Tag }
export enum PresentationStatus { Ready, Unpublished, InvalidTarget, UnsupportedMime, ReadFailed, IpfsFailed, UnsupportedCodec, OverBudget }
export const PresentationLock = { Content: 1, Method: 2, Endpoints: 4 } as const;
export const MAX_EMBED_BYTES = 8_192;
export const MAX_EMBED_CHUNKS = 32;
export interface PresentationConfig {
  selection: PresentationSelection;
  method: PresentationMethod;
  locks: number;
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
}
export class PresentationCapabilityError extends Error {
  constructor(readonly capability: "projectPresentation" | "contentReader", readonly factory?: Address) {
    super(capability === "projectPresentation"
      ? `org generation ${factory ?? "(unconfigured)"} does not support project presentation; it cannot inherit a newer generation's contract`
      : "this chain has no native contentReader configured");
    this.name = "PresentationCapabilityError";
  }
}
function requireCapability(addresses: ContractAddresses, capability: "projectPresentation" | "contentReader"): Address {
  const address = addresses[capability];
  if (!address) throw new PresentationCapabilityError(capability, addresses.orgFactory);
  return address;
}
export async function readPresentation(client: PublicClient, addresses: ContractAddresses, org: Address, tokenId: bigint, blockNumber?: bigint): Promise<PresentationConfig> {
  return client.readContract({ address: requireCapability(addresses, "projectPresentation"), abi: iProjectPresentationAbi, functionName: "config", args: [org, tokenId], blockNumber });
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
export function setPresentationEndpoints(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, endpoints: { chainBase: string; ipfsBase: string }): Promise<Hex> {
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
/** The caller must supply the commitment from the reviewed snapshot, for every lock mask. */
export async function lockPresentation(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, mask: number, expectedCommitment: Hex): Promise<Hex> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  assertLockMask(mask);
  if (!expectedCommitment || !/^0x[0-9a-fA-F]{64}$/.test(expectedCommitment) || expectedCommitment === ZERO_HASH)
    throw new Error("presentation lock requires a nonzero expectedCommitment from the reviewed snapshot");
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
const EMBED_MIMES = new Set(["text/html", "image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm"]);
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
/** Auto is tooling only: this always resolves to Embedded or ChainGateway, never IPFS. */
export async function recommendPresentationMethod(client: PublicClient, addresses: ContractAddresses, root: AbxfsCid, path = ""): Promise<PresentationRecommendation> {
  const chain = (reason: string, residualDependencies: string[] = [], runtimeUncertain = false): PresentationRecommendation => ({ method: PresentationMethod.ChainGateway, reason, residualDependencies, runtimeUncertain });
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
      const index = await lookupEntry(client, addresses, cid, "index.html");
      if (index.isDirectory) return chain("index.html is a directory");
      cid = index.cid;
    }
    const info = await getFileInfo(client, addresses, cid);
    const offchainCodec = info.codec.toLowerCase() !== ZERO_HASH;
    if (info.size > MAX_EMBED_BYTES || info.chunkCount > MAX_EMBED_CHUNKS) return chain("content exceeds native embedding byte or chunk limits");
    if (!EMBED_MIMES.has(info.mimeType)) return chain("MIME type is not supported for embedding");
    const file = await readFile(client, addresses, cid, { maxStoredBytes: MAX_EMBED_BYTES, maxInflateBytes: MAX_EMBED_BYTES, maxChunks: MAX_EMBED_CHUNKS, maxCalls: 8 });
    const analysis = analyzePresentationDependencies(info.mimeType, file.bytes);
    if (offchainCodec) return chain("file-level codecs require the chain gateway; native embedding does not decode them", analysis.residualDependencies, analysis.runtimeUncertain);
    if (multipleFiles) return chain("the selected directory has multiple entries; preserve its origin and file paths", analysis.residualDependencies, analysis.runtimeUncertain);
    if (analysis.residualDependencies.length) return chain("detected references or runtime behavior require a gateway origin", analysis.residualDependencies, analysis.runtimeUncertain);
    return { method: PresentationMethod.Embedded, reason: analysis.runtimeUncertain ? "small supported payload with no detected dependencies; inline JavaScript is a heuristic signal, not proof of self-containment" : "small supported payload with no detected dependencies", ...analysis };
  } catch (error) {
    return chain(`content could not be inspected: ${error instanceof Error ? error.message : String(error)}`, [], true);
  }
}
