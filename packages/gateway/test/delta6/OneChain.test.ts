/**
 * Delta audit round 6, I-2: a setting that names one chain was read two ways. The bin refused `ABXFS_DEFAULT_CHAIN=base,ethereum`
 * while the library's `chainsFromEnv` took its first chain, and `--project base,ethereum/…` served Base. One parser,
 * `parseOneChain`, now reads it for the library, both bins and `--project`.
 */
import { describe, expect, it } from "vitest";

import { chainsFromEnv, parseOneChain } from "../../src/config.js";

describe("parseOneChain", () => {
  it("reads one chain by name or id; blank is unset unless required", () => {
    expect(parseOneChain("base-sepolia", "--x")).toBe(84532);
    expect(parseOneChain(" 8453 ", "--x")).toBe(8453);
    for (const blank of [undefined, "", "  "]) {
      expect(parseOneChain(blank, "--x")).toBeUndefined();
      expect(() => parseOneChain(blank, "--x", { required: true })).toThrow(/^--x expects one chain: .*base-sepolia.*, or a chain id \(got "\s*"\)$/);
    }
  });

  it("refuses a list, and a value that names no chain, never reading them as the first or as none", () => {
    for (const bad of ["base,ethereum", "ethereum,base", ",", " , "]) {
      expect(() => parseOneChain(bad, "--x"), bad).toThrow(/--x expects one chain/);
    }
    expect(() => parseOneChain("nope", "--x")).toThrow(/^--x: unknown chain "nope"$/);
    // A trailing comma still names one chain: the list parser drops empty items, as it does for --chains.
    expect(parseOneChain("base,", "--x")).toBe(8453);
  });
});

describe("chainsFromEnv reads ABXFS_DEFAULT_CHAIN as the bin does", () => {
  it("refuses a list or a value that names no chain, and names itself for an unknown chain", () => {
    for (const bad of ["base,ethereum", "ethereum,base", ","]) {
      expect(() => chainsFromEnv({ ABXFS_DEFAULT_CHAIN: bad }), bad).toThrow(/^ABXFS_DEFAULT_CHAIN expects one chain/);
    }
    // Delta round 7, I-6: the bins named the variable and the library did not.
    expect(() => chainsFromEnv({ ABXFS_DEFAULT_CHAIN: "nope" })).toThrow(/^ABXFS_DEFAULT_CHAIN: unknown chain "nope"$/);
  });

  it("blank is unset: the default (the first chain served) applies", () => {
    expect(chainsFromEnv({ ABXFS_DEFAULT_CHAIN: " " }).defaultChainId).toBe(chainsFromEnv({}).chains[0]!.id);
    expect(chainsFromEnv({ ABXFS_DEFAULT_CHAIN: "ethereum" }).defaultChainId).toBe(1);
  });
});
