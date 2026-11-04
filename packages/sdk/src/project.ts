/**
 * ABX FS projects on ABX.
 *
 * A project is an ABX NFT. Its current root CID is the `abxfs.cid` PostParam, and the schema's
 * `TokenOwner` auth is what authorizes a publish — enforced by the ABX contract, not by anything
 * here.
 *
 * **Everything here is a state read.** Head, version history, tags, the publish feed, ownership —
 * all `eth_call` against contract storage, none of it `eth_getLogs`. Logs are not permanent state:
 * providers prune them (`base-sepolia-rpc.publicnode.com` keeps a rolling ~33 days), and a scan from
 * a collection's deploy block measured 221s for an owner lookup and 273s for the recent feed, growing
 * with chain age. So the indexes live in the hooks, which write to storage that is never pruned:
 *
 *   - `ProjectHook` (configure hook) — per-project version history, tags, and the
 *     collection-wide append-only publish ledger.
 *   - `ProjectEnumeration` (transfer hook) — owner → tokens. An org's whole token set is `0 … nextTokenId() - 1`,
 *     which the org itself answers.
 */
import { assertValidPublishInputs } from "./validate.js";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  hexToString,
  stringToHex,
} from "viem";
import { seriesCodeAbi } from "@artblocks/abx-sdk/abi";

import { iProjectHookAbi } from "./abi-hook.js";
import { mintInOrg } from "./org.js";
import { settle } from "./settle.js";
import { isTransportFailure } from "./multicall.js";
import { checkCount, readAtBlock, snapshotBlock } from "./snapshot.js";
import { externalUrlProblem } from "./url-safety.js";
import { iProjectEnumerationAbi } from "./abi-enumeration.js";
import { ProjectKind, asAbxfsCid, type AbxfsCid, type ContractAddresses } from "./types.js";
import { assertSafeRecipient } from "./address-safety.js";

// ─── Param keys ──────────────────────────────────────────────────────────────

/**
 * ABX packs short param keys into `bytes32` as left-aligned ASCII — it does NOT hash them, so keys
 * are human-readable on-chain and `bytes32("abxfs.cid")` in Solidity is byte-identical to
 * `stringToHex(key, { size: 32 })` here. `test/project-keys.test.ts` pins that equivalence against
 * the deployed constants; if it ever breaks, every read and write in this file silently addresses
 * the wrong key.
 */
export const PROJECT_PARAM_KEYS = {
  cid: "abxfs.cid",
  gateway: "abxfs.gateway",
  name: "abxfs.name",
  /**
   * The owner's own URL for the live project, shown by marketplaces as the token's `animation_url`
   * and `external_url`. See {@link isUsableViewUrl}.
   */
  view: "abxfs.view",
  /**
   * Reserved for forward-compatible, per-client metadata (a JSON blob, say). The hook polices only
   * its size and attaches no meaning to its content, so nothing here may depend on what is in it.
   */
  meta: "abxfs.meta",
} as const;

export type ProjectParamKey = (typeof PROJECT_PARAM_KEYS)[keyof typeof PROJECT_PARAM_KEYS];

/** Encode a param key to its on-chain `bytes32` form. */
export function encodeParamKey(key: string): Hex {
  const bytes = new TextEncoder().encode(key);
  if (bytes.length > 32) {
    throw new Error(`param key "${key}" is ${bytes.length} bytes; ABX keys must fit in bytes32`);
  }
  return stringToHex(key, { size: 32 });
}

/** Decode an on-chain `bytes32` param key back to its string form, trimming the zero padding. */
export function decodeParamKey(key: Hex): string {
  return hexToString(key, { size: 32 }).replace(/\0+$/, "");
}

const KEY_CID = encodeParamKey(PROJECT_PARAM_KEYS.cid);
const KEY_GATEWAY = encodeParamKey(PROJECT_PARAM_KEYS.gateway);
const KEY_VIEW = encodeParamKey(PROJECT_PARAM_KEYS.view);
const KEY_NAME = encodeParamKey(PROJECT_PARAM_KEYS.name);
const KEY_META = encodeParamKey(PROJECT_PARAM_KEYS.meta);

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A project's canonical handle: chain, org, and token id. The org is the ABX collection the token
 * lives in, and token ids repeat across orgs, so all three are needed.
 */
export interface ProjectRef {
  chainId: number;
  collection: Address;
  tokenId: bigint;
}

export interface AbxfsProject {
  collection: Address;
  tokenId: bigint;
  /** The NFT holder. This is the only address authorized to publish. */
  owner: Address;
  /** `abxfs.name`, or `null` when unset. Metadata only — never an identifier. */
  name: string | null;
  /** Current head. `null` when the project has been minted but never published. */
  cid: AbxfsCid | null;
  /** Locked at first publish. `Unset` until then. */
  kind: ProjectKind;
  versionCount: number;
  /**
   * `abxfs.gateway` — an optional IPFS gateway prefix the owner prefers for serving this project's
   * content. Purely an efficiency hint: the gateway tries it first and falls back to rebuilding
   * from chain, so an unset, stale, or dead value costs latency and never correctness.
   */
  preferredGateway: string | null;
  /**
   * `abxfs.view` — the owner's own URL for the live project, or `null` when unset (or when the stored
   * value is one the token would not emit). Marketplaces show it as the token's `animation_url` and
   * `external_url`; when it is `null` they show the default path on the ABX FS site instead. It is the
   * whole URL, so it assumes nothing about the gateway behind it.
   */
  viewUrl: string | null;
  /** `abxfs.meta`, or `null`. Opaque to ABX FS; for clients to attach their own data. */
  meta: string | null;
}

export interface ProjectVersion {
  version: number;
  cid: AbxfsCid;
  publishedAt: number;
  publisher: Address;
}

export interface ProjectTag {
  tag: string;
  version: number;
  cid: AbxfsCid;
}

