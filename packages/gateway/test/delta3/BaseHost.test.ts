/**
 * DELTA-3 L2: `abxfs-gateway` checks `--content-domain` with the same function `createGateway` uses for
 * `hostMode.baseHost` (`normalizeBaseHost`, exported for it), before any chain is read, so the flag and the option can
 * never disagree, and the refusal names whichever one the value came from. (The executable itself is exercised in
 * `delta2/BinStartup.test.ts`.)
 */
import { describe, expect, it } from "vitest";

import { createGateway, normalizeBaseHost } from "../../src/handler.js";

describe("normalizeBaseHost", () => {
  it("a bare host, with or without a port, is lowercased and trimmed", () => {
    expect(normalizeBaseHost(" Content.Example ")).toBe("content.example");
    expect(normalizeBaseHost("localhost:8080", "--content-domain")).toBe("localhost:8080");
  });

  it("anything else is refused, naming the flag or the option", () => {
    for (const bad of ["https://bad.example/", "c.example/path", "*.c.example", "-c.example", "c.example:", ""]) {
      expect(() => normalizeBaseHost(bad, "--content-domain"), bad).toThrow(`--content-domain must be a bare host (and optional port), got "${bad}"`);
      expect(() => normalizeBaseHost(bad), bad).toThrow(/^hostMode\.baseHost must be a bare host/);
    }
  });

  it("createGateway refuses the same values, as the option", () => {
    expect(() => createGateway({ chains: [], hostMode: { baseHost: "https://bad.example/" } })).toThrow(
      /hostMode\.baseHost must be a bare host/,
    );
  });
});
