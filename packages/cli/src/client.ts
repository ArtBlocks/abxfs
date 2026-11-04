/**
 * Factory for a AbxfsClient from a CLI ChainConfig.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  formatGwei,
  parseTransaction,
  shouldThrow as viemShouldThrow,
  type Chain,
  type Transport,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

import type { Address } from "viem";
import { AbxfsClient } from "@abxfs/sdk";
import { chainDisplayName, knownViemChain, maxFeeCapWei } from "./chains.js";
import { getPrivateKey, requireAddresses, type ChainConfig } from "./config.js";
import { CliRefusal } from "./redact.js";

export { chainDisplayName, maxFeeCapWei };

const CEILING_NAME = "ABXFS_MAX_FEE_GWEI";
/** `1000 gwei` style, so an operator reading the refusal sees the units they set the ceiling in. */
function gwei(wei: bigint): string {
  return `${formatGwei(wei)} gwei`;
}
function ceilingText(cap: bigint): string {
  return `${gwei(cap)} ceiling (${CEILING_NAME})`;
}

/**
 * viem fee estimation with a hard ceiling on BOTH `maxFeePerGas` and `maxPriorityFeePerGas`. Throws
 * (rather than clamping, which would just produce a stuck transaction) when the node quotes above it.
 */
function cappedFees(chainId: number): NonNullable<Chain["fees"]> {
  return {
    async estimateFeesPerGas({ client, type }) {
      const cap = maxFeeCapWei(chainId);
      const hint = "Raise ABXFS_MAX_FEE_GWEI if this is real, or use a different RPC.";
      const block = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      const base = (block as { baseFeePerGas?: `0x${string}` } | null)?.baseFeePerGas;
      if (type === "legacy" || base === undefined || base === null) {
        const gasPrice = BigInt(await client.request({ method: "eth_gasPrice" }));
        if (gasPrice > cap) throw new CliRefusal(`refusing to send: the RPC quotes gasPrice ${gwei(gasPrice)}, above the ${ceilingText(cap)}. ${hint}`);
        return { gasPrice } as never;
      }
      const priority = BigInt(await client.request({ method: "eth_maxPriorityFeePerGas" }));
      const maxFeePerGas = BigInt(base) * 2n + priority;
      if (priority > cap) throw new CliRefusal(`refusing to send: the RPC quotes maxPriorityFeePerGas ${gwei(priority)}, above the ${ceilingText(cap)}. ${hint}`);
      if (maxFeePerGas > cap) throw new CliRefusal(`refusing to send: the RPC quotes maxFeePerGas ${gwei(maxFeePerGas)}, above the ${ceilingText(cap)}. ${hint}`);
      return { maxFeePerGas, maxPriorityFeePerGas: priority };
    },
  };
}

type RawRequest = (args: { method: string; params?: unknown }, ...rest: unknown[]) => Promise<unknown>;

/** A chain id as an RPC states it (`"0x14a34"`, a number, a bigint), or NaN when it is none of those. */
function asChainId(v: unknown): number {
  try {
    if (typeof v === "number") return v;
    if (typeof v === "bigint" || (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v))) {
      const n = BigInt(v);
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : Number.NaN;
    }
  } catch {
    /* fall through */
  }
  return Number.NaN;
}

/** Whether `err` (or anything it wraps) is a chain-id refusal. Such a refusal never fails over to another endpoint. */
function isChainRefusal(err: unknown): boolean {
  for (let e = err, i = 0; e && i < 8; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof ChainIdMismatchError) return true;
  }
  return false;
}

/** The RPC (or a transaction it filled) is for a different chain than the one configured. */
export class ChainIdMismatchError extends CliRefusal {
  /**
   * A numeric JSON-RPC-style code viem neither maps nor retries, so the refusal reaches the caller as thrown; and a
   * `fallback` transport is told to stop on it (see {@link rpcTransport}) rather than quietly try the next endpoint.
   */
  readonly code = -32099;
  constructor(expected: number, got: number, what: string) {
    super(
      `refusing to continue: the RPC ${what} chain ${Number.isNaN(got) ? "(none or unreadable)" : got}, but this command is ` +
        `for chain ${expected}. A misrouted or hostile endpoint could otherwise have a write signed for a chain you did ` +
        `not choose. Check the RPC URL for this chain (its rpcUrl in your config, ABXFS_RPC_URL_${expected} or ` +
        "ABXFS_RPC_URL) and --chain. Nothing was sent.",
    );
    this.name = "ChainIdMismatchError";
  }
}