export interface ProjectContracts {
  collection: Address;
  hook: Address;
  /** The enumeration (transfer) hook, when known: never a sane transfer target. */
  enumeration?: Address;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Read a project's full current state in one multicall.
 *
 * Throws if the token does not exist (`ownerOf` reverts) — a project that was never minted is not
 * an empty project. A minted-but-unpublished project resolves fine, with `cid: null` and
 * `kind: Unset`.
 */
export async function readProject(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
): Promise<AbxfsProject> {
  const { collection, hook } = contracts;

  const [owner, cidParam, nameData, gatewayData, versionCount, kind, metaData, viewData] = await client.multicall({
    contracts: [
      { address: collection, abi: seriesCodeAbi, functionName: "ownerOf", args: [tokenId] },
      { address: collection, abi: seriesCodeAbi, functionName: "tokenParam", args: [tokenId, KEY_CID] },
      {
        address: collection,
        abi: seriesCodeAbi,
        functionName: "tokenParamData",
        args: [tokenId, KEY_NAME],
      },
      {
        address: collection,
        abi: seriesCodeAbi,
        functionName: "tokenParamData",
        args: [tokenId, KEY_GATEWAY],
      },
      {
        address: hook,
        abi: iProjectHookAbi,
        functionName: "versionCount",
        args: [collection, tokenId],
      },
      { address: hook, abi: iProjectHookAbi, functionName: "kindOf", args: [collection, tokenId] },
      {
        address: collection,
        abi: seriesCodeAbi,
        functionName: "tokenParamData",
        args: [tokenId, KEY_META],
      },
      {
        address: collection,
        abi: seriesCodeAbi,
        functionName: "tokenParamData",
        args: [tokenId, KEY_VIEW],
      },
    ],
    allowFailure: true,
  });

  if (owner.status !== "success") {
    throw new Error(
      `project ${collection}/${tokenId} does not exist (ownerOf reverted): ${String(owner.error)}`,
    );
  }

  return {
    collection,
    tokenId,
    owner: owner.result as Address,
    name: decodeStringParam(nameData.status === "success" ? (nameData.result as Hex) : undefined),
    cid: decodeCidParam(cidParam.status === "success" ? cidParam.result : undefined),
    kind: (kind.status === "success" ? Number(kind.result) : ProjectKind.Unset) as ProjectKind,
    versionCount: versionCount.status === "success" ? Number(versionCount.result) : 0,
    preferredGateway: (() => {
      const g = decodeStringParam(gatewayData.status === "success" ? (gatewayData.result as Hex) : undefined);
      return g === CLEARED_PARAM_VALUE ? null : g;
    })(),
    viewUrl: (() => {
      const v = decodeStringParam(viewData.status === "success" ? (viewData.result as Hex) : undefined);
      return v !== null && isUsableViewUrl(v) ? v : null;
    })(),
    meta: decodeStringParam(metaData.status === "success" ? (metaData.result as Hex) : undefined),
  };
}

/**
 * Did the EVM itself reject the call? Only a real revert may read as "no such token". Anything else (-32603
 * internal error, `header not found`, `missing trie node`, a 5xx, a timeout) says nothing about the chain.
 */
export function isDefiniteRevert(err: unknown): boolean {
  const chain: Array<{ name?: unknown; message?: unknown; code?: unknown; status?: unknown; details?: unknown; shortMessage?: unknown }> = [];
  for (let cur: unknown = err; cur && typeof cur === "object" && chain.length < 12; cur = (cur as { cause?: unknown }).cause) chain.push(cur as never);
  if (chain.length === 0) return false;
  if (chain.some((e) => typeof e.status === "number" || e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "InternalRpcError" || e.code === -32603)) return false;
  return chain.some(
    (e) =>
      e.name === "ContractFunctionRevertedError" ||
      e.name === "ExecutionRevertedError" ||
      e.code === 3 ||
      [e.shortMessage, e.details, e.message].some((m) => typeof m === "string" && /^(rpc request failed\.\s*)?execution reverted/i.test(m.trim())),
  );
}

/**
 * The facts a publish needs to be true BEFORE any content is paid for: the token exists, the signer holds
 * it, and its head is what the caller built on. One multicall read.
 *
 * Content is permissionless and permanent, so a publish that fails at its LAST step (`publishVersion`
 * reverts because the signer does not own the token, or the project moved on) has already paid for
 * everything before it. Ownership is the whole authorization model for a project, so it is checked first.
 *
 * `expectedHead`: `null` = the project must still be unpublished (a first publish); a CID = the head must
 * be exactly that (an update built on it); `undefined` = do not check the head.
 */
export async function assertCanPublish(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  signer: Address | undefined,
  opts: { expectedHead?: AbxfsCid | null; /** How long to wait for a just-minted token to become visible. Default 6000. */ settleMs?: number } = {},
): Promise<{ owner: Address; head: AbxfsCid | null }> {
  if (!signer) throw new Error("no account to publish with. Nothing was written.");
  const { collection } = contracts;

  /**
   * One read of owner and head. `missing` = `ownerOf` reverted (no such token, as far as this node knows).
   * Anything else that goes wrong THROWS: a failed `tokenParam` read must never read as an unset head (that
   * would let an update pass a first-publish check), and a transport failure (429, timeout) must never
   * read as "does not exist".
   */
  const readOnce = async (): Promise<{ missing: true } | { missing: false; ownerRaw: unknown; headRaw: unknown }> => {
    try {
      const [o, h] = await client.multicall({
        contracts: [
          { address: collection, abi: seriesCodeAbi, functionName: "ownerOf", args: [tokenId] },
          { address: collection, abi: seriesCodeAbi, functionName: "tokenParam", args: [tokenId, KEY_CID] },
        ],
        allowFailure: true,
      });
      if (o.status !== "success") {
        if (isDefiniteRevert(o.error)) return { missing: true };
        throw new Error(`could not read project #${tokenId}'s owner from org ${collection} (the node could not answer: ${String((o.error as Error | undefined)?.message ?? "read failed").slice(0, 160)}). Nothing was written.`);
      }
      if (h.status !== "success") {
        throw new Error(`could not read project #${tokenId}'s head from org ${collection} (${String((h as { error?: Error }).error?.message ?? "read failed").slice(0, 160)}). Nothing was written.`);
      }
      return { missing: false, ownerRaw: o.result, headRaw: h.result };
    } catch (e) {
      // A transport or rate-limit failure is not "no Multicall3": asking again, twice over, only adds load.
      if (isTransportFailure(e) || (e instanceof Error && /^could not read project/.test(e.message))) throw e;
    }
    // No Multicall3 on this chain (a local anvil): the same two questions, asked one by one.
    let ownerRaw: unknown;
    try {
      ownerRaw = await client.readContract({ address: collection, abi: seriesCodeAbi, functionName: "ownerOf", args: [tokenId] });
    } catch (e) {
      if (isDefiniteRevert(e)) return { missing: true };
      if (isTransportFailure(e)) throw e;
      throw new Error(`could not read project #${tokenId}'s owner from org ${collection} (the node could not answer: ${String((e as Error)?.message ?? e).slice(0, 160)}). Nothing was written.`);
    }
    const headRaw = await client.readContract({ address: collection, abi: seriesCodeAbi, functionName: "tokenParam", args: [tokenId, KEY_CID] });
    return { missing: false, ownerRaw, headRaw };
  };

  // A token minted a moment ago may not be visible on the replica answering yet: poll briefly (bounded)
  // before concluding it does not exist.
  const deadline = Date.now() + (opts.settleMs ?? 6000);
  let read = await readOnce();
  while (read.missing && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(750, Math.max(0, deadline - Date.now()))));
    read = await readOnce();
  }
  if (read.missing || typeof read.ownerRaw !== "string") {
    throw new Error(`project #${tokenId} does not exist in org ${collection} (ownerOf reverted). Nothing was written.`);
  }
  const ownerRaw = read.ownerRaw;
  const headRaw = read.headRaw;
  const owner = ownerRaw as Address;
  if (owner.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(
      `your account ${signer} does not own project #${tokenId} in org ${collection} (it is held by ${owner}). ` +
        "Only the holder can publish. Nothing was written.",
    );
  }
  const head = decodeCidParam(headRaw);
  const expected = opts.expectedHead;
  if (expected === null && head !== null) {
    throw new Error(
      `project #${tokenId} already has content published (${head}). A first publish only goes to an empty project; ` +
        "publish an update to it instead. Nothing was written.",
    );
  }
  if (typeof expected === "string" && (head === null || head.toLowerCase() !== expected.toLowerCase())) {
    throw new Error(
      `project #${tokenId} changed since this update was prepared (its head is now ${head ?? "unset"}, not ${expected}). ` +
        "Reload and try again. Nothing was written.",
    );
  }
  return { owner, head };
}

