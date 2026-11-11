/** Shared tooling decisions for publication; contracts do not choose entrypoints or Auto policy. */
import type { PublicClient, Hex, Address } from "viem";
import type { AbxfsCid, ContractAddresses, FileCodec, FileDescriptor } from "./types.js";
import { ProjectKind } from "./types.js";
import { ZERO_HASH } from "./cid.js";
import { isRevertFailure } from "./multicall.js";
import { assertLiteralPath } from "./names.js";
import { validateRelativePath } from "./util.js";
import { cidKind } from "./kind.js";
import { directoryEntryCount, getDirectoryEntriesPage, lookupEntry } from "./read.js";
import {
  PresentationLock, PresentationMethod, PresentationSelection, configurePresentationTarget,
  setPresentationMethod, presentationVersion, recommendPresentationMethod, recommendPresentationPayload,
  type PresentationAutoPolicy, type PresentationClients, type PresentationConfig, type PresentationDiagnostic,
  type PresentationReadReach, type PresentationRecommendation, type PresentationTarget,
} from "./presentation.js";

export type PresentationIntent = PresentationMethod | "auto" | "preserve";
export interface PresentationPlanRequest {
  root: AbxfsCid;
  files?: readonly FileDescriptor[];
  /** Complete proposed directory manifest, including unchanged files in an overlay. */
  entries?: readonly { path: string; cid?: AbxfsCid }[];
  rootIsDirectory?: boolean;
  codec?: FileCodec;
  method?: PresentationIntent;
  /** undefined suggests an entrypoint only on initial setup; empty explicitly selects the root. */
  path?: string;
  firstPublication?: boolean;
  current?: PresentationConfig & { root?: AbxfsCid | null };
  autoPolicy?: PresentationAutoPolicy;
}
export interface PresentationPlan {
  root: AbxfsCid;
  path: string;
  requested: PresentationIntent;
  method: PresentationMethod;
  target: PresentationTarget;
  configureTarget: boolean;
  configureMethod: boolean;
  reason: string;
  locks: number;
  readiness: "ready" | "warning" | "blocked" | "unresolved";
  diagnostics: PresentationDiagnostic[];
  residualDependencies: string[];
  runtimeUncertain: boolean;
  readReach: PresentationReadReach;
  presentationVersion: number;
}
/** Match the presentation contract's path grammar before planning a target mutation. */
export function validatePresentationPath(path: string): void {
  if (!path) return;
  try { assertLiteralPath(path); validateRelativePath(path); }
  catch { throw new Error("presentation path must be a well-formed relative path without backslashes, empty segments, '.' or '..'"); }
  const utf8 = new TextEncoder();
  if (utf8.encode(path).length > 2048) throw new Error("presentation path exceeds 2048 UTF-8 bytes");
  const parts = path.split("/");
  if (parts.length > 32) throw new Error("presentation path exceeds 32 segments");
  if (parts.some(part => utf8.encode(part).length > 255)) throw new Error("presentation path segment exceeds 255 UTF-8 bytes");
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("presentation path contains a control byte");
}
/** A root remains a valid directory target; only tooling suggests a file for Embedded. */
export function selectPresentationEntrypoint(paths: readonly string[], explicitPath?: string): { path: string; reason: string } {
  if (explicitPath !== undefined) return { path: explicitPath, reason: "explicit entrypoint" };
  if (paths.includes("index.html")) return { path: "index.html", reason: "directory index.html entrypoint" };
  if (paths.length === 1) return { path: paths[0]!, reason: "sole file entrypoint" };
  return { path: "", reason: "directory root; no unambiguous file entrypoint" };
}
function configuredDimensions(c: PresentationConfig | undefined): number {
  if (!c) return 0;
  if (c.configuredFlags !== undefined) return c.configuredFlags | c.locks;
  // Historical generations cannot distinguish explicit default setters. They are retired from new creation.
  return c.locks | (c.selection !== PresentationSelection.Latest || c.path || c.tag || c.version ? 1 : 0)
    | (c.method !== PresentationMethod.ChainGateway ? 2 : 0) | (c.chainBase || c.ipfsBase ? 4 : 0);
}
async function storedEntrypoint(client: PublicClient, addresses: ContractAddresses, root: AbxfsCid): Promise<string> {
  if ((await cidKind(client, addresses, root)) !== ProjectKind.Directory) return "";
  try { const index = await lookupEntry(client, addresses, root, "index.html"); if (!index.isDirectory) return "index.html"; } catch (error) { if (!isRevertFailure(error)) throw error; }
  if ((await directoryEntryCount(client, addresses, root)) === 1) {
    const entries = await getDirectoryEntriesPage(client, addresses, root, 0, 1);
    if (entries[0] && !entries[0].isDirectory) return entries[0].name;
  }
  return "";
}
export async function planPresentation(client: PublicClient, addresses: ContractAddresses, request: PresentationPlanRequest): Promise<PresentationPlan> {
  const current = request.current;
  const version = await presentationVersion(client, addresses);
  const configured = configuredDimensions(current);
  const initializeMethod = Boolean(request.firstPublication && !(configured & PresentationLock.Method));
  const initializeTarget = Boolean(request.firstPublication && !(configured & PresentationLock.Content) && request.method !== "preserve");
  const requested = request.method ?? (initializeMethod ? "auto" : "preserve");
  const choosePath = request.path !== undefined || initializeTarget;
  const sourcePinned = Boolean(current && ((current.locks & PresentationLock.Content) || current.selection !== PresentationSelection.Latest));
  const root = sourcePinned && current?.root ? current.root : request.root;
  let path = current?.path ?? "";
  if (choosePath) {
    if (request.path !== undefined) path = request.path;
    else if (request.rootIsDirectory === false) path = "";
    else if (request.files || request.entries) path = selectPresentationEntrypoint((request.entries ?? request.files ?? []).map(file => file.path)).path;
    else path = await storedEntrypoint(client, addresses, root);
  }
  let invalidPath: string | undefined;
  let entrypointFallback = false;
  try { validatePresentationPath(path); }
  catch (error) {
    if (request.path === undefined && choosePath) { path = ""; entrypointFallback = true; }
    else invalidPath = error instanceof Error ? error.message : "invalid presentation path";
  }
  const target: PresentationTarget = current?.selection === PresentationSelection.Version
    ? { selection: current.selection, version: current.version, path }
    : current?.selection === PresentationSelection.Tag ? { selection: current.selection, tag: current.tag, path }
      : { selection: PresentationSelection.Latest, path };
  const manifest = request.entries ?? request.files;
  const paths = manifest?.map(file => file.path);
  const directoryPath = request.rootIsDirectory !== false && (!path || Boolean(paths?.some(name => name.startsWith(`${path}/`))));
  const readPath = directoryPath ? (path ? `${path}/index.html` : "index.html") : path;
  const directoryPrefix = path ? `${path}/` : "";
  const multipleFiles = directoryPath && new Set(paths?.filter(name => name.startsWith(directoryPrefix))
    .map(name => name.slice(directoryPrefix.length).split("/")[0])).size > 1;
  const selected = root === request.root ? request.files?.find(file => file.path === readPath || request.rootIsDirectory === false) : undefined;
  const selectedEntry = root === request.root ? request.entries?.find(file => file.path === readPath) : undefined;
  let analysis: PresentationRecommendation;
  if (invalidPath) {
    analysis = { method: PresentationMethod.ChainGateway, reason: invalidPath, residualDependencies: [], runtimeUncertain: false,
      diagnostics: [{ code: "invalid_path", message: invalidPath, technical: true }],
      readReach: { inspection: "local", nativeReadable: false, tokenUri: "not-measured" } };
  } else if (request.rootIsDirectory === false && path) {
    analysis = { method: PresentationMethod.ChainGateway, reason: "a file root cannot have a nonempty path", residualDependencies: [], runtimeUncertain: false,
      diagnostics: [{ code: "invalid_file_path", message: "a file root cannot have a nonempty path", technical: true }],
      readReach: { inspection: "local", nativeReadable: false, tokenUri: "not-measured" } };
  } else if (selected) {
    analysis = recommendPresentationPayload({ mimeType: selected.mimeType, size: selected.bytes.length, codec: request.codec ?? ZERO_HASH,
      bytes: selected.bytes, presentationVersion: version, multipleFiles, inspection: "local" }, request.autoPolicy);
  } else if (root === request.root && manifest && !selectedEntry && request.rootIsDirectory !== false) {
    analysis = { method: PresentationMethod.ChainGateway, reason: "the selected directory has no index.html file; choose an entrypoint or use ChainGateway", residualDependencies: [], runtimeUncertain: false,
      diagnostics: [{ code: directoryPath ? "missing_index" : "missing_target", message: directoryPath ? "the selected directory has no index.html file; no synthetic listing is embedded" : "the selected path is absent from the proposed complete manifest", technical: true }],
      readReach: { inspection: "local", nativeReadable: false, tokenUri: "not-measured" } };
  } else {
    analysis = await recommendPresentationMethod(client, addresses, selectedEntry?.cid ?? root, selectedEntry?.cid ? "" : path, request.autoPolicy);
  }
  const method = requested === "preserve" ? current?.method ?? PresentationMethod.ChainGateway : requested === "auto" ? analysis.method : requested;
  const configureTarget = choosePath && (path !== current?.path || initializeTarget || request.path !== undefined);
  const configureMethod = requested !== "preserve" && (method !== current?.method || initializeMethod || request.method !== undefined);
  const diagnostics = [...(analysis.diagnostics ?? [])];
  if (entrypointFallback) diagnostics.unshift({ code: "entrypoint_path_policy", message: "suggested entrypoint exceeds the presentation path grammar; keep the directory root and use ChainGateway or choose a valid entrypoint", technical: false });
  const locks = current?.locks ?? 0;
  if (!version && (configureTarget || configureMethod)) diagnostics.push({ code: "unsupported_generation", message: "this factory generation has no presentation capability", technical: true });
  if (configureTarget && (locks & PresentationLock.Content)) diagnostics.push({ code: "content_locked", message: "the displayed content and entrypoint are permanently frozen", technical: true });
  if (configureMethod && (locks & PresentationLock.Method)) diagnostics.push({ code: "method_locked", message: "the presentation method is permanently locked", technical: true });
  const blocked = diagnostics.some(d => d.code.endsWith("_locked") || d.code === "unsupported_generation" || d.code === "invalid_path" || (method === PresentationMethod.Embedded && (configureTarget || configureMethod) && d.technical));
  return { root, path, requested, method, target, configureTarget, configureMethod, reason: requested === "preserve" ? "preserve the saved presentation method" : requested === "auto" ? entrypointFallback ? diagnostics[0]!.message : analysis.reason : "explicit owner choice",
    locks, readiness: blocked ? "blocked" : analysis.readReach?.inspection === "unresolved" ? "unresolved" : diagnostics.length ? "warning" : "ready",
    diagnostics, residualDependencies: analysis.residualDependencies, runtimeUncertain: analysis.runtimeUncertain,
    readReach: analysis.readReach ?? { inspection: "unresolved", nativeReadable: null, tokenUri: "not-measured" }, presentationVersion: version };
}
export interface PresentationApplyResult { afterTransactionHash?: Hex; phases: { phase: "set-target" | "set-method"; txHash: Hex }[] }
/** This executor never uploads, mints or publishes. A partial failure retains its completed phases. */
export class PresentationApplyError extends Error {
  constructor(readonly phase: "set-target" | "set-method", readonly completed: PresentationApplyResult["phases"], readonly plan: PresentationPlan, cause: unknown) {
    super(`presentation setup stopped during ${phase}; published content must not be republished`, { cause });
    this.name = "PresentationApplyError";
  }
}
export async function applyPresentationPlan(clients: PresentationClients, addresses: ContractAddresses, org: Address, tokenId: bigint, plan: PresentationPlan): Promise<PresentationApplyResult> {
  if (plan.readiness === "blocked") throw new Error(plan.diagnostics.map(d => d.message).join("; "));
  const phases: PresentationApplyResult["phases"] = [];
  let phase: "set-target" | "set-method" = "set-target";
  try {
    if (plan.configureTarget) phases.push({ phase, txHash: await configurePresentationTarget(clients, addresses, org, tokenId, plan.target) });
    phase = "set-method";
    if (plan.configureMethod) phases.push({ phase, txHash: await setPresentationMethod(clients, addresses, org, tokenId, plan.method) });
    return { phases, afterTransactionHash: phases.at(-1)?.txHash };
  } catch (error) { throw new PresentationApplyError(phase, phases, plan, error); }
}
