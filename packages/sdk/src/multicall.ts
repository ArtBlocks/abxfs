/**
 * Helpers for sending and decoding `Multicallable.multicall(bytes[])` transactions /
 * `eth_call`s against the ABX FS stores.
 *
 * Both write- and read-side paths use the same packer (`packBundles` from `./gas.ts`) to
 * group operations under a per-bundle gas ceiling. Reads run via `simulateContract` (no tx
 * sent), so a "bundle" of reads is effectively unlimited — the packer is still useful for
 * keeping per-call response sizes manageable on capped RPCs.
 */
import { assertReceiptSuccess, explorerTxUrl, isUserRejection, TransactionTimeoutError, waitForSuccessfulReceipt } from "./receipts.js";
import { settle } from "./settle.js";
import { mapInSlices } from "./util.js";
import {
  BaseError,
  ExecutionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
  WebSocketRequestError,
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { chunkStoreAbi } from "./abi.js";
import { GAS_ESTIMATES, packBundles, type Bundle, type BundleableCall } from "./gas.js";
import type { GasEstimate } from "./gas-schedule.js";
import { assertWalletChain } from "./wallet-chain.js";

/** How many times one bundle may be halved when the node refuses it for gas: at most 2^3 = 8 transactions in its place. */
export const MAX_BUNDLE_SPLIT_DEPTH = 3;

/**
 * Solady SSTORE2's `DeploymentFailed()`: the CREATE2 that stores a chunk or a node as code returned no address. Inside a
 * call that was simulated with too little gas, that is how running out of gas in the init code surfaces (the CREATE2
 * fails, and SSTORE2 reverts with this selector), so it carries data and still means "not enough gas".
 */
export const DEPLOYMENT_FAILED_SELECTOR = "0x30116425";

/**
 * Whether a bundle's failure, before any transaction was sent for it, may be the node refusing its GAS rather than a
 * contract refusing its calls, so that splitting it can succeed. Two shapes, both only for the content stages
 * {@link sendBundles} sends (every call there is an idempotent write: re-sending one that landed is a no-op):
 *
 *   - no revert data: an inner call that runs out of gas reverts empty through `multicall`;
 *   - exactly {@link DEPLOYMENT_FAILED_SELECTOR}: a code-storing write (a chunk through an SSTORE2 backend, any node)
 *     whose CREATE2 ran out of gas.
 *
 * Never the connection ({@link isTransportFailure}) or the person ({@link isUserRejection}). Any other revert data is a
 * contract refusing the calls, and splitting cannot help.
 */
export function isGasRefusal(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  if (isUserRejection(err) || isTransportFailure(err)) return false;
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && (e as { data: string }).data.length > 2) as
    | { data: string }
    | null;
  return !withData || withData.data.toLowerCase() === DEPLOYMENT_FAILED_SELECTOR;
}

/** The calls `[from, to)` of `b` as a bundle of their own, its estimate recomputed as the packer computes one. */
function subBundle(b: Bundle, from: number, to?: number): Bundle {
  const calls = b.calls.slice(from, to);
  let gas = GAS_ESTIMATES.multicallBase;
  let state = 0;
  for (const c of calls) {
    gas += GAS_ESTIMATES.multicallInnerDispatch + c.estimatedGas;
    state += c.estimatedStateGas ?? 0;
  }
  return { target: b.target, calls, estimatedGas: gas, ...(b.estimatedStateGas !== undefined ? { estimatedStateGas: state } : {}) };
}

/**
 * Send each bundle as a separate `multicall` transaction sequentially. Each tx is
 * simulated, submitted, and awaited before the next one starts. Returns the list of tx
 * hashes in submission order.
 *
 * The implementation deliberately serialises rather than racing transactions in parallel
 * because (a) a single signer's nonce is sequential and (b) ABX FS upload pipelines have
 * an inherent dependency ordering (chunks before createFile, leaves before parents) that
 * the packer already encodes.
 *
 * A bundle the node refuses for GAS before it is sent ({@link isGasRefusal}: its simulation or its gas estimate fails
 * with no revert data, as when a node simulates less than the SDK assumes, or a call costs more than its estimate) is
 * split in half and each half sent in its place, in order, up to {@link MAX_BUNDLE_SPLIT_DEPTH} times. The calls are
 * independent writes within a stage, so halves land the same state. `onBundleSent` fires once per transaction sent,
 * with the half it carried. A decoded revert, a failure after a hash exists, a refusal by the person and a failure of
 * the connection are never split: they are thrown.
 */