/**
 * `abxfs.cid` is a scalar param, so the raw `bytes32` IS the CID and `valueIsHash` must be false.
 * A true `valueIsHash` means the key was declared as `String`/`Bytes`, making the value a keccak
 * commitment rather than a CID — treat that as unpublished rather than hand back a hash that would
 * fail every subsequent resolve in a confusing place.
 */
function decodeCidParam(result: unknown): AbxfsCid | null {
  if (!Array.isArray(result)) return null;
  const [value, valueIsHash, isSet] = result as [Hex, boolean, boolean];
  if (!isSet || valueIsHash) return null;
  if (!value || /^0x0{64}$/.test(value)) return null;
  return asAbxfsCid(value);
}

function decodeStringParam(data: Hex | undefined): string | null {
  if (!data || data === "0x") return null;
  // ignoreBOM: keep a leading U+FEFF in the text. The default strips it, which would make a value the
  // chain refuses (the links renderer sees the raw bytes) look usable here.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(hexToBytes(data));
  return text.length > 0 ? text : null;
}

function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Rows per `eth_call` for history and tag reads. An inherited project can hold an enormous history. */
export const HISTORY_PAGE_SIZE = 200;

/**
 * Read version history from the hook, one bounded `eth_call`.
 *
 * Returns at most `limit` (default {@link HISTORY_PAGE_SIZE}) versions, the NEWEST ones unless `start`
 * is given: reading a project whose previous owner minted tens of thousands of versions must not be
 * able to exceed a node's `eth_call` cap. `end` is exclusive and 0-based, like the hook's
 * `versionsRange`. For "load more", use {@link readVersionHistoryPage}.
 */
export async function readVersionHistory(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  opts: { start?: number; end?: number; limit?: number } = {},
): Promise<ProjectVersion[]> {
  const { collection, hook } = contracts;
  const limit = Math.max(1, Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 1000));

  const total =
    opts.end ??
    Number(
      await client.readContract({
        address: hook,
        abi: iProjectHookAbi,
        functionName: "versionCount",
        args: [collection, tokenId],
      }),
    );
  const start = opts.start ?? Math.max(0, total - limit);
  const count = Math.min(total, start + limit);
  if (count <= start) return [];

  // `publishedAt` is a `uint40`, which viem types as `number` rather than `bigint` — let the ABI
  // drive the types here instead of asserting a shape.
  const records = await client.readContract({
    address: hook,
    abi: iProjectHookAbi,
    functionName: "versionsRange",
    args: [collection, tokenId, BigInt(start), BigInt(count)],
  });

  return records.map((r, i) => ({
    // `versionsRange` is 0-indexed over history; version numbers are 1-indexed.
    version: start + i + 1,
    cid: asAbxfsCid(r.cid),
    publishedAt: r.publishedAt,
    publisher: r.publisher,
  }));
}

