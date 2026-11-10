/**
 * Reading a paged list at one block.
 *
 * Several on-chain lists the SDK pages are kept by swap-and-pop: an admin's orgs (`orgsAdministeredSlice`), an owner's
 * orgs (`orgsHeldSlice`) and tokens (`tokensOfOwnerSlice`), a token's tags (`getTagsRange`). Removing an entry moves the
 * LAST entry into its place, so a pager that reads page 1 before a removal and page 2 after it skips the moved entry and
 * can repeat another. Reading every page (and the count it pages against) at the block the first read used makes the
 * pages one consistent list.
 */
import type { PublicClient } from "viem";

import { isRevertFailure, isTransportFailure } from "./multicall.js";

/**
 * The block to read a paged list at: the node's current block number, or `undefined` (read at "latest", as before)
 * for a client that cannot say, such as a test double with no `getBlockNumber`.
 */
export async function snapshotBlock(client: PublicClient, options?: { fresh?: boolean }): Promise<bigint | undefined> {
  const get = (client as { getBlockNumber?: PublicClient["getBlockNumber"] }).getBlockNumber;
  if (typeof get !== "function") return undefined;
  // Interactive previews after a confirmed write must not pin viem's cached pre-write block.
  return options?.fresh ? get.call(client, { cacheTime: 0 }) : get.call(client);
}

/** Attempts at a pinned block before its error stands, and the wait between them. Mutable only for tests. */
export const pinnedReadPolicy = { attempts: 4, delayMs: 500 };

/**
 * `readContract` at `blockNumber` (at "latest" when it is undefined).
 *
 * A load-balanced RPC can send this read to a replica that has not yet seen the block another replica just reported,
 * and it then answers with an error rather than data (`-32000 header not found`, or the same words as a `-32603`).
 * That is waited out, a few times, like `settle.ts` waits out replica lag; a revert ({@link isRevertFailure}, the same
 * rule every reader uses) or a failure of the connection is thrown at once. viem's `ContractFunctionRevertedError` is
 * not a revert on its own: viem builds one for any `-32603` with a message, a lagging replica's included.
 */
export async function readAtBlock<T>(
  client: PublicClient,
  params: Parameters<PublicClient["readContract"]>[0],
  blockNumber: bigint | undefined,
): Promise<T> {
  if (blockNumber === undefined) return (await client.readContract(params)) as T;
  for (let attempt = 1; ; attempt++) {
    try {
      return (await client.readContract({ ...params, blockNumber } as never)) as T;
    } catch (err) {
      if (isRevertFailure(err) || isTransportFailure(err) || attempt >= pinnedReadPolicy.attempts) throw err;
      await new Promise((r) => setTimeout(r, pinnedReadPolicy.delayMs));
    }
  }
}

/** A list read in pages that may stop at a cap: `truncated` says the chain holds more than was returned. */
export type CappedList<T> = T[] & { readonly truncated?: boolean };

/**
 * `list` with a non-enumerable `truncated` flag: an array everywhere it was one (spreads, equality, JSON), and a caller
 * that wants to know whether the cap cut it short can ask.
 */
export function capped<T>(list: T[], truncated: boolean): CappedList<T> {
  Object.defineProperty(list, "truncated", { value: truncated, enumerable: false });
  return list as CappedList<T>;
}

/** A page size or cap from a caller: refused unless it is an integer in range, so no loop can spin on 0 or NaN. */
export function checkCount(value: number, name: string, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer of at least ${min} (got ${value})`);
  return value;
}
