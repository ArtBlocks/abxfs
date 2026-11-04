/**
 * Config resolution: builtins, file overlay, env override.
 *
 * The behavior worth pinning is the *merge*, not the parse. Getting precedence wrong here fails in
 * the worst available way: a partially-overridden address block silently points reads at a mix of
 * two deployments, and every CID involved still looks well-formed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CANONICAL_DEPLOYMENTS } from "@abxfs/sdk";

import { BUILTIN_CHAINS, loadConfig, resolveChain, requireOrg, resolveOrg } from "../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@abxfs/sdk", async (orig) => (await import("../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const CANONICAL = CANONICAL_DEPLOYMENTS[84532]!;

let dir: string;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-cfg-"));
  delete process.env["ABXFS_RPC_URL"];
  delete process.env["ABXFS_RPC_URL_84532"];
  process.env["ABXFS_CONFIG"] = join(dir, "missing.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

function writeConfig(obj: unknown): void {
  const p = join(dir, "cfg.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env["ABXFS_CONFIG"] = p;
}

describe("zero config", () => {
  /**
   * The headline claim: install the CLI, run a command, no setup. If this breaks, the documented
   * quickstart is wrong.
   */
  it("resolves a usable chain with no config file at all", () => {
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.chainId).toBe(84532);
    expect(chain.rpcUrl).toMatch(/^https:\/\//);
    expect(chain.addresses!.sstore2Backend).toBe(CANONICAL.addresses!.sstore2Backend);
    expect(chain.addresses!.orgFactory).toBe(CANONICAL.addresses!.orgFactory);
  });

  it("exposes one builtin per canonical deployment", () => {
    expect(Object.keys(BUILTIN_CHAINS)).toContain("base-sepolia");
    for (const name of ["base", "ethereum", "arbitrum-one", "arbitrum-sepolia"]) {
      expect(Object.keys(BUILTIN_CHAINS)).toContain(name);
    }
    expect(Object.keys(BUILTIN_CHAINS).length).toBe(Object.keys(CANONICAL_DEPLOYMENTS).length);
  });

  /**
   * A builtin chain sets no codec and no FastLZ choice, so `resolveContentOptions` gives every upload the protocol
   * default: no file codec (so the chain can read and IPFS-derive every file itself) and FastLZ per chunk.
   */
  it("leaves the content options at the protocol default on the canonical chain", async () => {
    const { resolveContentOptions } = await import("../src/codec.js");
    const b = BUILTIN_CHAINS["base-sepolia"]!;
    expect(b.defaultCodec).toBeUndefined();
    expect(b.fastLz).toBeUndefined();
    expect(resolveContentOptions(b, {})).toEqual({ codec: `0x${"00".repeat(32)}`, fastLz: true });
  });
});

describe("file overlay", () => {
  it("accepts an entry that changes only the RPC URL", () => {
    writeConfig({ chains: { "base-sepolia": { rpcUrl: "https://keyed.example/abc" } } });
    const chain = resolveChain(loadConfig(), "base-sepolia");

    expect(chain.rpcUrl).toBe("https://keyed.example/abc");
    // Everything unstated still comes from canonical — the point of the merge.
    expect(chain.addresses!.sstore2Backend).toBe(CANONICAL.addresses!.sstore2Backend);
    expect(chain.chainId).toBe(84532);
  });

  /**
   * A partial address override must not blank the rest. Replacing the whole block would leave
   * `sstore2Backend` undefined while the config looks like it only touched one contract.
   */
  it("merges a partial address block over canonical instead of replacing it", () => {
    const custom = "0x00000000000000000000000000000000000000Ab";
    writeConfig({ chains: { "base-sepolia": { addresses: { ipfsCidResolver: custom } } } });
    const chain = resolveChain(loadConfig(), "base-sepolia");

    expect(chain.addresses!.ipfsCidResolver).toBe(custom);
    expect(chain.addresses!.sstore2Backend).toBe(CANONICAL.addresses!.sstore2Backend);
    expect(chain.addresses!.fileStore).toBe(CANONICAL.addresses!.fileStore);
  });

  it("keeps builtins available alongside a custom chain", () => {
    writeConfig({
      chains: {
        local: {
          chainId: 31337,
          rpcUrl: "http://127.0.0.1:8545",
          addresses: {
            sstore2Backend: "0x0000000000000000000000000000000000000001",
            chunkStore: "0x0000000000000000000000000000000000000002",
            fastLzBackend: "0x0000000000000000000000000000000000000005",
            fileStore: "0x0000000000000000000000000000000000000003",
            directoryStore: "0x0000000000000000000000000000000000000004",
          },
        },
      },
    });
    const cfg = loadConfig();
    expect(resolveChain(cfg, "local").chainId).toBe(31337);
    expect(resolveChain(cfg, "base-sepolia").chainId).toBe(84532);
  });

  it("honors defaultChain from the file", () => {
    writeConfig({ defaultChain: "base-sepolia", chains: {} });
    expect(resolveChain(loadConfig()).chainId).toBe(84532);
  });
});

