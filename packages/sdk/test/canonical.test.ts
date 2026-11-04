/**
 * The canonical registry: which chains ABX FS supports, how to reach them, and (once deployed) where it lives.
 *
 * An entry's `addresses` is a claim that contracts exist there. A storage backend's address is mixed into every chunk
 * id, so a registry that names the wrong address does not fail loudly: it silently computes ids in a different
 * content-address space, and a call to an address with no code "succeeds" and returns nothing. So until ABX FS is deployed
 * and verified on a chain, its entry carries no addresses, and every lookup that needs them refuses. Every supported chain
 * has them now: the three testnets since 2026-10-31, and Base, Arbitrum One and Ethereum since 2026-11-03.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAddress } from "viem";

import {
  CANONICAL_ADDRESSES,
  CANONICAL_DEPLOYMENTS,
  canonicalChainIds,
  isCanonicallyDeployed,
  requireCanonicalAddresses,
  requireCanonicalDeployment,
  resolveCanonicalAddresses,
  resolveCanonicalDeployment,
} from "../src/canonical.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const SUPPORTED = [84532, 8453, 1, 11155111, 42161, 421614];
/** Deployed, read back from the chain and rehearsed: every supported chain. */
const DEPLOYED = SUPPORTED;

/** `0x…` addresses assigned in a Solidity function's body, by the name each is assigned to. */
function pinnedIn(file: string, fn: string): Record<string, string> {
  const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
  const body = src.slice(src.indexOf(`function ${fn}(`)).split(/\n    }\n/)[0]!;
  return Object.fromEntries([...body.matchAll(/(\w+)\s*=\s*(0x[0-9a-fA-F]{40});/g)].map((m) => [m[1]!, m[2]!]));
}

