/**
 * Canonical ABX FS deployments per chain.
 *
 * Every ABX FS contract is deployed with CREATE2 through the keyless deployer, with no sender-dependent constructor
 * argument, so each lands at the SAME address on every chain. That matters for content: a storage backend's address is
 * part of every chunk id, so identical bytes uploaded to two chains through the same backend address produce identical
 * CIDs on both. **Use these addresses, or your CIDs will not match anyone else's.**
 *
 * An entry's `addresses` is a claim that contracts exist there, so it is present only after a deployment has been
 * verified on that chain. A chain listed without addresses is one ABX FS supports but has not yet deployed to: every
 * read or write there refuses with a clear error rather than calling an empty address (a call to an address with no
 * code "succeeds" and returns nothing, which is the silent failure this guards against).
 *
 * `ContractAddresses` may always be passed explicitly instead: a local `anvil` chain, or a private deployment.
 */
import type { Address } from "viem";

import type { ContractAddresses } from "./types.js";

/**
 * The ABX FS address book. Every contract is deployed with CREATE2 through the keyless deployer, with fixed salts and no
 * sender-dependent constructor argument, so each lands at this one address on every chain; an entry below carries it
 * only once the deployment there has been read back from the chain and rehearsed (`docs/deploy-runbook.md`).
 */
const ABXFS_ADDRESSES: ContractAddresses = Object.freeze({
  chunkStore: "0x56317b1F45E4c15310135Ea72Fa4d768ca902BCc",
  sstore2Backend: "0x3C3AE36F5d8Aff2Dd60c37cA9103D93803c4c844",
  fastLzBackend: "0x80a4Ec4A4F98358022A5a060F7cB467188fb68E1",
  fileStore: "0x8b6077a1d6953D96687005B9408D56A655b4d155",
  directoryStore: "0x4273E4E078F47303Ca15b11959eeb61F3FC94c11",
  ipfsCidResolver: "0x7CE58c2945CbE3C2bDb0D3d276Ba3b9bD294008d",
  orgMeta: "0xB21e65DE1c241B9BaE8b7077b6f2E8f2c3Bc0F5D",
  orgFactory: "0xC5aBF9fBd94659cdfc173AF30c6052700Fa62798",
  projectHook: "0x3828Dd35AbF6a42F0d92E0F3311bd70593BD6E7B",
  projectEnumeration: "0x2b2a84df4d62d18329899b66c744E6C643cDC065",
  orgMinter: "0xc009135a8b9DdB14De53868773Fc1dc97963De1e",
  lens: "0x2Ef71C4780e70F64507F04BD1Fde35eC3713269e",
} satisfies ContractAddresses);

/** A canonical deployment record: the chain, how to reach it, and (once deployed) its addresses. */
export interface CanonicalDeployment {
  chainId: number;
  /** Human-readable chain name, for error messages and CLI output. */
  name: string;
  /** ABX FS addresses on this chain; absent until a deployment has been verified here. */
  addresses?: ContractAddresses;
  /**
   * Testnet or production.
   *
   * Explicit rather than inferred from the chain id, because "is this play money" is the one property a caller must
   * never have to look up.
   */
  environment: "testnet" | "production";
  /**
   * Public RPC endpoints, best first, ordered by `eth_call` gas cap: every ABX FS read is an `eth_call`.
   * Both are unkeyed and rate-limited; a keyed provider is the right answer for anything sustained.
   */
  publicRpc: string[];
}

/**
 * Registry of canonical deployments, keyed by EIP-155 chain id: Base (8453), Base Sepolia (84532), Ethereum (1),
 * Sepolia (11155111), Arbitrum One (42161) and Arbitrum Sepolia (421614). A chain gains {@link ABXFS_ADDRESSES} once ABX FS is deployed
 * there, read back and rehearsed.
 *
 * Integer keys enumerate in ascending numeric order whatever the literal order below. No network is a default:
 * a caller that names none is asked to choose.
 */