export interface VersionHistoryPage {
  /** Oldest first within the page. */
  versions: ProjectVersion[];
  /** Total versions the hook holds. */
  total: number;
  /** Pass as `before` to fetch the next-older page, or `null` when this page reaches the first version. */
  nextBefore: number | null;
}

/**
 * One page of history, newest page first. `before` is an exclusive 0-based index (omit for the
 * newest page); feed `nextBefore` back in for "load more".
 */
export async function readVersionHistoryPage(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  opts: { before?: number; limit?: number } = {},
): Promise<VersionHistoryPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 1000));
  const total = Number(
    await client.readContract({
      address: contracts.hook,
      abi: iProjectHookAbi,
      functionName: "versionCount",
      args: [contracts.collection, tokenId],
    }),
  );
  const end = Math.min(opts.before ?? total, total);
  const start = Math.max(0, end - limit);
  const versions = end > start ? await readVersionHistory(client, contracts, tokenId, { start, end, limit }) : [];
  return { versions, total, nextBefore: start > 0 ? start : null };
}

// ─── Tags ────────────────────────────────────────────────────────────────────

/** Resolve a tag. `"latest"` is virtual and always resolves to the head. */
export async function readTag(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  tag: string,
): Promise<ProjectTag> {
  const [version, cid] = (await client.readContract({
    address: contracts.hook,
    abi: iProjectHookAbi,
    functionName: "getTag",
    args: [contracts.collection, tokenId, tag],
  })) as [bigint, Hex];

  return { tag, version: Number(version), cid: asAbxfsCid(cid) };
}

export interface TagPage {
  tags: string[];
  /** Total tags on the token. */
  total: number;
  /** Pass as `before` for the next-older page, or `null` at the first tag. */
  nextBefore: number | null;
}

/**
 * One bounded page of tag names (newest page first; `before` is an exclusive 0-based index). Excludes
 * the virtual `"latest"`. Uses `tagCount` + `getTagsRange` rather than the unbounded `listTags`, which
 * a hostile previous owner can grow until it exceeds an `eth_call`. The count and the range are read at one block:
 * `removeTag` is a swap-and-pop, so a range read after a removal the count did not see is another list.
 */
export async function readTagPage(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  opts: { before?: number; limit?: number } = {},
): Promise<TagPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? HISTORY_PAGE_SIZE, 1000));
  const block = await snapshotBlock(client);
  const total = Number(
    await readAtBlock<bigint>(
      client,
      { address: contracts.hook, abi: iProjectHookAbi, functionName: "tagCount", args: [contracts.collection, tokenId] },
      block,
    ),
  );
  const end = Math.min(opts.before ?? total, total);
  const start = Math.max(0, end - limit);
  const tags =
    end > start
      ? await readAtBlock<string[]>(
          client,
          {
            address: contracts.hook,
            abi: iProjectHookAbi,
            functionName: "getTagsRange",
            args: [contracts.collection, tokenId, BigInt(start), BigInt(end)],
          },
          block,
        )
      : [];
  return { tags: [...tags], total, nextBefore: start > 0 ? start : null };
}