describe("env override", () => {
  /**
   * The regression this pins: the override was applied only while merging a config *file*, so with
   * no file — the zero-config path the builtins exist for — `ABXFS_RPC_URL_*` was silently ignored
   * and the built-in public endpoint was used instead. Caught by a live outage on that endpoint, not
   * by the suite, because every other test here writes a config file first.
   */
  it("applies to a builtin with NO config file present", () => {
    process.env["ABXFS_RPC_URL_84532"] = "https://keyed.example/no-file";
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://keyed.example/no-file");
  });

  /**
   * The unsuffixed ABXFS_RPC_URL applies to the SELECTED chain only, and says so (audit F3). It once overrode every
   * chain's endpoint, so a variable meant for one chain pointed every other `--chain` at the same node.
   */
  it("applies the global override to the selected builtin only, and says which chain it applied to", () => {
    process.env["ABXFS_RPC_URL"] = "https://keyed.example/global-no-file";
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cfg = loadConfig();
    expect(resolveChain(cfg, "base-sepolia").rpcUrl).toBe("https://keyed.example/global-no-file");
    expect(resolveChain(cfg, "base-sepolia").fallbackRpcUrls).toEqual([]);
    expect(err.mock.calls.flat().join(" ")).toMatch(/ABXFS_RPC_URL applies to the selected chain only: base-sepolia \(chain 84532\)/);
    // Not baked into the other chains: each is the built-in until it is the one selected.
    expect(cfg.chains["ethereum"]!.rpcUrl).not.toBe("https://keyed.example/global-no-file");
    expect(cfg.chains["base-sepolia"]!.rpcUrl).not.toBe("https://keyed.example/global-no-file");
    // Never printed whole: an RPC URL usually carries a key in its path.
    expect(err.mock.calls.flat().join(" ")).not.toContain("global-no-file");
  });

  it("never overrides an rpcUrl a config file sets", () => {
    process.env["ABXFS_RPC_URL"] = "https://global.example/key";
    writeConfig({ chains: { "base-sepolia": { rpcUrl: "https://from-file.example" } } });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://from-file.example");
    expect(err.mock.calls.flat().join(" ")).toMatch(/ABXFS_RPC_URL is not used for base-sepolia/);
  });

  it("never overrides ABXFS_RPC_URL_<chainId>", () => {
    process.env["ABXFS_RPC_URL"] = "https://global.example/key";
    process.env["ABXFS_RPC_URL_84532"] = "https://specific.example/key";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://specific.example/key");
  });

  it("refuses an ABXFS_RPC_URL that is not an http(s) URL, without echoing it", () => {
    process.env["ABXFS_RPC_URL"] = "ftp://secret.example/KEY123";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let msg = "";
    try {
      resolveChain(loadConfig(), "base-sepolia");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/ABXFS_RPC_URL must be an http\(s\) URL/);
    expect(msg).not.toContain("KEY123");
  });

  it("prefers the chain-specific override over the global one", () => {
    process.env["ABXFS_RPC_URL"] = "https://global.example/key";
    process.env["ABXFS_RPC_URL_84532"] = "https://specific.example/key";
    writeConfig({ chains: { "base-sepolia": { rpcUrl: "https://from-file" } } });
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://specific.example/key");
  });
});