export const CANONICAL_DEPLOYMENTS: Readonly<Record<number, CanonicalDeployment>> = Object.freeze({
  84532: Object.freeze({
    chainId: 84532,
    name: "Base Sepolia",
    environment: "testnet",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
  8453: Object.freeze({
    chainId: 8453,
    name: "Base",
    environment: "production",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://mainnet.base.org"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
  1: Object.freeze({
    chainId: 1,
    name: "Ethereum",
    environment: "production",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
  11155111: Object.freeze({
    chainId: 11155111,
    name: "Sepolia",
    environment: "testnet",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
  421614: Object.freeze({
    chainId: 421614,
    name: "Arbitrum Sepolia",
    environment: "testnet",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://sepolia-rollup.arbitrum.io/rpc"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
  42161: Object.freeze({
    chainId: 42161,
    name: "Arbitrum One",
    environment: "production",
    addresses: ABXFS_ADDRESSES,
    publicRpc: Object.freeze(["https://arb1.arbitrum.io/rpc"]) as unknown as string[],
  }) satisfies CanonicalDeployment,
});

/**
 * Registry of canonical per-chain addresses. Derived from {@link CANONICAL_DEPLOYMENTS} so the two
 * cannot drift.
 */
export const CANONICAL_ADDRESSES: Readonly<Record<number, ContractAddresses>> = Object.freeze(
  Object.fromEntries(
    Object.values(CANONICAL_DEPLOYMENTS)
      .filter((d) => d.addresses !== undefined)
      .map((d) => [d.chainId, d.addresses!]),
  ),
);

/** Chain ids with a canonical deployment on record. */
export function canonicalChainIds(): number[] {
  return Object.values(CANONICAL_DEPLOYMENTS).map((d) => d.chainId);
}

/** Look up a full canonical deployment, or `undefined` if the chain has none. */
export function resolveCanonicalDeployment(chainId: number): CanonicalDeployment | undefined {
  return CANONICAL_DEPLOYMENTS[chainId];
}

/** Look up a full canonical deployment or throw, naming the chains that do have one. */
export function requireCanonicalDeployment(chainId: number): CanonicalDeployment {
  const d = resolveCanonicalDeployment(chainId);
  if (!d) {
    const known = Object.values(CANONICAL_DEPLOYMENTS)
      .map((x) => `${x.name} (${x.chainId})`)
      .join(", ");
    throw new Error(
      `No canonical ABX FS deployment is recorded for chain ${chainId}. ` +
        `Canonical deployments exist on: ${known}. ` +
        "For any other chain — including a local anvil — pass explicit ContractAddresses; " +
        "`abxfs dev` prints them for a local chain.",
    );
  }
  return d;
}

/**
 * Look up canonical addresses for a given chain ID.
 *
 * Returns `undefined` if the chain has no canonical deployment on record.
 * Use {@link requireCanonicalAddresses} to throw instead.
 */
export function resolveCanonicalAddresses(chainId: number): ContractAddresses | undefined {
  return CANONICAL_ADDRESSES[chainId];
}

/**
 * Look up canonical addresses for a given chain ID or throw: for a chain with no canonical record, and for a chain
 * ABX FS supports but has not deployed to yet.
 */
export function requireCanonicalAddresses(chainId: number): ContractAddresses {
  const d = requireCanonicalDeployment(chainId);
  if (!d.addresses) {
    throw new Error(
      `ABX FS is not deployed on ${d.name} (${chainId}) yet, so there is nothing to read or write there. ` +
        "Pass explicit ContractAddresses for a local or private deployment.",
    );
  }
  return d.addresses;
}

/** Whether ABX FS is deployed (and recorded) on `chainId`. */
export function isCanonicallyDeployed(chainId: number): boolean {
  return CANONICAL_DEPLOYMENTS[chainId]?.addresses !== undefined;
}
