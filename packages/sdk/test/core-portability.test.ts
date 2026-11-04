/**
 * `@abxfs/sdk/core` must stay chain-free and runtime-agnostic.
 *
 * The value of that entry point is entirely a negative claim — "this needs no node, no wallet, no
 * Node.js" — and a negative claim in a doc comment decays the moment someone adds a convenient
 * import. So it is asserted here structurally, not described.
 *
 * These tests run with no chain and no harness, which is itself part of the point.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as core from "../src/core.js";

const CORE_SRC = resolve(__dirname, "../src/core.ts");

describe("core is chain-free", () => {
  /**
   * The structural guard. If someone re-exports `read.js`, `project.js`, `upload.js`, `logs.js`,
   * `verify.js`, `draft.js`, `update.js`, `kind.js`, `multicall.js` or `abxfs.js` from core, the
   * entry point silently starts requiring a PublicClient and this fails.
   */
  it("re-exports only modules that never touch a chain", () => {
    const src = readFileSync(CORE_SRC, "utf8");
    const reexported = [...src.matchAll(/from "\.\/([^"]+)\.js"/g)].map((m) => m[1]!);

    const CHAIN_BOUND = [
      "read", "project", "upload", "update", "draft", "verify",
      "kind", "logs", "multicall", "abxfs", "abi", "abi-hook", "abi-org", "abi-enumeration",
      "org", "publish", "settle", "content-write",
    ];
    for (const mod of reexported) {
      expect(CHAIN_BOUND, `core must not re-export chain-bound module "${mod}"`).not.toContain(mod);
    }
    // Sanity: the list was actually populated, so a regex change cannot vacuously pass this.
    expect(reexported.length).toBeGreaterThan(5);
  });

  it("exposes no symbol that takes a client", () => {
    // A crude but effective proxy: nothing in core should be named like a chain call.
    const suspicious = Object.keys(core).filter((k) =>
      /^(read|write|publish|upload|fetch|resolveOnChain|verifyOnChain)/.test(k),
    );
    expect(suspicious).toEqual([]);
  });

  /**
   * `autoRegisterNodeCodecs` imports `node:zlib`, but LAZILY — inside the function body. If it moved
   * to a top-level import, `@abxfs/sdk/core` would stop loading in a browser or edge runtime, which
   * is the specific failure this guards.
   */
  it("keeps node:* imports lazy so the module loads in a browser", () => {
    for (const file of ["compression.ts", "fastlz.ts", "cid.ts", "util.ts", "validate.ts", "types.ts"]) {
      const src = readFileSync(resolve(__dirname, "../src", file), "utf8");
      const topLevel = src
        .split("\n")
        .filter((l) => /^\s*import\s/.test(l) && /["']node:/.test(l));
      expect(topLevel, `${file} must not import node:* at the top level`).toEqual([]);
    }
  });
});

describe("core does real work with no chain", () => {
  const bytes = new TextEncoder().encode("the quick brown fox ".repeat(400));

  it("chunks deterministically", () => {
    const a = core.chunkBytes(bytes, { backendMax: 4096 });
    const b = core.chunkBytes(bytes, { backendMax: 4096 });
    expect(a.map((c) => c.length)).toEqual(b.map((c) => c.length));
    expect(a.reduce((n, c) => n + c.length, 0)).toBe(bytes.length);
  });

  /**
   * The backends are part of every chunk id, so offline derivation needs them, and a consumer passes the backends it
   * means (`planBackendsFor(addresses)`). Stand-ins here, so the vector does not depend on any deployment.
   */
  it("derives an ABX FS file CID offline", async () => {
    const backends = {
      raw: "0x00000000000000000000000000000000000000aa" as const,
      fastLz: "0x00000000000000000000000000000000000000bb" as const,
    };
    const a = await core.planFile({ backends, bytes, mimeType: "text/plain" });
    expect(a.cid).toMatch(/^0x[0-9a-f]{64}$/);
    // Deterministic: same inputs, same CID. This is what lets a client predict an upload.
    const b = await core.planFile({ backends, bytes, mimeType: "text/plain" });
    expect(b.cid).toBe(a.cid);
    // The text compresses, so its chunks went to the FastLZ backend.
    expect(a.chunks.every((c) => c.backend === backends.fastLz)).toBe(true);
  });

  /**
   * The ABX FS CID commits to how content is stored; the IPFS CID to the content. Compressing changes the first and
   * not the second — the single most important thing to understand before using either.
   */
  it("derives an IPFS CID that is invariant to compression", async () => {
    const packed = core.flzCompress(bytes);
    expect(packed.length).toBeLessThan(bytes.length);

    const ipfsPlain = await core.ipfsFileCid(bytes);
    const ipfsRoundTripped = await core.ipfsFileCid(core.flzDecompress(packed));

    expect(ipfsRoundTripped).toBe(ipfsPlain);
    expect(ipfsPlain.startsWith("bafk") || ipfsPlain.startsWith("bafy")).toBe(true);
  });

  it("round-trips FastLZ with no Node APIs", () => {
    const out = core.flzDecompress(core.flzCompress(bytes));
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(bytes));
  });
});