export async function sendBundles(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  bundles: Bundle[],
  abi: Abi,
  opts?: {
    onBundleSent?: (b: Bundle, i: number, txHash: Hex) => void;
    /**
     * Awaited before each bundle is simulated.
     *
     * The hook exists because bundles within one stage can depend on each other — directory
     * creation ships children before parents, and a parent in bundle 2 references a child created
     * in bundle 1. `simulateContract` below runs against whichever replica answers, which may not
     * have bundle 1 yet, and the whole bundle reverts before a transaction is ever sent. This is
     * where a caller waits for what it already sent to become visible.
     */
    beforeEachBundle?: (b: Bundle, i: number) => Promise<void>;
  },
): Promise<Hex[]> {
  assertWalletChain(clients.publicClient, clients.walletClient);
  const hashes: Hex[] = [];
  // A key held locally (a CLI, a script) signs over a load-balanced RPC whose replicas lag each other, so the nonce
  // viem would fetch for each transaction (`eth_getTransactionCount`) can come from a node that has not yet counted
  // the one just mined: the next send then reuses a nonce and fails `replacement transaction underpriced` (observed
  // on Base Sepolia behind a keyed Alchemy endpoint). So we count nonces ourselves for the whole run: read once,
  // send each transaction with an explicit, incrementing nonce, and before returning wait until the node agrees, so
  // whatever the caller sends next (the next stage, the publish) reads a correct count. A wallet that manages its own
  // nonces (a browser extension) is left alone.
  const account = clients.walletClient.account;
  const explicitNonces = account?.type === "local" && bundles.length > 0;
  const pendingCount = async (): Promise<number> =>
    clients.publicClient.getTransactionCount({ address: account!.address, blockTag: "pending" });
  // A later call in the same run (the next stage) may read a lagging replica: never go below what this process used.
  const floorKey = account ? `${clients.publicClient.chain?.id ?? 0}:${account.address.toLowerCase()}` : "";
  let nonce = explicitNonces ? Math.max(await pendingCount(), freshFloor(floorKey)) : 0;
  const firstNonce = nonce;

  const sendOne = async (b: Bundle, i: number, depth: number): Promise<void> => {
    let sent = false;
    try {
      const data = b.calls.map((c) => c.data);
      const { request } = await clients.publicClient.simulateContract({
        address: b.target,
        abi,
        functionName: "multicall",
        args: [data],
        account: clients.walletClient.account,
      });
      if (explicitNonces) {
        const tx = await sendWithFeeBumps(clients, request as Record<string, unknown>, nonce, () => (sent = true));
        hashes.push(tx);
        // Reported once, with the hash that mined (a raised-fee replacement is the same bundle, not another one).
        opts?.onBundleSent?.(b, i, tx);
      } else {
        const tx = await clients.walletClient.writeContract(request);
        sent = true;
        hashes.push(tx);
        opts?.onBundleSent?.(b, i, tx);
        await waitForSuccessfulReceipt(clients.publicClient, tx);
      }
    } catch (err) {
      if (sent || b.calls.length < 2 || depth >= MAX_BUNDLE_SPLIT_DEPTH || !isGasRefusal(err)) throw err;
      const mid = Math.ceil(b.calls.length / 2);
      await sendOne(subBundle(b, 0, mid), i, depth + 1);
      await sendOne(subBundle(b, mid), i, depth + 1);
      return;
    }
    if (explicitNonces) {
      nonce++;
      nonceFloor.set(floorKey, { nonce, at: Date.now() });
    }
  };

  for (let i = 0; i < bundles.length; i++) {
    const b = bundles[i]!;
    if (opts?.beforeEachBundle) await opts.beforeEachBundle(b, i);
    await sendOne(b, i, 0);
  }
  if (explicitNonces && nonce > firstNonce) {
    // Bounded and non-fatal like every settle: if the node never agrees, the next send's own error is the better one.
    await settle(async () => (await pendingCount()) >= nonce);
  }
  return hashes;
}

