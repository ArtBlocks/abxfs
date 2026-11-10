import { readFileSync } from "node:fs";
import { defineChain, isAddress, type Chain } from "viem";
import * as viemChains from "viem/chains";
import { CANONICAL_DEPLOYMENTS, requireCanonicalAddresses } from "../../src/canonical.js";
import type { ContractAddresses } from "../../src/types.js";

/** Metadata-only registry chains are valid qualification targets before address promotion. */
export function rehearsalChain(chainId: number): Chain | undefined {
  const deployment = CANONICAL_DEPLOYMENTS[chainId];
  if (!deployment) return undefined;
  const known = (Object.values(viemChains) as unknown as Chain[]).find((chain) => chain?.id === chainId);
  return known ?? defineChain({
    id: chainId, name: deployment.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: deployment.publicRpc } },
    testnet: deployment.environment === "testnet",
  });
}

/** Read explicit qualification input only inside the opted-in live test. Never promote it to the registry. */
export function rehearsalAddresses(chainId: number, file?: string): ContractAddresses {
  if (!file) return requireCanonicalAddresses(chainId);
  if (!CANONICAL_DEPLOYMENTS[chainId]) throw new Error(`unknown rehearsal chain ${chainId}`);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rehearsal addresses must be a ContractAddresses object");
  const a = value as Record<string, unknown>;
  const required = ["chunkStore", "fileStore", "directoryStore", "sstore2Backend", "fastLzBackend", "orgFactory", "orgMinter", "orgMeta", "lens", "projectHook", "projectEnumeration", "ipfsCidResolver"];
  for (const key of [...required, "contentReader", "projectPresentation"]) {
    if (!required.includes(key) && a[key] === undefined) continue;
    if (typeof a[key] !== "string" || !isAddress(a[key], { strict: false }) || /^0x0{40}$/i.test(a[key]))
      throw new Error(`missing or invalid rehearsal address: ${key}`);
  }
  if (a.projectPresentation && !a.contentReader) throw new Error("presentation rehearsal requires both contentReader and projectPresentation");
  return a as unknown as ContractAddresses;
}