/**
 * Hold every request to the configured chain.
 *
 * viem sends `eth_fillTransaction` WITHOUT a chain id and adopts whatever chain id the node fills in, so a hostile
 * or misrouted RPC could have a write signed for a chain the user never chose (the same call replayed on another
 * chain, paid from the same account). Three checks, cheapest first:
 *
 *   1. before the first request of any kind, `eth_chainId` is asked ONCE per client (the public and wallet clients
 *      share the answer) and must equal the configured chain, or nothing is read or sent;
 *   2. every later `eth_chainId` answer, and the `chainId` of every transaction the node fills, must equal it too;
 *   3. the SIGNED transaction on its way out must carry it ({@link guardSignedTx}). What is signed is what a node can
 *      broadcast, so that is the check nothing can route around.
 *
 * A network error during the first check is not cached: the next request asks again. A mismatch is: once an endpoint
 * has answered for another chain, every later request to it is refused. That matters for a filled transaction, which
 * viem would otherwise quietly re-prepare itself after the refusal and send through the same node.
 */
function guardChain(inner: Transport, chainId: number): Transport {
  let verified: Promise<void> | undefined;
  let latched: ChainIdMismatchError | undefined;
  return (opts) => {
    const t = inner(opts);
    const send = t.request as unknown as RawRequest;
    const expectChain = (got: unknown, what: string) => {
      const n = asChainId(got);
      if (n !== chainId) throw (latched = new ChainIdMismatchError(chainId, n, what));
    };
    const verify = () => {
      verified ??= send({ method: "eth_chainId" }).then(
        (r) => expectChain(r, "answers eth_chainId with"),
        (e: unknown) => {
          verified = undefined;
          throw e;
        },
      );
      return verified;
    };
    return {
      ...t,
      async request(args: { method: string; params?: unknown }, ...rest: unknown[]) {
        if (latched) throw latched;
        if (args.method === "eth_chainId") {
          const r = await send(args, ...rest);
          expectChain(r, "answers eth_chainId with");
          return r;
        }
        await verify();
        const r = await send(args, ...rest);
        if (args.method === "eth_fillTransaction") {
          const filled = (r as { tx?: { chainId?: unknown } } | null)?.tx?.chainId;
          if (filled !== undefined && filled !== null) expectChain(filled, "filled a transaction for");
        }
        return r;
      },
    } as ReturnType<Transport>;
  };
}

/**
 * The authoritative checks, on the SIGNED transaction on its way out: its chain id, and the fee ceiling.
 *
 * `chain.fees` is only consulted when viem estimates fees itself; viem 2.57 prefers `eth_fillTransaction`, where the
 * NODE fills in the fees (and the chain id) and the hook never runs, so a hostile node could still choose them. What
 * is signed is what is paid, and what can be broadcast, so the check lives where nothing can route around it.
 */
function guardSignedTx(inner: Transport, chainId: number): Transport {
  return (opts) => {
    const t = inner(opts);
    return {
      ...t,
      async request(args: { method: string; params?: unknown }, ...rest: unknown[]) {
        // Both raw-send methods carry a signed transaction: the "sync" variant returns the receipt directly
        // and is exactly what a path that skipped the plain one would use.
        if ((args.method === "eth_sendRawTransaction" || args.method === "eth_sendRawTransactionSync") && Array.isArray(args.params)) {
          const cap = maxFeeCapWei(chainId);
          const hint = "Raise ABXFS_MAX_FEE_GWEI if this is real, or use a different RPC.";
          let tx: ReturnType<typeof parseTransaction> | undefined;
          try {
            tx = parseTransaction(args.params[0] as `0x${string}`);
          } catch {
            throw new CliRefusal("refusing to send: could not inspect the signed transaction");
          }
          // A legacy transaction without EIP-155 replay protection carries no chain id: it is valid on EVERY chain.
          const signedFor = (tx as { chainId?: number }).chainId;
          if (signedFor !== chainId) {
            throw new ChainIdMismatchError(chainId, signedFor ?? Number.NaN, "had the transaction signed for");
          }
          const quoted = [
            ["maxFeePerGas", (tx as { maxFeePerGas?: bigint }).maxFeePerGas],
            ["maxPriorityFeePerGas", (tx as { maxPriorityFeePerGas?: bigint }).maxPriorityFeePerGas],
            ["gasPrice", (tx as { gasPrice?: bigint }).gasPrice],
          ] as const;
          for (const [name, v] of quoted) {
            if (v !== undefined && v > cap) {
              throw new CliRefusal(`refusing to send: the transaction's ${name} is ${gwei(v)}, above the ${ceilingText(cap)}. ${hint}`);
            }
          }
        }
        return (t.request as unknown as RawRequest)(args, ...rest);
      },
    } as ReturnType<Transport>;
  };
}

let announced = false;
function announceWrite(chain: Chain, rpcUrl: string, account: string): void {
  if (announced) return;
  announced = true;
  let host = "(unparseable rpc url)";
  try {
    host = new URL(rpcUrl).host;
  } catch {
    /* keep placeholder */
  }
  console.error(`writing as ${account} on ${chain.name} (chain ${chain.id}) via ${host}`);
}