/** The newest page of tags (at most `limit`, default {@link HISTORY_PAGE_SIZE}). Excludes the virtual `"latest"`. */
export async function listTags(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  opts: { limit?: number } = {},
): Promise<string[]> {
  return (await readTagPage(client, contracts, tokenId, opts)).tags;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Publish a new version.
 *
 * The CID rides a `Uint256Range` scalar param, NOT `Bytes`. A `String`/`Bytes` param stores an
 * SSTORE2 blob and events only `keccak256(payload)`, which would leave the log-derived history
 * saying *when* a project republished but not *to what*. A scalar param carries the raw `bytes32`,
 * and an ABX FS root CID is exactly that.
 *
 * Reverts (from the collection, then the hook) when: the caller is not the token owner or its
 * delegate (`ParamAuth`), the CID is in neither store (`RootNotFound`), the root kind differs from
 * the project's locked kind (`RootKindLocked`), or the CID already is the head (`SameRoot`).
 */
export async function publishVersion(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  cid: AbxfsCid,
): Promise<Hex> {
  const account = requireAccount(wallet);
  return wallet.writeContract({
    address: contracts.collection,
    abi: collectionWriteAbi,
    functionName: "configureTokenParam",
    args: [tokenId, KEY_CID, cid],
    account,
    chain: wallet.chain,
  });
}

/**
 * Mint a project token in `org`, through the org's minter.
 *
 * A project comes into existence as an ABX token, and an org mints only through `OrgMinter`:
 * the org has no owner to mint directly, and the minter asks the factory who may. So this is
 * allowed for the org's admin, anyone the admin has allowed, and anyone at all if the org is open —
 * and refused before sending, with the reason, otherwise. Minting is free; a project costs gas alone.
 *
 * Minting is deliberately separate from publishing. Keeping them apart is what lets a caller publish
 * into a token they already hold or were minted, and it means "create a project" has no
 * ABX FS-specific machinery behind it beyond the minter's one permission check.
 *
 * @returns The minted token id, decoded from the receipt's `Transfer` log.
 */
export async function mintProject(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  org: Address,
  opts: { to?: Address; minter?: Address; addresses: ContractAddresses; onSent?: (hash: Hex) => void },
): Promise<{ tokenId: bigint; txHash: Hex }> {
  return mintInOrg(clients, org, opts);
}

/**
 * Wait until the hook has recorded at least `count` versions for a project.
 *
 * Tagging reads `versionCount` to resolve "the version I just published", so a lagging replica
 * makes `setTag` revert `InvalidVersion(0, 0)` against a hook that already holds version 1.
 */
export async function waitForVersion(
  client: PublicClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  count: number,
): Promise<void> {
  await settle(async () => {
    const seen = (await client.readContract({
      address: contracts.hook,
      abi: iProjectHookAbi,
      functionName: "versionCount",
      args: [contracts.collection, tokenId],
    })) as bigint;
    return seen >= BigInt(count);
  });
}

/** Set `abxfs.name`. Metadata only — never an identifier, and not unique. */
export async function setProjectName(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  name: string,
): Promise<Hex> {
  assertValidPublishInputs({ name });
  return writeDataParam(wallet, contracts.collection, tokenId, KEY_NAME, name);
}

/**
 * Set `abxfs.gateway` — the owner's preferred IPFS gateway prefix for this project.
 *
 * Optional by design. Content lives on-chain regardless; this only tells a gateway where to look
 * first before falling back to rebuilding from chain. Pass an empty string to clear it.
 */
export async function setPreferredGateway(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  gateway: string,
): Promise<Hex> {
  if (gateway !== "") {
    const problem = externalUrlProblem(gateway);
    if (problem) throw new Error(`refusing to set abxfs.gateway: ${problem}`);
  }
  return writeDataParam(wallet, contracts.collection, tokenId, KEY_GATEWAY, gateway === "" ? CLEARED_PARAM_VALUE : gateway);
}

/**
 * What "unset" is written as. ABX refuses an empty value (`InvalidParamValue`), and its `clearTokenParam`
 * is not callable by a token owner, so a `TokenOwner` string param cannot be set back to nothing.
 * `-` is not a URL, so both consumers treat it as unset: the links renderer falls back to the default
 * and the gateway ignores it. {@link readProject} reports it as `null`.
 */
export const CLEARED_PARAM_VALUE = "-";

/** The longest `abxfs.view` the hook accepts, in bytes. */
export const MAX_VIEW_URL_BYTES = 512;

/** The visible ASCII characters `ProjectLinks` refuses in an `abxfs.view` (see {@link isUsableViewUrl}). */
const VIEW_URL_REFUSED = "\"&'()<>[\\]^`{|}";

/**
 * Whether a token would emit `url` as its `animation_url` / `external_url`. This mirrors
 * `ProjectLinks` exactly, because a value it refuses is silently replaced by the default and
 * the owner would otherwise save something that does nothing.
 *
 * `https://` followed by visible ASCII, at most 512 bytes, with none of `" ' & < > \\` and the backtick
 * (JSON and markup breakers), `{ } | ^` (not allowed in a URI at all) or `( ) [ ]` (they end a Markdown
 * link or a CSS `url()`): the owner writes this value and a marketplace dereferences or embeds it, so it
 * must not be able to leave the string it sits in, or be `javascript:` or `data:`. Every refused character,
 * and every non-ASCII host or path, can be written percent-encoded (or as punycode).
 */
export function isUsableViewUrl(url: string): boolean {
  if (url.length < 9 || url.length > MAX_VIEW_URL_BYTES) return false;
  if (!url.startsWith("https://")) return false;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
    if (VIEW_URL_REFUSED.includes(url[i]!)) return false;
  }
  return true;
}

/**
 * Why a client must not SAVE `url` as `abxfs.view`, or `null` when it may.
 *
 * {@link isUsableViewUrl} mirrors what the frozen on-chain renderer will emit, and the renderer accepts
 * userinfo (`https://opensea.io@evil.example/`), a bare IP and so on. It cannot change, so the client is the
 * only guard: this is `isUsableViewUrl` AND {@link externalUrlProblem} (https, no credentials, no private
 * address). Punycode lookalike hosts pass here and are the caller's to confirm (see `hasLookalikeHost`).
 */
export function viewUrlProblem(url: string): string | null {
  if (!isUsableViewUrl(url)) {
    return "must be a full https:// URL of visible ASCII (at most 512 bytes, none of \" ' & ( ) < > [ \\ ] ^ ` { | }: write those percent-encoded)";
  }
  return externalUrlProblem(url);
}

/**
 * Set `abxfs.view` — where this project's token links point, on marketplaces.
 *
 * Pass the WHOLE URL, which is used as is: your own gateway, a domain, a single-project host. Pass an
 * empty string to clear it (written as `-`, see {@link CLEARED_PARAM_VALUE}) and fall back to the default on the ABX FS site. Throws, before sending
 * anything, for a value the token would not emit (see {@link isUsableViewUrl}).
 */
export async function setViewUrl(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  url: string,
): Promise<Hex> {
  if (url !== "" && !isUsableViewUrl(url)) {
    throw new Error(
      "a view URL must be https://, at most 512 bytes of visible ASCII, with none of \" ' & ( ) < > [ \\ ] ^ ` { | } " +
        "(write non-ASCII hosts as punycode and paths percent-encoded)",
    );
  }
  if (url !== "") {
    const problem = viewUrlProblem(url);
    if (problem) throw new Error(`refusing to set abxfs.view: ${problem}`);
  }
  return writeDataParam(wallet, contracts.collection, tokenId, KEY_VIEW, url === "" ? CLEARED_PARAM_VALUE : url);
}

async function writeDataParam(
  wallet: WalletClient,
  collection: Address,
  tokenId: bigint,
  key: Hex,
  value: string,
): Promise<Hex> {
  const account = requireAccount(wallet);

  const bytes = new TextEncoder().encode(value);
  const hex = (`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`) as Hex;

  return wallet.writeContract({
    address: collection,
    abi: collectionWriteAbi,
    functionName: "configureTokenParamData",
    args: [tokenId, key, hex],
    account,
    chain: wallet.chain,
  });
}

/** Point a tag at a version. Token-owner only, enforced by the hook against `ownerOf`. */
export async function setTag(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  tag: string,
  version: number,
): Promise<Hex> {
  const account = requireAccount(wallet);
  return wallet.writeContract({
    address: contracts.hook,
    abi: iProjectHookAbi,
    functionName: "setTag",
    args: [contracts.collection, tokenId, tag, BigInt(version)],
    account,
    chain: wallet.chain,
  });
}