/**
 * How long one attempt may wait for a receipt before its fees are raised (Base produces a block every 2 s), and how
 * many raises there are before giving up; each doubles both fee fields (a replacement must pay at least 10% more).
 * Mutable only so tests can shorten the wait.
 */
export const feeBumpPolicy = { stallMs: 45_000, maxBumps: 3 };

/**
 * Send one transaction at an explicit nonce and wait for it, raising its fees if it stalls.
 *
 * A content transaction carries up to ~100 KB of calldata. When the sequencer throttles data-heavy transactions
 * (observed on Base Sepolia: a 43 KB chunk bundle at a 0.001 gwei tip sat unmined for minutes while the base fee was
 * well under its cap), the transaction waits in the mempool, and re-running cannot help: the re-run builds the same
 * nonce at the same fee and the node refuses it as an underpriced replacement. So a stalled send is REPLACED: the
 * same call, the same nonce, both fee fields doubled, up to {@link MAX_FEE_BUMPS} times. Every hash sent is watched,
 * because whichever one mines settles the nonce. Only a locally held key does this (its nonce is ours to manage); a
 * browser wallet keeps its own nonce and its own fee UI.
 */
async function sendWithFeeBumps(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  request: Record<string, unknown>,
  nonce: number,
  onSent?: () => void,
): Promise<Hex> {
  const sent: Hex[] = [];
  let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {};
  for (let attempt = 0; ; attempt++) {
    try {
      const hash = await clients.walletClient.writeContract({ ...request, nonce, ...fees } as never);
      sent.push(hash);
      onSent?.();
    } catch (err) {
      // The first send failing is an ordinary error. A REPLACEMENT failing (the nonce already spent by an earlier
      // attempt, a fee guard refusing the raised fee, a flaky node) never abandons what is in flight: an earlier
      // attempt may still mine, so keep watching it, and if nothing does, the timeout below names its hash.
      if (sent.length === 0) throw err;
    }
    const last = attempt >= feeBumpPolicy.maxBumps;
    const mined = await firstMined(clients.publicClient, sent, last ? feeBumpPolicy.stallMs * 4 : feeBumpPolicy.stallMs);
    if (mined) {
      assertReceiptSuccess(mined.receipt, mined.hash, "multicall bundle");
      return mined.hash;
    }
    if (last) throw new TransactionTimeoutError(sent[sent.length - 1]!, "multicall bundle", explorerTxUrl(clients.publicClient, sent[sent.length - 1]!));
    fees = await raisedFees(clients.publicClient, sent[sent.length - 1]!, fees);
  }
}

/** Double the fees the last attempt paid (read from the node, or remembered, or estimated fresh if neither). */
async function raisedFees(
  client: PublicClient,
  hash: Hex,
  previous: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  let tip = previous.maxPriorityFeePerGas;
  let cap = previous.maxFeePerGas;
  try {
    const tx = await client.getTransaction({ hash });
    tip = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? tip;
    cap = tx.maxFeePerGas ?? tx.gasPrice ?? cap;
  } catch {
    // A lagging replica may not know the transaction yet.
  }
  if (tip === undefined || cap === undefined) {
    const est = await client.estimateFeesPerGas();
    tip ??= est.maxPriorityFeePerGas ?? 1_000_000n;
    cap ??= est.maxFeePerGas ?? tip * 2n;
  }
  return { maxPriorityFeePerGas: tip * 2n, maxFeePerGas: (cap > tip ? cap : tip) * 2n };
}

/**
 * The first of `hashes` to have a receipt within `timeoutMs`, null if none did. Polled once a second, or at the client's
 * own polling interval when that is shorter: a local node mines at once, and a second per bundle is then most of a write.
 */
async function firstMined(
  client: PublicClient,
  hashes: Hex[],
  timeoutMs: number,
): Promise<{ hash: Hex; receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> } | null> {
  const deadline = Date.now() + timeoutMs;
  const every = Math.min(1000, client.pollingInterval || 1000); // a client without one (a stand-in) waits a second
  for (;;) {
    for (const hash of hashes) {
      try {
        return { hash, receipt: await client.getTransactionReceipt({ hash }) };
      } catch {
        // not mined yet (or not visible on this replica yet)
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(every, Math.max(0, deadline - Date.now()))));
  }
}