/**
 * Resolve a chain id to viem's own definition when it knows one, falling back to a bare definition.
 *
 * This is not cosmetic. A hand-rolled `defineChain` declares no `contracts`, so viem has no
 * `multicall3` address and every batched read fails with "Chain … does not support contract
 * multicall3" — which is exactly what happened on Base Sepolia, a chain that HAS multicall3 at the
 * standard address. `readProject` batches six reads, so the whole project surface was unusable from
 * the CLI. Preferring viem's definition also brings correct native currency and explorer metadata.
 *
 * The fallback keeps ABX FS usable on a chain viem has never heard of (a devnet, a private rollup);
 * batched reads there fail until multicall3 is deployed, which is the honest outcome rather than a
 * silent six-round-trip degradation.
 */
function resolveViemChain(chainId: number, rpcUrl: string): Chain {
  const known = knownViemChain(chainId);

  if (known) {
    // Keep viem's metadata (including `contracts`), but point the transport at the configured RPC.
    return { ...known, rpcUrls: { default: { http: [rpcUrl] } }, fees: cappedFees(chainId) };
  }

  return defineChain({
    id: chainId,
    name: `abxfs-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    fees: cappedFees(chainId),
  });
}

/**
 * Transport over the primary endpoint, failing over to any configured alternates.
 *
 * A single endpoint is a single point of failure, and public ones do go down —
 * `sepolia.base.org` answered 503 "no backend is currently healthy" during development, which with
 * one hardcoded URL is indistinguishable from the CLI being broken. `fallback` retries the next
 * endpoint on a transport error, so zero-config survives one provider having a bad day.
 *
 * Only populated for built-in chains. A user-supplied `rpcUrl` gets no public fallbacks.
 *
 * Each endpoint is held to the configured chain on its own ({@link guardChain}): a fallback is checked the first
 * time it is used, like the primary.
 */
function rpcTransport(chain: ChainConfig): Transport {
  const urls = [chain.rpcUrl, ...(chain.fallbackRpcUrls ?? [])];
  const transports = urls.map((u) => guardChain(http(u), chain.chainId));
  if (transports.length === 1) return transports[0]!;

  // Failover on every transport error, as viem does by default, but NEVER on a chain-id refusal: an endpoint
  // on the wrong chain is a misconfiguration to report, not an outage to route around quietly.
  return fallback(transports, { shouldThrow: (err) => isChainRefusal(err) || viemShouldThrow(err) });
}

export function createClient(
  chain: ChainConfig,
  opts: { write?: boolean; org?: Address } = {},
): AbxfsClient {
  const viemChain = resolveViemChain(chain.chainId, chain.rpcUrl);
  const transport = rpcTransport(chain);

  const publicClient = createPublicClient({
    chain: viemChain,
    transport,
  });

  let walletClient;
  if (opts.write) {
    const pk = getPrivateKey();
    if (!pk) {
      throw new Error("ABXFS_PRIVATE_KEY env var required for write operations");
    }
    const account = privateKeyToAccount(pk, { nonceManager });
    announceWrite(viemChain, chain.rpcUrl, account.address);
    walletClient = createWalletClient({
      chain: viemChain,
      transport: guardSignedTx(transport, chain.chainId),
      // Serialize nonces locally instead of asking the node for each transaction.
      //
      // An upload is a burst of writes from one EOA, and public RPCs are load balanced: ask two
      // replicas for `eth_getTransactionCount` in quick succession and they can disagree, because
      // the first transaction has not propagated to the second. viem then reuses a nonce that is
      // already pending and the node rejects it as `replacement transaction underpriced` — observed
      // repeatedly against both public Base Sepolia endpoints while uploading a three-file project.
      //
      // The nonce manager reads once and increments in process, so a burst gets a strictly
      // increasing sequence regardless of which replica answers.
      account,
    });
  }

  return new AbxfsClient({
    publicClient,
    walletClient,
    addresses: requireAddresses(chain),
    ...(opts.org ? { org: opts.org } : {}),
  });
}

/**
 * A client bound to `org` through the factory generation that created it.
 *
 * Every command that acts on one org's projects or admin settings goes through this rather than
 * `createClient(chain, { org })`, because an org made by a superseded factory is frozen against that
 * factory's hook and has to be read and written through it. Throws if no ABX FS factory made `org`.
 */
export async function createOrgClient(
  chain: ChainConfig,
  opts: { write?: boolean; org: Address },
): Promise<AbxfsClient> {
  return createClient(chain, opts.write ? { write: true } : {}).resolveOrg(opts.org);
}