export async function removeTag(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  tag: string,
): Promise<Hex> {
  const account = requireAccount(wallet);
  return wallet.writeContract({
    address: contracts.hook,
    abi: iProjectHookAbi,
    functionName: "removeTag",
    args: [contracts.collection, tokenId, tag],
    account,
    chain: wallet.chain,
  });
}

/**
 * Transfer a project.
 *
 * An ERC-721 transfer, with no handshake. Pushing an unwanted project onto someone to pollute their
 * "projects owned by" view is a general NFT-spam problem that wallets and marketplaces already handle,
 * not something the protocol re-solves (the app's per-browser accept/hide covers it there).
 */
export async function transferProject(
  wallet: WalletClient,
  contracts: ProjectContracts,
  tokenId: bigint,
  to: Address,
  opts: { forbid?: readonly (string | undefined)[] } = {},
): Promise<Hex> {
  const account = requireAccount(wallet);
  // A transfer cannot be undone, and a mistyped, burn or self-referential target loses the project.
  // `forbid` carries every generation's ABX FS contracts (see `abxfsContractAddresses`).
  assertSafeRecipient(to, { forbid: [contracts.collection, contracts.hook, contracts.enumeration, ...(opts.forbid ?? [])], what: "transfer target" });
  return wallet.writeContract({
    address: contracts.collection,
    abi: seriesCodeAbi,
    functionName: "safeTransferFrom",
    args: [account.address, to, tokenId],
    account,
    chain: wallet.chain,
  });
}

/**
 * The collection's ABI plus the configure hook's errors. A param write reverts in the HOOK (`RootNotFound`,
 * `RootKindLocked`, `SameRoot`, `BlobTooLarge`, and the rest) and the collection passes the revert on unchanged, so
 * decoding against the collection's ABI alone shows a raw selector where the reason belongs.
 */
export const collectionWriteAbi = [...seriesCodeAbi, ...iProjectHookAbi.filter((e) => e.type === "error")] as const;

function requireAccount(wallet: WalletClient) {
  const account = wallet.account;
  if (!account) throw new Error("wallet client has no account — pass one when creating the client");
  return account;
}

// ─── State-backed enumeration (no logs) ──────────────────────────────────────

/**
 * Addresses for the two hooks that hold ABX FS's on-chain indexes.
 *
 * `enumeration` is optional because a collection can run without it — the content and project
 * layers do not depend on enumeration, and a deployment that never arms the transfer hook simply
 * has no owner index to read.
 */
export interface ProjectIndexes {
  collection: Address;
  /** `ProjectHook` — version history, tags, and the publish ledger. */
  hook: Address;
  /** `ProjectEnumeration` — the transfer hook holding owner→tokens. */
  enumeration?: Address;
}

/** One entry in a collection's append-only publish ledger. */
export interface PublishRecord {
  tokenId: bigint;
  cid: AbxfsCid;
  publisher: Address;
  /** Seconds since the Unix epoch, as recorded on-chain. */
  publishedAt: number;
  /** The token's own 1-based version number for this publish. */
  version: number;
}

interface RawPublishRecord {
  cid: `0x${string}`;
  publisher: Address;
  publishedAt: number | bigint;
  version: number | bigint;
  tokenId: bigint;
}

function decodePublishRecord(r: RawPublishRecord): PublishRecord {
  return {
    tokenId: r.tokenId,
    cid: r.cid as AbxfsCid,
    publisher: r.publisher,
    publishedAt: Number(r.publishedAt),
    version: Number(r.version),
  };
}

/**
 * How many publishes a collection has recorded, ever.
 *
 * Also the cursor to start paging {@link readPublishFeed} from.
 */
export async function readPublishCount(
  client: PublicClient,
  contracts: Pick<ProjectIndexes, "collection" | "hook">,
): Promise<bigint> {
  return (await client.readContract({
    address: contracts.hook,
    abi: iProjectHookAbi,
    functionName: "publishCount",
    args: [contracts.collection],
  })) as bigint;
}

/**
 * The most recent publishes, newest first — read from contract state, not logs.
 *
 * This replaces an `eth_getLogs` walk that had two failure modes and hit both. It got slower every
 * day as the range from the deploy block grew, and it stopped working entirely once a provider
 * pruned past that block: public endpoints keep a rolling window (publicnode's is ~33 days), so a
 * scan anchored at deploy eventually fails with `pruned history unavailable` rather than returning
 * less. Reading the ledger is one `eth_call` against state, so neither applies.
 *
 * Pass `before` to page: give it the index of the oldest record you already have. `before` of
 * `undefined` starts at the newest.
 */
export async function readPublishFeed(
  client: PublicClient,
  contracts: Pick<ProjectIndexes, "collection" | "hook">,
  opts: { limit?: number; before?: bigint } = {},
): Promise<PublishRecord[]> {
  const limit = BigInt(opts.limit ?? 20);

  const raw = (await client.readContract({
    address: contracts.hook,
    abi: iProjectHookAbi,
    functionName: opts.before === undefined ? "recentPublishes" : "recentPublishesBefore",
    args:
      opts.before === undefined
        ? [contracts.collection, limit]
        : [contracts.collection, opts.before, limit],
  })) as readonly RawPublishRecord[];

  return raw.map(decodePublishRecord);
}

/**
 * The most recently published DISTINCT projects, newest first.
 *
 * The ledger is raw history, so a project that republishes appears once per publish. A feed wants
 * one row per project, which means reading back until enough distinct ids accumulate. That is the
 * same shape as the old log walk and deliberately so — what changed is the cost of a step. Reading
 * a few hundred ledger rows is one `eth_call`; the log version paid a network round trip per
 * window and measured 273 seconds against a collection with two projects, because the early exit
 * could never be satisfied.
 *
 * `maxScan` bounds the work for a collection where a handful of projects publish constantly: past
 * that many records it returns what it found rather than reading the whole ledger.
 */
