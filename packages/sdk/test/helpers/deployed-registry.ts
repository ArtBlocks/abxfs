/**
 * The canonical registry with stand-in addresses: every listed chain with a full address book.
 *
 * The real registry carries no addresses for a chain until a deployment has been verified there. The config tests, which
 * are about what a config file may and may not override, defend this stand-in book instead of the real one, so they do
 * not move when a chain is deployed or a contract is re-pinned. Each test
 * file (or a vitest setup file) that needs it mocks `@abxfs/sdk` through {@link withDeployedRegistry}:
 *
 *   vi.mock("@abxfs/sdk", async (orig) => (await import("<path>/deployed-registry.js")).withDeployedRegistry(await orig()));
 *
 * Shared by the SDK, CLI and app tests, so every one of them defends the same address book.
 *
 * The addresses are stand-ins, not predictions, so nothing here moves when contract code does.
 */
import type * as Sdk from "@abxfs/sdk";
import type { Address } from "viem";

const at = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

/**
 * A stand-in address book. As in the real deployment, every contract sits at the same address on every chain (CREATE2,
 * identical constructor arguments), except that the stand-in lens differs per chain.
 */
export function fixtureAddresses(chainId: number): Sdk.ContractAddresses {
  return {
    chunkStore: at(0xc001),
    sstore2Backend: at(0xc002),
    fastLzBackend: at(0xc003),
    fileStore: at(0xc004),
    directoryStore: at(0xc005),
    orgFactory: at(0xc006),
    orgMinter: at(0xc007),
    orgMeta: at(0xc008),
    projectHook: at(0xc009),
    projectEnumeration: at(0xc00a),
    ipfsCidResolver: at(0xc00b),
    lens: at(0x1e00000 + (chainId % 0xfffff)),
  };
}

export function withDeployedRegistry(sdk: typeof Sdk): typeof Sdk {
  const deployments: Record<number, Sdk.CanonicalDeployment> = Object.freeze(
    Object.fromEntries(
      Object.values(sdk.CANONICAL_DEPLOYMENTS).map((d) => [d.chainId, Object.freeze({ ...d, addresses: fixtureAddresses(d.chainId) })]),
    ),
  );
  const resolveCanonicalDeployment = (chainId: number) => deployments[chainId];
  return {
    ...sdk,
    CANONICAL_DEPLOYMENTS: deployments,
    CANONICAL_ADDRESSES: Object.freeze(Object.fromEntries(Object.values(deployments).map((d) => [d.chainId, d.addresses!]))),
    resolveCanonicalDeployment,
    requireCanonicalDeployment: (chainId: number) => {
      const d = deployments[chainId];
      if (!d) throw new Error(`no canonical deployment for chain ${chainId}`);
      return d;
    },
    resolveCanonicalAddresses: (chainId: number) => deployments[chainId]?.addresses,
    requireCanonicalAddresses: (chainId: number) => {
      const a = deployments[chainId]?.addresses;
      if (!a) throw new Error(`no canonical addresses for chain ${chainId}`);
      return a;
    },
    isCanonicallyDeployed: (chainId: number) => deployments[chainId] !== undefined,
  };
}
