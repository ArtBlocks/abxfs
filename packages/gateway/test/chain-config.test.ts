/**
 * Chain names for the standalone gateway and mirror.
 *
 * Names are derived from the registry by the CLI's rule, so `--chain arbitrum-one` means the same chain in
 * both tools. No network is preferred: every URL names its chain, so there is no default one.
 */
import { describe, expect, it } from "vitest";

import { CHAIN_NAMES, chainsFromEnv, parseChainList, requireDeployed } from "../src/config.js";

describe("gateway chain config", () => {
  it("names every canonical chain", () => {
    expect(parseChainList("base,base-sepolia")).toEqual([8453, 84532]);
    expect(parseChainList("ethereum,sepolia,arbitrum-one,arbitrum-sepolia")).toEqual([1, 11155111, 42161, 421614]);
    // Not in the registry, so not a name (an id still works).
    expect(() => parseChainList("optimism")).toThrow(/unknown chain/);
    expect(parseChainList("42161")).toEqual([42161]);
    expect(parseChainList("robinhood,robinhood-testnet")).toEqual([4663, 46630]);
    expect(() => parseChainList("not-a-chain")).toThrow(/unknown chain/);
  });

  it("loads every canonical chain before deployment filtering", () => {
    const { chains } = chainsFromEnv({});
    expect(chains.map((c) => c.id).sort((a, b) => a - b)).toEqual([1, 4663, 8453, 42161, 46630, 84532, 421614, 11155111]);
  });

  it("serves the chains named, in the order named, once each", () => {
    expect(chainsFromEnv({}, [421614, 42161]).chains.map((c) => c.id)).toEqual([421614, 42161]);
    expect(chainsFromEnv({}, [84532, 84532]).chains.map((c) => c.id)).toEqual([84532]);
  });

  it("lists every registry name in its messages", () => {
    expect(CHAIN_NAMES).toMatch(/^(?:[a-z0-9-]+, )+or a chain id$/);
    for (const name of ["ethereum", "base", "arbitrum-one", "sepolia", "base-sepolia", "arbitrum-sepolia", "robinhood", "robinhood-testnet"]) {
      expect(CHAIN_NAMES.split(", ")).toContain(name);
    }
  });
});

describe("chains with no deployment", () => {
  const loaded = chainsFromEnv({}, [8453, 84532]);

  it("refuses with 'not deployed' when no requested chain has addresses, as ONE error with no per-chain notes", () => {
    const none = { ...loaded, chains: loaded.chains.map((c) => ({ ...c, contracts: undefined as never })) };
    const notes: string[] = [];
    expect(() => requireDeployed(none, (m) => notes.push(m))).toThrow(/not deployed: none of the requested chains \(8453, 84532\)/);
    expect(notes).toEqual([]);
  });

  it("drops nothing that is deployed", () => {
    const notes: string[] = [];
    const both = { ...loaded, chains: loaded.chains.map((c) => ({ ...c, contracts: {} as never })) };
    const out = requireDeployed(both, (m) => notes.push(m));
    expect(out.chains.map((c) => c.id)).toEqual([8453, 84532]);
    expect(notes).toEqual([]);
  });

  it("drops an undeployed chain with a note", () => {
    const notes: string[] = [];
    const partial = {
      ...loaded,
      chains: loaded.chains.map((c) => (c.id === 8453 ? { ...c, contracts: undefined as never } : { ...c, contracts: {} as never })),
    };
    const out = requireDeployed(partial, (m) => notes.push(m));
    expect(out.chains.map((c) => c.id)).toEqual([84532]);
    expect(notes).toEqual([expect.stringMatching(/chain 8453 \(.*\) is not deployed yet/)]);
  });
});