export async function readRecentProjects(
  client: PublicClient,
  contracts: Pick<ProjectIndexes, "collection" | "hook">,
  opts: { limit?: number; maxScan?: number } = {},
): Promise<PublishRecord[]> {
  const limit = opts.limit ?? 20;
  const maxScan = opts.maxScan ?? 500;
  const page = 100n;

  let cursor = await readPublishCount(client, contracts);
  const seen = new Set<string>();
  const out: PublishRecord[] = [];
  let scanned = 0;

  while (cursor > 0n && out.length < limit && scanned < maxScan) {
    const batch = await readPublishFeed(client, contracts, {
      limit: Number(page),
      before: cursor,
    });
    if (batch.length === 0) break;

    for (const record of batch) {
      scanned++;
      const key = record.tokenId.toString();
      if (seen.has(key)) continue; // an older publish by a project already in the feed
      seen.add(key);
      out.push(record);
      if (out.length >= limit) break;
    }
    cursor -= BigInt(batch.length);
  }

  return out;
}

/**
 * The tokens an address owns, read from the transfer hook's index.
 *
 * ABX collections are not `ERC721Enumerable`, so the only alternative is replaying inbound
 * `Transfer` logs from the collection's deploy block — a walk that measured 221 seconds for one
 * owner and fails outright against a provider that has pruned that far back.
 *
 * Returns `undefined` when no enumeration hook is configured, which is distinct from an owner
 * holding nothing. A caller that treats the two the same reports "you own no projects" to someone
 * whose projects simply are not indexed.
 */
export async function readOwnedProjects(
  client: PublicClient,
  contracts: ProjectIndexes,
  owner: Address,
): Promise<bigint[] | undefined> {
  if (!contracts.enumeration) return undefined;

  // Paged: `tokensOfOwner` is unbounded, and a wallet can hold any number of unsolicited tokens.
  const out: bigint[] = [];
  for await (const tokenId of iterateOwnedProjects(client, contracts, owner, { pageSize: 200 })) {
    out.push(tokenId);
    if (out.length >= MAX_OWNED_PROJECTS) break;
  }
  return out;
}

/**
 * Tokens this address holds that were minted and NEVER published to (no head, no version), newest first.
 *
 * Asked BEFORE a mint: a second mint beside an empty project the account already holds just leaves two empty
 * shells. Looks at the newest `scan` (default 100) tokens the account holds in the org, so the answer is
 * bounded however many unsolicited tokens a wallet has been sent. `undefined` when no enumeration hook is
 * configured (cannot tell, which is not the same as "none").
 */
export async function readEmptyOwnedProjects(
  client: PublicClient,
  contracts: ProjectIndexes,
  owner: Address,
  opts: { limit?: number; scan?: number } = {},
): Promise<bigint[] | undefined> {
  if (!contracts.enumeration) return undefined;
  const scan = BigInt(opts.scan ?? 100);
  const limit = opts.limit ?? 5;
  // One block for the balance, the slice and the reads of each token (`tokensOfOwnerSlice` is swap-and-pop).
  const block = await snapshotBlock(client);
  const balance = await readAtBlock<bigint>(
    client,
    { address: contracts.enumeration, abi: iProjectEnumerationAbi, functionName: "balanceOfTracked", args: [contracts.collection, owner] },
    block,
  );
  if (balance === 0n) return [];
  const start = balance > scan ? balance - scan : 0n;
  const page = await readAtBlock<bigint[]>(
    client,
    {
      address: contracts.enumeration,
      abi: iProjectEnumerationAbi,
      functionName: "tokensOfOwnerSlice",
      args: [contracts.collection, owner, start, balance - start],
    },
    block,
  );
  const newestFirst = [...page].reverse();
  if (newestFirst.length === 0) return [];
  // ONE multicall over every id (3 reads each). Any failed read means "cannot tell", never "no empties": a
  // false "none" would let a second mint through beside an empty project the account already holds.
  let res;
  try {
    res = await client.multicall({
      contracts: newestFirst.flatMap((id) => [
        { address: contracts.collection, abi: seriesCodeAbi, functionName: "ownerOf", args: [id] } as const,
        { address: contracts.collection, abi: seriesCodeAbi, functionName: "tokenParam", args: [id, KEY_CID] } as const,
        { address: contracts.hook, abi: iProjectHookAbi, functionName: "versionCount", args: [contracts.collection, id] } as const,
      ]),
      allowFailure: true,
      ...(block !== undefined ? { blockNumber: block } : {}),
    });
  } catch {
    return undefined;
  }
  if (res.length !== newestFirst.length * 3 || res.some((r) => r.status !== "success")) return undefined;
  const out: bigint[] = [];
  for (let i = 0; i < newestFirst.length && out.length < limit; i++) {
    const o = res[i * 3]!.result as unknown;
    const cid = decodeCidParam(res[i * 3 + 1]!.result as never);
    const versions = Number(res[i * 3 + 2]!.result);
    if (typeof o === "string" && o.toLowerCase() === owner.toLowerCase() && cid === null && versions === 0) out.push(newestFirst[i]!);
  }
  return out;
}

/** The most tokens {@link readOwnedProjects} returns; use {@link iterateOwnedProjects} for more. */
export const MAX_OWNED_PROJECTS = 5000;

/**
 * A window of an org's tokens: ids `start` to `start + limit - 1`, clamped to the org's last token.
 *
 * An org numbers its tokens 0, 1, 2, … in mint order and nothing in it can be burned, so its tokens are
 * exactly `0 … nextTokenId() - 1`, which the collection itself answers ({@link readTrackedCount}); no index
 * keeps a copy. Returns `undefined` when no enumeration hook is configured (not an org context), for the
 * same reason {@link readOwnedProjects} does.
 */