/** Next nonce this process will use per chain and address; see `sendBundles`. */
const nonceFloor = new Map<string, { nonce: number; at: number }>();
/** Only recent: replicas catch up within seconds, and an old floor must not outlive a chain reset. */
const freshFloor = (key: string): number => {
  const f = nonceFloor.get(key);
  return f && Date.now() - f.at < 60_000 ? f.nonce : 0;
};

/**
 * Run a single `multicall(bytes[])` `eth_call` (no transaction submitted) and decode each
 * inner returndata against the supplied ABI + function name. Used for batched read-only
 * paths like the verify-chunks reader in `read.ts`.
 *
 * `target` and `functionName` are the same for every inner call — use this when paginating
 * a single view (e.g. `ChunkStore.read` over N chunk ids). Use `multicallReadHetero`
 * for mixed-function batches.
 */
export async function multicallReadHomogeneous<T>(
  publicClient: PublicClient,
  abi: Abi,
  target: Hex,
  functionName: string,
  argsList: readonly unknown[][],
): Promise<T[]> {
  if (argsList.length === 0) return [];
  const data = argsList.map(
    (args) => encodeFunctionData({ abi, functionName, args }) as Hex,
  );
  const { result } = await publicClient.simulateContract({
    address: target as `0x${string}`,
    abi: [...abi, multicallAbiEntry()] as Abi,
    functionName: "multicall",
    args: [data],
  });
  const results = result as readonly Hex[];
  return results.map((r) => decodeFunctionResult({ abi, functionName, data: r }) as T);
}

/** Same as {@link multicallReadHomogeneous} but allows each inner call to be a different
 *  function. Each entry supplies its own `(functionName, args)`. */
export async function multicallReadHetero(
  publicClient: PublicClient,
  abi: Abi,
  target: Hex,
  calls: Array<{ functionName: string; args: readonly unknown[] }>,
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const data = calls.map((c) => encodeFunctionData({ abi, functionName: c.functionName, args: c.args }) as Hex);
  const { result } = await publicClient.simulateContract({
    address: target as `0x${string}`,
    abi: [...abi, multicallAbiEntry()] as Abi,
    functionName: "multicall",
    args: [data],
  });
  const results = result as readonly Hex[];
  return results.map((r, i) =>
    decodeFunctionResult({ abi, functionName: calls[i]!.functionName, data: r }),
  );
}

/** How many existence probes ride one `eth_call`. 150 x 36 bytes of calldata, 150 bytes back. */
export const PROBE_BATCH = 150;

/** Most reads in flight at once when a batched probe has to be retried one at a time. */
export const FALLBACK_CONCURRENCY = 20;

/** One yes/no question put to an ABX FS store: does this content address exist? */
export interface ProbeTarget {
  address: Hex;
  abi: readonly unknown[];
  /** `exists` (ChunkStore), `fileExists` (FileStore) or `directoryExists` (DirectoryStore). */
  fn: string;
  arg: Hex;
}

/**
 * A provider's own words for "slow down" or "that took too long", in a JSON-RPC error's `details`: a rate limit, or a
 * timeout answered with HTTP 200 (`-32603 "request timed out"`, `-32000 "execution aborted (timeout = 5s)"`).
 */
const RPC_TRANSPORT_TEXT = /\b429\b|rate.?limit|too many requests|timeout|timed out/i;
/** The same for an error that is not viem's: its name and message are all there is to go on. */
const TRANSPORT_TEXT = /\b429\b|rate.?limit|too many requests|timeout|timed out|fetch failed|failed to fetch|HttpRequestError|network/i;

/** How a node's own words start when an answer is a revert (geth: `execution reverted: <reason>`). */
const REVERT_TEXT = /^execution reverted\b/i;

/**
 * An answer that is a revert: JSON-RPC code 3, revert data (hex) attached, or a node message that says so. Its text is
 * then the contract's revert reason, which anyone can make say "rate limit" or "timed out".
 *
 * NOT viem's `ContractFunctionRevertedError` on its own: viem builds one for any JSON-RPC `-32603` with a message, so a
 * provider's `-32603 "request timed out"` reaches a caller as a "revert" whose reason is the timeout.
 */
