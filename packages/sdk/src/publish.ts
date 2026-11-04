/**
 * Publish a root and (optionally) tag it. THE one implementation.
 *
 * The SDK draft path, `abxfs upload --project-id --tag` and `abxfs update --tag` all call
 * {@link publishRootAndTag}, so a fix to the publish-and-tag race (a stale `versionCount` makes
 * `setTag(…, n-1)` a perfectly legal call that points the tag at the PREVIOUS version) lands
 * everywhere at once. Do not add a second path: fix it here.
 *
 * The rule: a tag is written only against a version whose recorded CID, read back through a settled
 * read, equals the root this call just published. Anything weaker (a count, arithmetic, "at least 1")
 * can be stale and fails silently.
 */
import { parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { iProjectHookAbi } from "./abi-hook.js";
import { publishVersion, setTag, type ProjectContracts } from "./project.js";
import { waitForSuccessfulReceipt } from "./receipts.js";
import { settle } from "./settle.js";
import { assertValidPublishInputs } from "./validate.js";
import type { AbxfsCid } from "./types.js";
import { assertWalletChain } from "./wallet-chain.js";

export type PublishAndTagPhase = "publishing-version" | "setting-tag";

/** The most history reads the no-event fallback makes per attempt. */
export const MAX_FALLBACK_SCAN = 50;

export interface SettleOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Work out which version number `rootCid` was recorded as, and PROVE it with a read.
 *
 * `receiptVersion` (from the publish transaction's own `ProjectVersionPublished` event) is preferred.
 * Without it, the history is polled until a version above `countBefore` carries `rootCid`. Either way
 * the answer is returned only once `readCid(version) === rootCid`; otherwise this throws and the
 * caller must not tag.
 */
export async function resolvePublishedVersion(args: {
  countBefore: bigint;
  rootCid: AbxfsCid;
  readCount: () => Promise<bigint>;
  readCid: (version: bigint) => Promise<AbxfsCid>;
  receiptVersion?: bigint;
  settleOpts?: SettleOptions;
}): Promise<bigint> {
  const { countBefore, rootCid, readCount, readCid, receiptVersion, settleOpts } = args;
  let found: bigint | undefined;

  if (receiptVersion !== undefined) {
    if (receiptVersion < 1n) throw new Error(`publish receipt named invalid version ${receiptVersion}`);
    // A publish appends: the version it created is necessarily newer than the count read BEFORE it was
    // sent. An event naming an older one (a forged or replayed receipt) can never be the version we made.
    if (receiptVersion <= countBefore) {
      throw new Error(
        `publish receipt named version ${receiptVersion}, which is not newer than the ${countBefore} versions ` +
          "that existed before it was sent. Nothing was tagged. Check `abxfs info` and tag the right version by hand.",
      );
    }
    const ok = await settle(async () => sameCid(await readCid(receiptVersion), rootCid), settleOpts);
    if (ok) found = receiptVersion;
  } else {
    await settle(async () => {
      const count = await readCount();
      if (count <= countBefore) return false;
      // Newest first: the one just published is the newest copy of this root. Bounded: a hostile RPC
      // can report any count, and an honest publish adds one (a few when other tabs publish alongside).
      const floor = count - countBefore > BigInt(MAX_FALLBACK_SCAN) ? count - BigInt(MAX_FALLBACK_SCAN) : countBefore;
      for (let v = count; v > floor; v -= 1n) {
        if (sameCid(await readCid(v), rootCid)) {
          found = v;
          return true;
        }
      }
      return false;
    }, settleOpts);
  }

  if (found === undefined) {
    throw new Error(
      `published ${rootCid}, but could not confirm which version recorded it (the history never showed ` +
        "that root after the publish). Nothing was tagged. Check `abxfs info` and tag the right version by hand.",
    );
  }
  return found;
}

function sameCid(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Read `versionCount` with a few tries. Throws rather than guessing: the caller has not published yet. */
async function readCountBefore(read: () => Promise<bigint>, settleOpts?: SettleOptions): Promise<bigint> {
  let value: bigint | undefined;
  await settle(async () => {
    value = await read();
    return true;
  }, { attempts: 3, delayMs: 500, ...settleOpts });
  if (value === undefined) {
    throw new Error(
      "cannot read the project's current version count; refusing to publish blind. Nothing was sent. " +
        "Check the RPC endpoint and try again.",
    );
  }
  return value;
}

export interface PublishAndTagResult {
  publishTxHash: Hex;
  tagTxHash?: Hex;
  /** Proven: `versionAt(versionNumber).cid === rootCid` was read back. */
  versionNumber: bigint;
}

export async function publishRootAndTag(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  project: ProjectContracts,
  tokenId: bigint,
  rootCid: AbxfsCid,
  opts: { tag?: string; onPhase?: (phase: PublishAndTagPhase) => void; settleOpts?: SettleOptions } = {},
  txHashes: Hex[] = [],
): Promise<PublishAndTagResult> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  const readCount = async (): Promise<bigint> =>
    (await clients.publicClient.readContract({
      address: project.hook,
      abi: iProjectHookAbi,
      functionName: "versionCount",
      args: [project.collection, tokenId],
    })) as bigint;

  const readCid = async (version: bigint): Promise<AbxfsCid> => {
    const record = await clients.publicClient.readContract({
      address: project.hook,
      abi: iProjectHookAbi,
      functionName: "versionAt",
      args: [project.collection, tokenId, version],
    });
    return record.cid as AbxfsCid;
  };

  // Before ANY write: a tag that the hook would refuse must not be discovered after the publish was paid for.
  assertValidPublishInputs({ tag: opts.tag });

  // Before ANY write. If this cannot be read, nothing has been spent and nothing can be mislabelled.
  const countBefore = await readCountBefore(readCount, opts.settleOpts);

  opts.onPhase?.("publishing-version");
  const publishTxHash = await publishVersion(clients.walletClient, project, tokenId, rootCid);
  txHashes.push(publishTxHash);
  const receipt = await waitForSuccessfulReceipt(clients.publicClient, publishTxHash, "publish");

  const versionNumber = await resolvePublishedVersion({
    countBefore,
    rootCid,
    readCount,
    readCid,
    ...versionFromReceipt(receipt.logs, project.hook, project.collection, tokenId, rootCid),
    ...(opts.settleOpts ? { settleOpts: opts.settleOpts } : {}),
  });

  let tagTxHash: Hex | undefined;
  if (opts.tag) {
    opts.onPhase?.("setting-tag");
    tagTxHash = await setTag(clients.walletClient, project, tokenId, opts.tag, Number(versionNumber));
    txHashes.push(tagTxHash);
    await waitForSuccessfulReceipt(clients.publicClient, tagTxHash, "setTag");
  }
  return { publishTxHash, ...(tagTxHash ? { tagTxHash } : {}), versionNumber };
}

/** The version the hook's own event reported for this publish, if the receipt carries one. */
function versionFromReceipt(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  hook: Address,
  collection: Address,
  tokenId: bigint,
  rootCid: AbxfsCid,
): { receiptVersion?: bigint } {
  try {
    const events = parseEventLogs({
      abi: iProjectHookAbi,
      eventName: "ProjectVersionPublished",
      logs: logs as never,
    });
    const mine = events.filter(
      (e) =>
        e.address.toLowerCase() === hook.toLowerCase() &&
        (e.args.token as Address).toLowerCase() === collection.toLowerCase() &&
        e.args.tokenId === tokenId &&
        (e.args.cid as string).toLowerCase() === rootCid.toLowerCase(),
    );
    const last = mine[mine.length - 1];
    return last ? { receiptVersion: last.args.version as bigint } : {};
  } catch {
    return {};
  }
}