export async function readTrackedTokens(
  client: PublicClient,
  contracts: ProjectIndexes,
  opts: { start?: bigint; limit?: number } = {},
): Promise<bigint[] | undefined> {
  const count = await readTrackedCount(client, contracts);
  if (count === undefined) return undefined;
  const start = opts.start ?? 0n;
  const limit = BigInt(opts.limit ?? 1000);
  if (start >= count || limit <= 0n) return [];
  const end = start + limit > count ? count : start + limit;
  const ids: bigint[] = [];
  for (let id = start; id < end; id++) ids.push(id);
  return ids;
}

/**
 * How many tokens an org has: its `nextTokenId()`, the ids `0 … count - 1` (see {@link readTrackedTokens}).
 *
 * Together with {@link readTrackedTokens} this pages an org newest-first: ids are in mint order, so the
 * newest `n` start at `count - n`. Returns `undefined` when no enumeration hook is configured, for the
 * same reason {@link readOwnedProjects} does.
 */
export async function readTrackedCount(
  client: PublicClient,
  contracts: ProjectIndexes,
): Promise<bigint | undefined> {
  if (!contracts.enumeration) return undefined;

  return (await client.readContract({
    address: contracts.collection,
    abi: seriesCodeAbi,
    functionName: "nextTokenId",
  })) as bigint;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

/** One page of ledger records, plus the cursor to continue from. */
export interface PublishPage {
  records: PublishRecord[];
  /**
   * Cursor for the next (older) page, or `undefined` when the ledger is exhausted.
   *
   * Pass it back as `before`. It is a ledger index, and the ledger is append-only, so a cursor
   * stays valid indefinitely — new publishes append above it and never renumber what is below.
   * That is what makes it safe to persist a cursor across sessions.
   */
  nextCursor?: bigint;
  /** Total ledger length at the time the page was read. */
  total: bigint;
}

/**
 * One page of the publish ledger, newest first, with a cursor.
 *
 * Prefer this to calling {@link readPublishFeed} and tracking indexes by hand — getting the cursor
 * arithmetic wrong is how a feed repeats or skips rows, and the fix belongs in one place.
 */
export async function readPublishPage(
  client: PublicClient,
  contracts: Pick<ProjectIndexes, "collection" | "hook">,
  opts: { limit?: number; before?: bigint } = {},
): Promise<PublishPage> {
  const limit = opts.limit ?? 20;
  const total = await readPublishCount(client, contracts);
  const cursor = opts.before ?? total;

  if (cursor === 0n) return { records: [], total };

  const records = await readPublishFeed(client, contracts, { limit, before: cursor });
  const next = cursor - BigInt(records.length);

  return {
    records,
    total,
    ...(next > 0n && records.length > 0 ? { nextCursor: next } : {}),
  };
}

/**
 * Walk the entire publish ledger, oldest first, a page at a time.
 *
 * An async generator rather than an array: a ledger is unbounded by design, and a caller that wants
 * "every publish ever" should be able to process it without holding all of it in memory. Callers
 * that do want an array can spread it.
 */
export async function* iteratePublishLedger(
  client: PublicClient,
  contracts: Pick<ProjectIndexes, "collection" | "hook">,
  opts: { pageSize?: number } = {},
): AsyncGenerator<PublishRecord, void, undefined> {
  const pageSize = BigInt(opts.pageSize ?? 100);
  const total = await readPublishCount(client, contracts);

  for (let start = 0n; start < total; start += pageSize) {
    const raw = (await client.readContract({
      address: contracts.hook,
      abi: iProjectHookAbi,
      functionName: "publishRange",
      args: [contracts.collection, start, pageSize],
    })) as readonly RawPublishRecord[];

    if (raw.length === 0) return;
    for (const record of raw) yield decodePublishRecord(record);
  }
}

/**
 * Walk every token an address owns, a page at a time.
 *
 * {@link readOwnedProjects} returns the whole set in one call, which is the right default at the
 * sizes ABX FS projects reach. This exists for the case where it is not: a single `eth_call` has a
 * response-size ceiling, and an address holding tens of thousands of tokens would hit it.
 *
 * Yields nothing when no enumeration hook is configured. Callers that must distinguish that from
 * "owns nothing" should check {@link readOwnedProjects} for `undefined` first.
 *
 * The walk reads every page at ONE block (the one current when it starts; see `snapshot.ts`), so it is the list as it
 * was then. A page is read only when the consumer asks for the next token past the previous page, so a consumer that
 * pauses mid-walk for longer than its node keeps state for old blocks (a non-archive node keeps about 128 blocks:
 * minutes on most chains) gets an error at the next page, not a shorter list. Pull the whole walk promptly, or start
 * a new one.
 */
export async function* iterateOwnedProjects(
  client: PublicClient,
  contracts: ProjectIndexes,
  owner: Address,
  opts: { pageSize?: number } = {},
): AsyncGenerator<bigint, void, undefined> {
  if (!contracts.enumeration) return;

  const pageSize = BigInt(checkCount(opts.pageSize ?? 500, "pageSize", 1));
  // The balance and every page at one block: a transfer out is a swap-and-pop on this list, so pages read either
  // side of it would skip one token and repeat another.
  const block = await snapshotBlock(client);
  const balance = await readAtBlock<bigint>(
    client,
    { address: contracts.enumeration, abi: iProjectEnumerationAbi, functionName: "balanceOfTracked", args: [contracts.collection, owner] },
    block,
  );

  for (let start = 0n; start < balance; start += pageSize) {
    const page = await readAtBlock<bigint[]>(
      client,
      {
        address: contracts.enumeration,
        abi: iProjectEnumerationAbi,
        functionName: "tokensOfOwnerSlice",
        args: [contracts.collection, owner, start, pageSize],
      },
      block,
    );

    if (page.length === 0) return;
    for (const tokenId of page) yield tokenId;
  }
}