function isRevertAnswer(x: unknown): boolean {
  if (x === null || typeof x !== "object") return false;
  const { code, data, details } = x as { code?: unknown; data?: unknown; details?: unknown };
  return (
    code === 3 ||
    (typeof data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(data)) ||
    (x instanceof RpcRequestError && typeof details === "string" && REVERT_TEXT.test(details))
  );
}

/**
 * Whether a failed call was answered with a REVERT: the EVM ran the call and refused it, so asking again (another
 * replica, a moment later) gets the same answer. For a viem error, a layer anywhere in its cause chain that is
 * {@link isRevertAnswer} (JSON-RPC code 3, hex revert data, a node message that starts `execution reverted`) or viem's
 * `ExecutionRevertedError`; for any other error (another client, a wrapper, a test double), the error or its cause
 * carrying code 3 or revert data, or a message that starts `execution reverted`.
 *
 * NOT viem's `ContractFunctionRevertedError` on its own, which viem builds for any JSON-RPC `-32603` with a message: a
 * load-balanced RPC's `-32603 "header not found"` or `-32603 "internal error"` is a replica that could not answer, not a
 * revert. The ONE rule for "is this a revert": {@link isTransportFailure} reads a JSON-RPC error's words only when it
 * is not one, `readAtBlock` throws one at once and waits anything else out, and {@link isChunkReadGasRefusal} reads a
 * gas refusal only from one (or from a node's own out-of-gas words).
 */
export function isRevertFailure(e: unknown): boolean {
  if (e instanceof BaseError) return e.walk((x) => x instanceof ExecutionRevertedError || isRevertAnswer(x)) !== null;
  const message = (e as Error | null)?.message;
  return isRevertAnswer(e) || isRevertAnswer((e as { cause?: unknown } | null)?.cause) || (typeof message === "string" && REVERT_TEXT.test(message));
}

/**
 * A failure of the connection itself, as opposed to an answer: the request got no reply, timed out, or the endpoint or
 * a proxy refused it for rate (HTTP 429, a JSON-RPC rate-limit or timeout error). Retrying the same work one call at a
 * time, or in halves, only adds load to what just failed, so every reader rethrows these at once. The ONE rule for the
 * SDK's readers (`read.ts`, {@link probeExistence}, `project.ts`, `readAtBlock`) and for {@link isGasRefusal}.
 *
 * A viem error is decided by type and code anywhere in its cause chain, never by its message: a revert's message
 * quotes the call's arguments, whose hex can spell `429`. A JSON-RPC error's own words (`details`) are read for a rate
 * limit or a timeout (a provider's HTTP 200 `-32603 "request timed out"` is the connection, not an answer), unless the error is a revert ({@link isRevertFailure}: code 3, revert data, `execution reverted`, anywhere
 * in the chain): a revert reason that says "rate limit exceeded" stays a revert. Any other error (another client, a
 * wrapper, a test double) by its HTTP status, then its own words, again unless it (or its cause) carries code 3 or
 * revert data.
 */
export function isTransportFailure(e: unknown): boolean {
  const reverted = isRevertFailure(e);
  if (e instanceof BaseError) {
    return (
      e.walk(
        (x) =>
          x instanceof HttpRequestError ||
          x instanceof TimeoutError ||
          x instanceof WebSocketRequestError ||
          x instanceof LimitExceededRpcError ||
          (x as { status?: unknown }).status === 429 ||
          (x as { code?: unknown }).code === 429 ||
          (!reverted && x instanceof RpcRequestError && RPC_TRANSPORT_TEXT.test(x.details)),
      ) !== null
    );
  }
  const message = (e as Error | null)?.message;
  const text = `${(e as { name?: string })?.name ?? ""} ${message ?? ""} ${(e as { details?: string })?.details ?? ""}`;
  const status = (e as { status?: number })?.status ?? (e as { cause?: { status?: number } })?.cause?.status;
  return status === 429 || (!reverted && TRANSPORT_TEXT.test(text));
}

/**
 * ChunkStore's `RetrieveFailed(bytes32,address)`: the backend's `retrieve` failed or answered the wrong shape. Inside a
 * chunk-read `eth_call` the node simulates with too little gas, that is how running out surfaces: the backend's
 * `staticcall` (FastLZ inflating, say) runs out of the gas it was forwarded, and the store reverts with this, which
 * `multicall` passes on. Measured on anvil with `--gas-limit 16777216`: a planned 8-chunk FastLZ read is refused as a
 * code-3 revert whose data is exactly this error (`test/delta-round3/read-gas-shape.test.ts` keeps that true).
 */
