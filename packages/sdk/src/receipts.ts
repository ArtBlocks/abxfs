/**
 * Receipt checks.
 *
 * `waitForTransactionReceipt` resolves for a transaction that was MINED, including one that
 * reverted. Nothing in viem throws on `status: "reverted"`, so every caller that only awaited it
 * reported success for a failed write. All waits in the SDK go through here.
 */
import {
  BaseError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

/**
 * Whether `err` is the person declining a request in their wallet (EIP-1193 code 4001, which viem raises as
 * `UserRejectedRequestError`), anywhere in its cause chain. That is a cancellation, not a failure, and is shown as
 * one. Decided by type and code, never by message text.
 */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 10; depth++) {
    if ((e as { code?: unknown }).code === 4001) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Thrown when a transaction was mined but reverted. */
export class TransactionRevertedError extends Error {
  readonly hash: Hex;
  constructor(hash: Hex, what?: string) {
    super(`${what ?? "transaction"} reverted on chain (${hash})`);
    this.name = "TransactionRevertedError";
    this.hash = hash;
  }
}

/** Throw unless `receipt.status` is exactly `"success"`. */
export function assertReceiptSuccess<T extends { status: string }>(
  receipt: T,
  hash: Hex,
  what?: string,
): T {
  if (receipt.status !== "success") throw new TransactionRevertedError(hash, what);
  return receipt;
}

/** Wait for a receipt and throw if the transaction reverted. Returns the receipt. */
export async function waitForSuccessfulReceipt(
  client: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: Hex,
  what?: string,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash });
  } catch (err) {
    if (isReceiptTimeout(err) && !(err instanceof TransactionTimeoutError)) {
      throw new TransactionTimeoutError(hash, what, explorerTxUrl(client, hash));
    }
    throw err;
  }
  return assertReceiptSuccess(receipt, hash, what);
}

/**
 * Thrown when no receipt arrived in time. This is NOT a failure: the transaction was sent and may still
 * confirm. Callers must not blindly retry it (a retried mint creates a second, empty project); they
 * should report the hash and check chain state before doing anything else.
 */
export class TransactionTimeoutError extends Error {
  readonly hash: Hex;
  readonly explorerUrl: string | undefined;
  constructor(hash: Hex, what?: string, explorerUrl?: string) {
    super(
      `${what ?? "transaction"} was sent but no receipt arrived in time: it may still confirm (${hash}). ` +
        `Do not resend it; check ${explorerUrl ?? "a block explorer"} once it has settled. A mint or an org creation ` +
        "that confirmed must not be repeated: recover what it made from its hash (recoverMint, recoverCreateOrg).",
    );
    this.name = "TransactionTimeoutError";
    this.hash = hash;
    this.explorerUrl = explorerUrl;
  }
}

/** `<explorer>/tx/<hash>` for the client's chain, when viem knows an explorer for it. */
export function explorerTxUrl(client: unknown, hash: Hex): string | undefined {
  const base = (client as { chain?: { blockExplorers?: { default?: { url?: string } } } }).chain?.blockExplorers?.default?.url;
  return base ? `${base.replace(/\/+$/, "")}/tx/${hash}` : undefined;
}

/** Whether `err` is viem's receipt timeout (or already our wrapper of it). */
export function isReceiptTimeout(err: unknown): boolean {
  return err instanceof TransactionTimeoutError || err instanceof WaitForTransactionReceiptTimeoutError ||
    (err instanceof Error && err.name === "WaitForTransactionReceiptTimeoutError");
}