describe("deployed on every supported chain", () => {
  it("every supported chain carries the one address book", () => {
    const book = CANONICAL_DEPLOYMENTS[84532]?.addresses;
    expect(book).toBeDefined();
    for (const id of DEPLOYED) {
      expect(CANONICAL_DEPLOYMENTS[id]?.addresses, `chain ${id}`).toBe(book);
      expect(isCanonicallyDeployed(id)).toBe(true);
      expect(resolveCanonicalAddresses(id)).toBe(book);
      expect(requireCanonicalAddresses(id)).toBe(book);
    }
    expect(Object.keys(CANONICAL_ADDRESSES).map(Number).sort((a, b) => a - b)).toEqual([...DEPLOYED].sort((a, b) => a - b));
  });

  /**
   * The registry records what was deployed, and the deploy scripts refuse to broadcast anything but their pins, so the
   * two must agree: a re-pin (a new build) fails here until the chains are redeployed and the record moves with them.
   */
  it("records exactly the addresses the deploy scripts are pinned to", () => {
    const core = pinnedIn("packages/contracts-core/script/Deploy.s.sol", "pinned");
    const org = pinnedIn("packages/contracts-projects/script/Deploy.s.sol", "pinned");
    const resolver = readFileSync(resolve(REPO_ROOT, "packages/contracts-companion/script/Deploy.s.sol"), "utf8")
      .match(/function pinned\(\)[^{]*\{\s*return (0x[0-9a-fA-F]{40});/)?.[1];
    const book = CANONICAL_DEPLOYMENTS[84532]!.addresses!;
    expect({
      chunkStore: book.chunkStore,
      sstore2Backend: book.sstore2Backend,
      fastLzBackend: book.fastLzBackend,
      fileStore: book.fileStore,
      directoryStore: book.directoryStore,
      ipfsCidResolver: book.ipfsCidResolver,
      orgMeta: book.orgMeta,
      orgFactory: book.orgFactory,
      projectHook: book.projectHook,
      projectEnumeration: book.projectEnumeration,
      orgMinter: book.orgMinter,
      lens: book.lens,
    }).toEqual({
      chunkStore: core.chunkStore,
      sstore2Backend: core.sstore2Backend,
      fastLzBackend: core.fastLzSstore2Backend,
      fileStore: core.fileStore,
      directoryStore: core.directoryStore,
      ipfsCidResolver: resolver,
      orgMeta: org.orgMeta,
      orgFactory: org.factory,
      projectHook: org.hook,
      projectEnumeration: org.enumeration,
      orgMinter: org.minter,
      lens: org.lens,
    });
    expect(Object.keys(core)).toHaveLength(5);
    expect(Object.keys(org)).toHaveLength(8);
  });
});

describe("registry shape", () => {
  it("supports Base, Ethereum, Arbitrum One and their testnets, and keeps their environments explicit", () => {
    for (const id of SUPPORTED) expect(canonicalChainIds()).toContain(id);
    expect(CANONICAL_DEPLOYMENTS[8453]?.environment).toBe("production");
    expect(CANONICAL_DEPLOYMENTS[1]?.environment).toBe("production");
    expect(CANONICAL_DEPLOYMENTS[42161]?.environment).toBe("production");
    expect(CANONICAL_DEPLOYMENTS[84532]?.environment).toBe("testnet");
    expect(CANONICAL_DEPLOYMENTS[11155111]?.environment).toBe("testnet");
    expect(CANONICAL_DEPLOYMENTS[421614]?.environment).toBe("testnet");
  });

  it("lists no chain ABX FS does not support", () => {
    for (const id of canonicalChainIds()) expect(SUPPORTED).toContain(id);
  });

  it("offers at least one https RPC endpoint per chain", () => {
    for (const dep of Object.values(CANONICAL_DEPLOYMENTS)) {
      expect(dep.publicRpc.length).toBeGreaterThan(0);
      for (const url of dep.publicRpc) expect(url).toMatch(/^https:\/\//);
    }
  });

  /**
   * Guards the two failures that matter: a malformed or zero
   * address (reads return empty and look like "nothing published"), and a content layer that differs across chains
   * (every ABX FS contract is CREATE2 with no sender-dependent argument, so a difference means a wrong address).
   */
  it("any recorded addresses are well formed, non-zero, and the content layer is one address everywhere", () => {
    const deployed = Object.values(CANONICAL_DEPLOYMENTS).filter((d) => d.addresses !== undefined);
    for (const dep of deployed) {
      for (const [key, value] of Object.entries(dep.addresses!)) {
        if (key === "previousGenerations" || value === undefined) continue;
        expect(isAddress(value as string), `${dep.name}.${key}`).toBe(true);
        expect(value, `${dep.name}.${key} is the zero address`).not.toBe("0x0000000000000000000000000000000000000000");
      }
      expect(CANONICAL_ADDRESSES[dep.chainId]).toBe(dep.addresses);
    }
    for (const key of ["chunkStore", "fileStore", "directoryStore", "sstore2Backend", "fastLzBackend"] as const) {
      const distinct = new Set(deployed.map((d) => d.addresses![key]));
      expect(distinct.size, `${key} differs across chains`).toBeLessThanOrEqual(1);
    }
  });
});

describe("lookup behavior", () => {
  it("returns undefined for an unknown chain rather than throwing", () => {
    expect(resolveCanonicalDeployment(137)).toBeUndefined();
    expect(isCanonicallyDeployed(137)).toBe(false);
  });

  it("throws for an unknown chain, naming the supported chains and the override path", () => {
    let message = "";
    try {
      requireCanonicalAddresses(31337);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("31337");
    expect(message).toContain("Base Sepolia");
    expect(message).toContain("84532");
    expect(message).toMatch(/explicit ContractAddresses/);
  });
});

describe("rpc endpoints", () => {
  /**
   * Every read is an `eth_call`, and reading a large file costs tens of millions of gas: more than
   * `base-sepolia-rpc.publicnode.com` allows (~50M cap). So the list is ordered by gas cap.
   */
  it("leads with the endpoint that can actually serve a large read", () => {
    const rpc = requireCanonicalDeployment(84532).publicRpc;
    expect(rpc[0]).toBe("https://sepolia.base.org");
    expect(rpc.length).toBeGreaterThan(1);
  });
});

/**
 * The published docs hand people addresses to paste into a wallet, so every address they publish must be one the
 * registry holds. The one exception is infrastructure, not protocol: the keyless CREATE2 deployer every contract is
 * deployed through.
 */
const INFRASTRUCTURE = new Set(["0x4e59b44847b379578588920ca78fbf26c0b4956c"]);

describe("the published docs agree with the registry", () => {
  const doc = readFileSync(resolve(REPO_ROOT, "site/content/docs/reference/deployments.mdx"), "utf8");
  const documented = [...doc.matchAll(/`(0x[0-9a-fA-F]{40})`/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((a) => !INFRASTRUCTURE.has(a));
  const registered = new Set(
    Object.values(CANONICAL_DEPLOYMENTS)
      .flatMap((d) => (d.addresses ? Object.entries(d.addresses).filter(([k]) => k !== "previousGenerations").map(([, v]) => v) : []))
      .map((a) => String(a).toLowerCase()),
  );

  it("publishes no address the registry does not hold", () => {
    for (const a of documented) expect(registered, `docs publish ${a}`).toContain(a);
  });
});
