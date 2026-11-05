/**
 * Delta audit round 6, I-2: a setting that names one chain was read two ways, and `--project base,ethereum/…` served
 * Base. One parser, `parseOneChain`, now reads it for both bins and `--project`.
 */
import { describe, expect, it } from "vitest";

import { parseOneChain } from "../../src/config.js";

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