describe("refusals", () => {
  /**
   * A non-canonical chain has no addresses to fall back on, so accepting the entry would defer the
   * failure to the first read — where it surfaces as an empty result rather than a config error.
   */
  it("refuses a non-canonical chain with no addresses", () => {
    writeConfig({ chains: { weird: { chainId: 12345, rpcUrl: "https://x.example" } } });
    expect(() => loadConfig()).toThrow(/no canonical ABX FS deployment/);
  });

  it("refuses a nonsense chainId", () => {
    writeConfig({ chains: { bad: { chainId: -1, rpcUrl: "https://x.example" } } });
    expect(() => loadConfig()).toThrow(/positive integer/);
  });

  it("names the available chains when one is misspelled", () => {
    expect(() => resolveChain(loadConfig(), "base-sepolai")).toThrow(/base-sepolia/);
  });
});

describe("defaultCodec in a config file", () => {
  let d: string;
  beforeEach(() => {
    d = mkdtempSync(join(tmpdir(), "abxfs-codec-"));
  });
  afterEach(() => {
    rmSync(d, { recursive: true, force: true });
    delete process.env["ABXFS_CONFIG"];
  });

  it("refuses an unknown defaultCodec at load, not at the first upload", () => {
    const p = join(d, "c.json");
    writeFileSync(p, JSON.stringify({ chains: { "base-sepolia": { defaultCodec: "lz4" } } }));
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/unknown file codec "lz4"/);
  });
});

describe("codec names", () => {
  const label = (t: string) => `0x${Buffer.from(t).toString("hex").padEnd(64, "0")}`;

  /** `upload`, `update` and `diff` all name codecs through this, so the three can only agree. */
  it("maps every file codec the CLI offers to its IANA token label", async () => {
    const { codecFromName } = await import("../src/codec.js");
    expect(codecFromName("none")).toBe(`0x${"00".repeat(32)}`);
    expect(codecFromName("gzip")).toBe(label("gzip"));
    expect(codecFromName("GZIP")).toBe(label("gzip"));
  });

  /** Only codecs every reader here can decode: a `br` file would upload fine and then fail to serve. */
  it("refuses codecs the readers cannot decode, naming the set it offers", async () => {
    const { codecFromName } = await import("../src/codec.js");
    for (const n of ["br", "brotli", "zstd", "deflate", "lz4"]) expect(() => codecFromName(n)).toThrow(/none\|gzip/);
  });

  /**
   * FastLZ is a storage backend chosen per chunk, not a file codec, so a `--codec fastlz` would mean something it
   * cannot; the refusal says what to do instead.
   */
  it("refuses fastlz as a file codec and points at the per-chunk backend", async () => {
    const { codecFromName } = await import("../src/codec.js");
    expect(() => codecFromName("fastlz")).toThrow(/not a file codec.*--no-fastlz/s);
  });

  it("flags win over the chain's config, which wins over the default", async () => {
    const { resolveContentOptions } = await import("../src/codec.js");
    const chain = { ...BUILTIN_CHAINS["base-sepolia"]!, defaultCodec: "gzip", fastLz: false };
    expect(resolveContentOptions(chain, {})).toEqual({ codec: label("gzip"), fastLz: false });
    expect(resolveContentOptions(chain, { codec: "none", fastlz: true })).toEqual({ codec: `0x${"00".repeat(32)}`, fastLz: true });
  });
});

describe("RPC failover", () => {
  /**
   * A public endpoint going down should degrade to "slower" rather than "broken". This is exactly
   * what happened: `sepolia.base.org` returned 503 "no backend is currently healthy" mid-session,
   * and with one hardcoded URL the zero-config path stopped working entirely.
   */
  it("gives builtins alternate endpoints to fall back to", () => {
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.fallbackRpcUrls?.length).toBeGreaterThan(0);
    expect(chain.fallbackRpcUrls).not.toContain(chain.rpcUrl);
  });

  /**
   * Failing over from a user's chosen endpoint to a public one would send their reads to a node they
   * never picked — a privacy leak, not a convenience.
   */
  it("never adds public fallbacks to a user-supplied endpoint", () => {
    writeConfig({ chains: { "base-sepolia": { rpcUrl: "https://keyed.example/abc" } } });
    expect(resolveChain(loadConfig(), "base-sepolia").fallbackRpcUrls).toEqual([]);
  });

  it("drops fallbacks when the endpoint comes from an env override", () => {
    process.env["ABXFS_RPC_URL_84532"] = "https://keyed.example/env";
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.rpcUrl).toBe("https://keyed.example/env");
    expect(chain.fallbackRpcUrls).toEqual([]);
  });
});

