/**
 * Verify flow: derive the IPFS CID of on-chain ABX FS content, on chain and locally.
 *
 *  - `verifyLocalIpfsCid`     — read the content from chain and compute its IPFS CID client-side
 *  - `verifyOnChainIpfsCid`   — ask the on-chain `IpfsCidResolver` to compute it (a view call)
 *  - `assertIpfsCidAgreement` — both, and refuse a disagreement
 */
import { BaseError, decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";

import { locateContent } from "./kind.js";
import { iIpfsCidResolverAbi } from "./abi.js";
import {
  DirectoryNeedsShardingError,
  ipfsDirectoryCid,
  ipfsDirectoryEstimate,
  ipfsDirectoryNeedsSharding,
  ipfsFileCidWithSize,
  sortDirectoryEntries,
} from "./cid.js";
import { readDirectory, readFile } from "./read.js";
import { mapInSlices } from "./util.js";
import { DEFAULT_RESOLVER_CALL_GAS, LimitExceededError, TraversalBudget, descend, type Ancestry, type TraversalLimits } from "./limits.js";
import { ProjectKind, type AbxfsCid, type ContractAddresses, type IpfsCid } from "./types.js";

/**
 * Roots the resolver already failed on, for the life of this process. A hostile tree can make the
 * resolver burn its whole gas allowance; asking again (a UI re-render, a retry loop) only repeats
 * that. Bounded, and cleared by {@link clearResolverFailureCache}.
 */
const resolverFailures = new Map<string, string | CodecNotSupportedOnChainError | DirectoryNeedsShardingError>();
const MAX_CACHED_FAILURES = 1000;

export function clearResolverFailureCache(): void {
  resolverFailures.clear();
}

/**
 * The on-chain resolver cannot derive this content's IPFS CID: a file in it carries an off-chain file codec, which the
 * chain does not decode. Not a fault: {@link verifyLocalIpfsCid} derives it, and is the only way to.
 */
export class CodecNotSupportedOnChainError extends Error {
  constructor(
    readonly cid: AbxfsCid,
    /** The codec label the resolver refused. */
    readonly codec: Hex,
  ) {
    super(`the on-chain resolver cannot derive ${cid}: it holds a file with an off-chain codec (${codec}); derive it locally`);
    this.name = "CodecNotSupportedOnChainError";
  }
}

/** The resolver's own revert, decoded, when `err` carries one. */
function resolverRevert(err: unknown): { errorName: string; args: readonly unknown[] } | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
  if (!withData?.data || withData.data.length < 10) return undefined;
  try {
    const r = decodeErrorResult({ abi: iIpfsCidResolverAbi, data: withData.data });
    return { errorName: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return undefined;
  }
}

/**
 * Ask the on-chain IpfsCidResolver to compute the IPFS CID for an ABX FS CID.
 * Automatically routes to `computeFileCid` (for file CIDs) or `computeIpfsCid` (for directory
 * CIDs).
 *
 * Two refusals are typed, and a caller tells them apart by type, never by message: {@link CodecNotSupportedOnChainError}
 * (a file codec the chain does not decode: derive locally instead) and `DirectoryNeedsShardingError` (a directory IPFS
 * would shard: no flat derivation is correct, so do NOT fall back to a local one; report it as not supported).
 *
 * The call carries an explicit gas limit (default {@link DEFAULT_RESOLVER_CALL_GAS}) rather than
 * inheriting the node's cap, and a failure is remembered per resolver+root so it is not retried.
 */
export async function verifyOnChainIpfsCid(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  opts: { gas?: bigint } = {},
): Promise<IpfsCid> {
  if (!addresses.ipfsCidResolver) throw new Error("ipfsCidResolver address not configured");
  const key = `${addresses.ipfsCidResolver.toLowerCase()}:${cid.toLowerCase()}`;
  const cached = resolverFailures.get(key);
  if (cached instanceof CodecNotSupportedOnChainError || cached instanceof DirectoryNeedsShardingError) throw cached;
  if (cached !== undefined) throw new Error(`on-chain IPFS CID resolution already failed for ${cid}: ${cached}`);
  // Decide file vs directory by probing the stores.
  const where = await locateContent(publicClient, addresses, cid);
  try {
    const isFile = where.kind === ProjectKind.File;
    const functionName = isFile ? "computeFileCid" : "computeIpfsCid";
    // `readContract` has no gas parameter; a raw call does.
    const { data } = await publicClient.call({
      to: addresses.ipfsCidResolver,
      data: encodeFunctionData({ abi: iIpfsCidResolverAbi, functionName, args: [cid] }),
      gas: opts.gas ?? DEFAULT_RESOLVER_CALL_GAS,
    });
    if (!data) throw new Error("resolver returned no data");
    return decodeFunctionResult({ abi: iIpfsCidResolverAbi, functionName, data }) as IpfsCid;
  } catch (err) {
    if (resolverFailures.size >= MAX_CACHED_FAILURES) resolverFailures.clear();
    const revert = resolverRevert(err);
    if (revert?.errorName === "CodecNotSupported") {
      const typed = new CodecNotSupportedOnChainError(cid, revert.args[0] as Hex);
      resolverFailures.set(key, typed);
      throw typed;
    }
    // Not a fault either, and NOT a reason to derive locally: IPFS would shard that directory, and the flat CID a local
    // derivation produced would be one no IPFS node agrees on. The same error the local derivation throws.
    if (revert?.errorName === "DirectoryNeedsSharding") {
      const typed = new DirectoryNeedsShardingError(revert.args[0] as string, Number(revert.args[1] as bigint));
      resolverFailures.set(key, typed);
      throw typed;
    }
    resolverFailures.set(key, err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "failed");
    throw err;
  }
}

/**
 * Recompute the IPFS CID for an ABX FS CID client-side by reading its content from chain and applying the same IPFS
 * profile as the on-chain resolver.
 *
 * An IPFS CID is computed over a file's CONTENT, re-chunked per the UnixFS profile; it has no relationship to how ABX
 * FS chunked, compressed or where it stored the bytes. `readFile` returns the content (FastLZ chunks inflated on chain,
 * a file codec decoded client-side), so this works for every file the client can read. The on-chain resolver cannot
 * decode a file-level codec, so for such a file this local path is the only one that produces a CID.
 */
export async function verifyLocalIpfsCid(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  limits: TraversalLimits = {},
): Promise<IpfsCid> {
  const ctx: LocalCtx = { budget: new TraversalBudget(limits), memo: new Map() };
  return (await resolveLocal(publicClient, addresses, cid, /* isDirHint */ undefined, ctx, undefined)).cid;
}

/**
 * Per-call state for {@link resolveLocal}: every distinct ABX FS cid is resolved once however many
 * times a (possibly hostile) DAG links it, and nodes/bytes are budgeted.
 */
interface LocalCtx {
  budget: TraversalBudget;
  memo: Map<string, Promise<{ cid: IpfsCid; cumulativeSize: number }>>;
}

/**
 * Walk an ABX FS subtree and return both its IPFS CID **and** the cumulative serialized
 * subtree size needed for the parent's `PBLink.Tsize`. Per the dag-pb spec, Tsize is the
 * cumulative size of the linked object and all of its descendants (raw leaves: byte
 * count; dag-pb nodes: encoded block + sum of child Tsizes). Using the immediate block's
 * size instead produces CIDs Kubo does not recognise for any nested directory.
 */
function resolveLocal(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  isDirHint: boolean | undefined,
  ctx: LocalCtx,
  ancestors: Ancestry | undefined,
): Promise<{ cid: IpfsCid; cumulativeSize: number }> {
  // A cid commits to its children, so an honest chain holds no cycle. A hostile RPC can fake one, and the
  // memo would then hand the walk its own unfinished promise: it would wait on itself forever.
  let path: Ancestry;
  try {
    path = descend(ancestors, cid.toLowerCase());
  } catch (err) {
    return Promise.reject(err);
  }
  const key = `${cid.toLowerCase()}:${isDirHint === undefined ? "?" : isDirHint ? "d" : "f"}`;
  let pending = ctx.memo.get(key);
  if (!pending) {
    ctx.budget.node();
    pending = resolveLocalUncached(publicClient, addresses, cid, isDirHint, ctx, path);
    ctx.memo.set(key, pending);
  }
  return pending;
}

async function resolveLocalUncached(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
  isDirHint: boolean | undefined,
  ctx: LocalCtx,
  path: Ancestry,
): Promise<{ cid: IpfsCid; cumulativeSize: number }> {
  // For top-level calls we don't know whether `cid` is a file or a directory; probe the
  // file store first. For recursive calls the parent already told us via DirectoryEntry.
  if (isDirHint !== true) {
    const file = await tryReadFile(publicClient, addresses, cid);
    if (file) {
      // `file.bytes` is already the logical (inflated) content — see `readFile`. Compression is
      // therefore invisible here by construction, and the CID is identical to what the same content
      // would produce stored uncompressed.
      //
      // ipfsFileCidWithSize returns the spec-correct cumulative subtree size (raw byte
      // length for single-block files; root-block encoded length + sum of leaf Tsizes
      // for chunked files).
      ctx.budget.addBytes(file.bytes.length);
      const { cid: fcid, tsize } = await ipfsFileCidWithSize(file.bytes);
      return { cid: fcid, cumulativeSize: tsize };
    }
    if (isDirHint === false) {
      throw new Error(`expected file but ${cid} is not in FileStore`);
    }
  }

  const dir = await readDirectory(publicClient, addresses, cid, { maxEntries: ctx.budget.maxNodes });
  // Names are their exact bytes (`nameBytes`), so a name that is not UTF-8 derives as the chain derives it. A directory
  // IPFS would shard is refused from its listing, before anything under it is read.
  if (ipfsDirectoryNeedsSharding(dir.entries)) throw new DirectoryNeedsShardingError(cid, ipfsDirectoryEstimate(dir.entries));
  const sorted = sortDirectoryEntries([...dir.entries]);
  const children = await mapInSlices(sorted, async (e) => {
    const child = await resolveLocal(publicClient, addresses, e.cid, e.isDirectory, ctx, path);
    return { name: e.name, ...(e.nameBytes ? { nameBytes: e.nameBytes } : {}), cid: child.cid, tsize: child.cumulativeSize };
  });
  const { cid: ipfs, encoded } = await ipfsDirectoryCid(children, { directoryCid: cid });
  const cumulativeSize =
    encoded.length + children.reduce((acc, c) => acc + c.tsize, 0);
  return { cid: ipfs, cumulativeSize };
}

async function tryReadFile(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<{ bytes: Uint8Array } | undefined> {
  try {
    return await readFile(publicClient, addresses, cid);
  } catch (err) {
    if (err instanceof LimitExceededError) throw err;
    return undefined;
  }
}

/**
 * Cross-check that the resolver's IPFS CID for `cid` matches what we compute locally.
 * Throws if they differ.
 */
export async function assertIpfsCidAgreement(
  publicClient: PublicClient,
  addresses: ContractAddresses,
  cid: AbxfsCid,
): Promise<{ onChain: IpfsCid; local: IpfsCid }> {
  const [onChain, local] = await Promise.all([
    verifyOnChainIpfsCid(publicClient, addresses, cid),
    verifyLocalIpfsCid(publicClient, addresses, cid),
  ]);
  if (onChain !== local) {
    throw new Error(`IPFS CID mismatch: on-chain=${onChain}, local=${local}`);
  }
  return { onChain, local };
}
