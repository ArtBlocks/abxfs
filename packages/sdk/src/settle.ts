/**
 * Waiting for a write to become visible to reads.
 *
 * A transaction receipt proves a write was mined. It does not prove that the node answering your
 * next `eth_call` has it. Public RPC endpoints are load balanced across replicas that lag each
 * other by a block or two, so `waitForTransactionReceipt` routinely returns and the immediately
 * following read lands somewhere that has not caught up.
 *
 * That is invisible until one write depends on another, which in ABX FS is constant — and it
 * surfaces as a revert blaming the caller for something demonstrably true. All four of these were
 * observed on Base Sepolia while publishing a three-file project:
 *
 *   - `ChunkMissing` from `createFile`, for chunks confirmed present one call later.
 *   - `CidNotFound` from `createDirectory`, for a child directory confirmed present.
 *   - `NotParamAuthorized` from a publish, for a token the sender had just minted and did own.
 *   - `InvalidVersion(0, 0)` from `setTag`, against a hook that had already recorded version 1.
 *
 * Retrying the failed write would also work, but it is the worse shape: the operation knows exactly
 * what it just wrote, so it can confirm that rather than infer the cause from a revert — and a
 * retry loop around a write risks sending twice.
 *
 * Every wait here is bounded and **non-fatal on expiry**. If reads never converge, the caller's own
 * operation produces a better error than a synthetic one invented here.
 */

/** Poll `check` until it returns true, or the attempts run out. Never throws. */
export async function settle(
  check: () => Promise<boolean>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 750;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let ok = false;
    try {
      ok = await check();
    } catch {
      // A read can revert against a replica that has not seen the state yet — `ownerOf` for an
      // unminted token, say. That is the condition being waited out, not an error.
      ok = false;
    }
    if (ok) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
