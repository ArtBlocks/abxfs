/**
 * What the CLI knows about a chain without asking any RPC: viem's static chain list, and the fee ceiling.
 *
 * Kept apart from `client.ts` (which builds the transports) so that what a command PRINTS about a chain, and the
 * ceiling it is held to, never depends on a client existing (and tests that replace the client keep them).
 */
import { parseGwei, type Chain } from "viem";
import * as viemChains from "viem/chains";

import { safe } from "./text.js";

/** Ethereum mainnet and its testnets: a higher default fee ceiling. */
const L1_CHAIN_IDS = new Set([1, 11155111, 17000]);

/**
 * The most the CLI will pay per gas on a write, in wei: `ABXFS_MAX_FEE_GWEI`, else 50 gwei on an L2 or
 * devnet and 200 gwei on Ethereum L1 and its testnets. A node chooses the fee it quotes, so without a
 * ceiling a hostile or broken RPC could make one signed write cost the account's whole balance.
 */
export function maxFeeCapWei(chainId: number): bigint {
  const raw = process.env["ABXFS_MAX_FEE_GWEI"];
  if (raw !== undefined && raw !== "") {
    if (!/^\d+(\.\d{1,9})?$/.test(raw)) throw new Error(`ABXFS_MAX_FEE_GWEI must be a decimal number of gwei (got "${safe(raw)}")`);
    return parseGwei(raw);
  }
  return parseGwei(L1_CHAIN_IDS.has(chainId) ? "200" : "50");
}

/** viem's own definition of `chainId`, when its static list has one. */
export function knownViemChain(chainId: number): Chain | undefined {
  // `viem/chains` exports hundreds of heavily literal-typed chain objects, so a type predicate over
  // the union does not assign. Widen once, then match structurally.
  const candidates = Object.values(viemChains) as unknown as Chain[];
  return candidates.find((c) => typeof c === "object" && c !== null && typeof c.id === "number" && c.id === chainId);
}

/**
 * Whether `chainId` is an OP-stack L2 (Base, OP, and others) by viem's static list: one that names the OP-stack gas
 * price oracle. Such a chain charges an L1 data fee on top of the gas a transaction uses, which no gas figure includes.
 */
export function isOpStackChain(chainId: number): boolean {
  return knownViemChain(chainId)?.contracts?.["gasPriceOracle"] !== undefined;
}

/** Nitro chains, including the Robinhood Orbit networks. */
const ARBITRUM_CHAIN_IDS = new Set([42161, 42170, 421614, 4663, 46630]);

/**
 * Whether `chainId` is an Arbitrum (Nitro) chain. Such a chain charges an L1 component for each transaction's calldata
 * at Ethereum's price, as extra GAS on top of what the transaction executes (`eth_estimateGas` includes it; the SDK's
 * gas model, and so every gas figure in a plan, does not).
 */
export function isArbitrumChain(chainId: number): boolean {
  return ARBITRUM_CHAIN_IDS.has(chainId);
}

/** `Base Sepolia (chain 84532)`: viem's name for a chain it knows, from its static list (never from an RPC). */
export function chainDisplayName(chainId: number): string {
  const known = knownViemChain(chainId);
  return known ? `${known.name} (chain ${chainId})` : `chain ${chainId}`;
}