export const RETRIEVE_FAILED_SELECTOR = "0x93daf644";

/**
 * A node's own words for "this call needs more gas than I run": geth's `out of gas` and `gas required exceeds
 * allowance`, and the `OutOfGas` some clients put in the error's `data` instead.
 */
const GAS_TEXT = /out ?of ?gas|gas required exceeds/i;

/**
 * Whether a refused chunk-read call (`ChunkStore.read` through `multicall`) looks like the NODE refusing its gas, the
 * one failure that says the node simulates less than the read planned for, so the rest of the read should be planned
 * at half the gas. Three shapes:
 *
 *   - a revert ({@link isRevertFailure}) whose data is {@link RETRIEVE_FAILED_SELECTOR}: a backend that ran out;
 *   - a revert with no data: the multicall frame itself ran out;
 *   - no revert data, and the node's own words say `out of gas` or `gas required exceeds`.
 *
 * Never any other JSON-RPC error that is not a revert (a load-balanced RPC's `-32603 internal error` or `-32000 header
 * not found`: one replica's bad moment, and the next call may land elsewhere; anvil's `-32603 EVM error OutOfGas` is
 * the node's own words, and counts), never a result too long for the node ({@link resultLimitOf}), never a failure of
 * the connection
 * ({@link isTransportFailure}), and never other revert data (`ChunkNotFound`, `DataMismatch`, a reason string that says
 * "out of gas"): those are the contract refusing a chunk, which reading by halves isolates but a smaller gas budget
 * does not help. A malformed answer is not an error at all, and the reader never asks.
 */
export function isChunkReadGasRefusal(err: unknown): boolean {
  if (isTransportFailure(err)) return false;
  const data = revertDataOf(err);
  if (data !== undefined) return data.toLowerCase().startsWith(RETRIEVE_FAILED_SELECTOR);
  return isRevertFailure(err) || GAS_TEXT.test(errorWords(err));
}

/** Erigon's words for a result longer than it returns: `call returned result on length N exceeding --rpc.returndata.limit L`. */
const RESULT_LIMIT_TEXT = /exceeding --rpc\.returndata\.limit (\d+)/i;

/**
 * The most bytes the node returns from one `eth_call`, when a refused call says so, else `undefined`. Erigon refuses
 * any result longer than its `--rpc.returndata.limit`, 100,000 bytes by default: four full chunks, so a chunk read
 * plans its calls within it ({@link readChunkSlices}). Halving the gas cannot help there: a raw chunk is cheap to read
 * and as long as a FastLZ one.
 */