describe("choosing a network", () => {
  /**
   * There is no built-in network. Every canonical one is configured, production included, so a command that
   * names none used to fall back to one the caller never chose (Base), where a write spends real funds.
   */
  it("refuses a command that names no network, and lists them", () => {
    const cfg = loadConfig();
    expect(Object.keys(cfg.chains).length).toBeGreaterThan(1);
    expect(() => resolveChain(cfg, undefined)).toThrow(/no network chosen — pass --chain <name>, set ABXFS_CHAIN, or set defaultChain in ~\/\.config\/abxfs\/config\.json/);
    expect(() => resolveChain(cfg, undefined)).toThrow(/Available: .*base-sepolia/);
  });

  it("honors an explicit --chain", () => {
    const cfg = loadConfig();
    expect(resolveChain(cfg, "base-sepolia").chainId).toBe(84532);
    expect(resolveChain(cfg, "base").chainId).toBe(8453);
    expect(resolveChain(cfg, "ethereum").chainId).toBe(1);
    expect(resolveChain(cfg, "arbitrum-one").chainId).toBe(42161);
    expect(resolveChain(cfg, "arbitrum-sepolia").chainId).toBe(421614);
  });

  it("uses defaultChain from config when --chain is not given", () => {
    const cfg = loadConfig();
    const pinned = { ...cfg, defaultChain: "base-sepolia" };
    expect(resolveChain(pinned, undefined).chainId).toBe(84532);
    expect(resolveChain(pinned, "ethereum").chainId).toBe(1);
  });

  it("takes ABXFS_CHAIN over defaultChain, and --chain over both; a blank one is unset", () => {
    const prev = process.env["ABXFS_CHAIN"];
    try {
      const pinned = { ...loadConfig(), defaultChain: "base-sepolia" };
      process.env["ABXFS_CHAIN"] = "arbitrum-sepolia";
      expect(resolveChain(pinned, undefined).chainId).toBe(421614);
      expect(resolveChain(pinned, "sepolia").chainId).toBe(11155111);
      process.env["ABXFS_CHAIN"] = "  ";
      expect(resolveChain(pinned, undefined).chainId).toBe(84532);
      process.env["ABXFS_CHAIN"] = "nope";
      expect(() => resolveChain(pinned, undefined)).toThrow(/unknown chain "nope"/);
    } finally {
      if (prev === undefined) delete process.env["ABXFS_CHAIN"];
      else process.env["ABXFS_CHAIN"] = prev;
    }
  });
});

/**
 * Projects live in orgs and token ids repeat across them, so a command that names a project must
 * know the org. These pin where it comes from and what the error says when it is missing.
 */
describe("org resolution", () => {
  const ORG = "0x00000000000000000000000000000000000000aa";
  const OTHER = "0x00000000000000000000000000000000000000bb";
  const prev = process.env["ABXFS_ORG"];
  const chain = () => resolveChain(loadConfig(), "base-sepolia");

  afterEach(() => {
    if (prev === undefined) delete process.env["ABXFS_ORG"];
    else process.env["ABXFS_ORG"] = prev;
  });

  it("prefers the flag, then ABXFS_ORG, then the chain's configured org", () => {
    const c = { ...chain(), org: OTHER as `0x${string}` };
    process.env["ABXFS_ORG"] = "0x00000000000000000000000000000000000000cc";
    expect(resolveOrg(c, ORG)).toBe(ORG);
    expect(resolveOrg(c)).toBe("0x00000000000000000000000000000000000000cc");
    delete process.env["ABXFS_ORG"];
    expect(resolveOrg(c)).toBe(OTHER);
    expect(resolveOrg(chain())).toBeUndefined();
  });

  it("rejects something that is not an address rather than guessing", () => {
    expect(() => resolveOrg(chain(), "not-an-address")).toThrow(/not a valid org address/);
  });

  it("says what to do when no org is set, instead of failing later in a read", () => {
    delete process.env["ABXFS_ORG"];
    expect(() => requireOrg(chain())).toThrow(/--org <address>.*ABXFS_ORG.*abxfs org list/s);
  });

  it("Base has an org factory now, so it asks for an org like any other chain", () => {
    delete process.env["ABXFS_ORG"];
    const base = resolveChain(loadConfig(), "base");
    expect(() => requireOrg(base)).toThrow(/--org <address>.*ABXFS_ORG.*abxfs org list/s);
  });
});