export function resultLimitOf(err: unknown): number | undefined {
  // Never from a revert: what follows `execution reverted` is a contract's to say, not the node's.
  if (isTransportFailure(err) || isRevertFailure(err) || revertDataOf(err) !== undefined) return undefined;
  const m = RESULT_LIMIT_TEXT.exec(errorWords(err));
  const limit = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** The first hex revert data (more than `0x`) anywhere in `err`'s cause chain, or `undefined`. */
function revertDataOf(err: unknown): string | undefined {
  const isData = (x: unknown): x is { data: string } => {
    const d = (x as { data?: unknown } | null)?.data;
    return typeof d === "string" && d.length > 2 && /^0x(?:[0-9a-fA-F]{2})*$/.test(d);
  };
  if (err instanceof BaseError) return (err.walk(isData) as { data: string } | null)?.data;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return isData(err) ? err.data : isData(cause) ? cause.data : undefined;
}

/**
 * Every message, `details` and text `data` in `err`'s cause chain (eight layers at most), joined: what the node said, in
 * words. Only asked when the chain carries no revert data, so no contract's revert reason is among them.
 */
function errorWords(err: unknown): string {
  const out: string[] = [];
  let x = err as { message?: unknown; details?: unknown; data?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; x && typeof x === "object" && i < 8; x = x.cause as typeof x, i++) {
    for (const v of [x.details, x.message, x.data]) if (typeof v === "string") out.push(v);
  }
  return out.join(" ");
}

/**
 * Ask many existence questions in as few `eth_call`s as possible.
 *
 * The three stores are `Multicallable`, so N reads against one store are ONE call (`multicall(bytes[])`
 * through `eth_call`), in slices of {@link PROBE_BATCH}: one `eth_call` per probe would cost ~7 reads per
 * file across plan, execute and the per-stage confirmations, and a browser behind a per-minute RPC budget
 * would run out halfway through a 100-file publish. Result order matches `targets`.
 *
 * If the batched read fails for a reason that is NOT the transport (a store that is not Multicallable, a
 * client without `simulateContract`), it degrades to one read per probe, which is always correct. A
 * transport or rate-limit failure is rethrown: fanning out would multiply the load that just failed.
 */
export async function probeExistence(
  publicClient: PublicClient,
  targets: readonly ProbeTarget[],
): Promise<boolean[]> {
  const out: boolean[] = new Array(targets.length).fill(false);
  // Group by store + function so each group is one homogeneous multicall.
  const groups = new Map<string, { target: ProbeTarget; indexes: number[] }>();
  targets.forEach((t, i) => {
    const key = `${t.address.toLowerCase()}:${t.fn}`;
    const g = groups.get(key);
    if (g) g.indexes.push(i);
    else groups.set(key, { target: t, indexes: [i] });
  });
  for (const { target, indexes } of groups.values()) {
    for (let off = 0; off < indexes.length; off += PROBE_BATCH) {
      const slice = indexes.slice(off, off + PROBE_BATCH);
      let answers: boolean[];
      try {
        answers = await multicallReadHomogeneous<boolean>(
          publicClient,
          target.abi as Abi,
          target.address,
          target.fn,
          slice.map((i) => [targets[i]!.arg]),
        );
        if (answers.length !== slice.length || answers.some((a) => typeof a !== "boolean")) throw new Error("malformed multicall answer");
      } catch (e) {
        if (isTransportFailure(e)) throw e;
        // Never one read per probe at once (a failing 150-probe batch would become 150 simultaneous
        // reads): retry in slices of at most FALLBACK_CONCURRENCY in flight.
        answers = await mapInSlices(
          slice,
          (i) =>
            publicClient.readContract({
              address: target.address,
              abi: target.abi as Abi,
              functionName: target.fn,
              args: [targets[i]!.arg],
            }) as Promise<boolean>,
          FALLBACK_CONCURRENCY,
        );
      }
      slice.forEach((idx, j) => {
        out[idx] = answers[j]!;
      });
    }
  }
  return out;
}

/** Re-export of the packer for callers that want to pre-plan and inspect bundles. */
export { packBundles } from "./gas.js";
export type { Bundle, BundleableCall } from "./gas.js";

/** Build a `BundleableCall` for `ChunkStore.write(backend, input, dataHash, size)`. */
export function contentWriteCall(
  chunkStore: Hex,
  chunk: { backend: Hex; input: Hex; dataHash: Hex; size: number },
  estimate: number | GasEstimate,
  label?: string,
): BundleableCall {
  const split = typeof estimate === "number" ? undefined : estimate;
  return {
    target: chunkStore as `0x${string}`,
    data: encodeFunctionData({
      abi: chunkStoreAbi,
      functionName: "write",
      args: [chunk.backend as `0x${string}`, chunk.input, chunk.dataHash, chunk.size],
    }) as Hex,
    estimatedGas: split ? split.execution + split.state : (estimate as number),
    ...(split ? { estimatedStateGas: split.state } : {}),
    label,
  };
}

/** Convenience wrapper: pack a list of calls and send them as `multicall` txs. */
export async function sendPacked(
  clients: { publicClient: PublicClient; walletClient: WalletClient },
  abi: Abi,
  calls: BundleableCall[],
  maxBundleGas: number,
  opts?: {
    onBundleSent?: (b: Bundle, i: number, txHash: Hex) => void;
    beforeEachBundle?: (b: Bundle, i: number) => Promise<void>;
  },
): Promise<Hex[]> {
  const bundles = packBundles(calls, { maxBundleGas });
  return sendBundles(clients, bundles, abi, opts);
}

function multicallAbiEntry() {
  return {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  } as const;
}
