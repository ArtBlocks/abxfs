/**
 * Config trust (audit M7). A `.abxfs.json` in the working directory is whatever the directory you are
 * standing in says. It must not be able to silently redirect canonical contract addresses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CANONICAL_DEPLOYMENTS } from "@artblocks/abxfs-sdk";

import { getPrivateKey, loadConfig, resolveChain, setAllowConfigOverrides } from "../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@artblocks/abxfs-sdk", async (orig) => (await import("../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const CANONICAL = CANONICAL_DEPLOYMENTS[84532]!;
const ATTACKER = "0x00000000000000000000000000000000000a77ac";
const saved = { ...process.env };
let dir: string;
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-trust-"));
  delete process.env["ABXFS_CONFIG"];
  delete process.env["ABXFS_RPC_URL"];
  delete process.env["ABXFS_RPC_URL_84532"];
  delete process.env["ABXFS_ALLOW_CONFIG_OVERRIDES"];
  setAllowConfigOverrides(false);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  err = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
  setAllowConfigOverrides(false);
  vi.restoreAllMocks();
});

const evil = {
  chains: {
    "base-sepolia": {
      rpcUrl: "https://evil.example/rpc/SECRETKEY",
      addresses: { sstore2Backend: ATTACKER, orgFactory: ATTACKER, projectHook: ATTACKER },
    },
  },
};

describe("a .abxfs.json in the working directory", () => {
  it("cannot override canonical addresses: they are ignored, with a loud warning naming file and keys", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify(evil));
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.addresses!.sstore2Backend).toBe(CANONICAL.addresses!.sstore2Backend);
    expect(chain.addresses!.orgFactory).toBe(CANONICAL.addresses!.orgFactory);
    const out = err.join("\n");
    expect(out).toContain(join(dir, ".abxfs.json"));
    for (const k of ["addresses.sstore2Backend", "addresses.orgFactory", "addresses.projectHook"]) {
      expect(out).toContain(k);
    }
    expect(out).toMatch(/IGNORED/);
    expect(out).toContain("--allow-config-overrides");
  });

  it("applies them only with the explicit opt-in (flag or env), still warning", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify(evil));
    process.env["ABXFS_ALLOW_CONFIG_OVERRIDES"] = "1";
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.addresses!.sstore2Backend).toBe(ATTACKER);
    expect(err.join("\n")).toMatch(/Applying them/);

    setAllowConfigOverrides(true);
    delete process.env["ABXFS_ALLOW_CONFIG_OVERRIDES"];
    expect(resolveChain(loadConfig(), "base-sepolia").addresses!.orgFactory).toBe(ATTACKER);
  });

  it("an RPC override is IGNORED (the node chooses fees and sees every read), naming the key but never printing the URL", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { rpcUrl: "https://rpc.example/v2/SECRETKEY", fallbackRpcUrls: ["https://f.example/KEY2"] } } }));
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.rpcUrl).not.toContain("rpc.example");
    expect(chain.fallbackRpcUrls?.join()).not.toContain("f.example");
    expect(chain.addresses!.orgFactory).toBe(CANONICAL.addresses!.orgFactory);
    const out = err.join("\n");
    expect(out).toContain("chains.base-sepolia.rpcUrl");
    expect(out).toContain("chains.base-sepolia.fallbackRpcUrls");
    expect(out).not.toContain("SECRETKEY");
  });

  it("applies an RPC override with the opt-in", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { rpcUrl: "https://rpc.example/v2/SECRETKEY" } } }));
    setAllowConfigOverrides(true);
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://rpc.example/v2/SECRETKEY");
  });

  it("cannot re-point a canonical chain by changing its chainId", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { chainId: 1 } } }));
    expect(resolveChain(loadConfig(), "base-sepolia").chainId).toBe(84532);
  });

  it("does NOT define a chain with no canonical deployment (a local anvil): use ABXFS_CONFIG; warns", () => {
    const local = {
      chains: {
        local: {
          chainId: 31337,
          rpcUrl: "http://127.0.0.1:8545",
          addresses: { sstore2Backend: ATTACKER, fastLzBackend: ATTACKER, chunkStore: ATTACKER, fileStore: ATTACKER, directoryStore: ATTACKER },
        },
      },
    };
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify(local));
    expect(() => resolveChain(loadConfig(), "local")).toThrow(/unknown chain/);
    expect(err.join("\n")).toContain("chains.local");
    setAllowConfigOverrides(true);
    expect(resolveChain(loadConfig(), "local").addresses!.sstore2Backend).toBe(ATTACKER);
  });

  it("ignores defaultChain, org and the upload tunables, listing each", () => {
    writeFileSync(
      join(dir, ".abxfs.json"),
      JSON.stringify({ defaultChain: "base-sepolia", chains: { "base-sepolia": { org: ATTACKER, defaultBundleGasBudget: 1, defaultCodec: "gzip", fastLz: false } } }),
    );
    const cfg = loadConfig();
    expect(cfg.defaultChain).toBeUndefined();
    const c = resolveChain(cfg, "base-sepolia");
    expect(c.org).toBeUndefined();
    expect(c.defaultBundleGasBudget).toBeUndefined();
    expect(c.defaultCodec).toBeUndefined();
    expect(c.fastLz).toBeUndefined();
    const out = err.join("\n");
    for (const k of ["defaultChain", "base-sepolia.org", "defaultBundleGasBudget", "defaultCodec", "fastLz"]) expect(out).toContain(k);
  });

  it("refuses prototype-poisoning chain names: an untrusted cwd file is IGNORED with a warning, not fatal", () => {
    writeFileSync(join(dir, ".abxfs.json"), `{"chains":{"__proto__":{"chainId":84532}}}`);
    expect(() => loadConfig()).not.toThrow();
    expect(err.join("\n")).toMatch(/ignoring .*\.abxfs\.json.*not a valid chain name/s);
    expect(({} as Record<string, unknown>)["chainId"]).toBeUndefined();
  });
  it("...while the same file in ABXFS_CONFIG (trusted, deliberately set) is fatal", () => {
    const p = join(dir, "mine.json");
    writeFileSync(p, `{"chains":{"__proto__":{"chainId":84532}}}`);
    process.env["ABXFS_CONFIG"] = p;
    expect(() => loadConfig()).toThrow(/not a valid chain name/);
  });

});

describe("ABXFS_CONFIG is trusted", () => {
  it("honours address overrides without any flag", () => {
    const p = join(dir, "mine.json");
    writeFileSync(p, JSON.stringify(evil));
    process.env["ABXFS_CONFIG"] = p;
    expect(resolveChain(loadConfig(), "base-sepolia").addresses!.sstore2Backend).toBe(ATTACKER);
    expect(err).toEqual([]);
  });
});

describe("private key", () => {
  it("reads only ABXFS_PRIVATE_KEY, never a generic PRIVATE_KEY", () => {
    delete process.env["ABXFS_PRIVATE_KEY"];
    process.env["PRIVATE_KEY"] = "0x" + "11".repeat(32);
    expect(getPrivateKey()).toBeUndefined();
    process.env["ABXFS_PRIVATE_KEY"] = "0x" + "22".repeat(32);
    expect(getPrivateKey()).toBe("0x" + "22".repeat(32));
  });
});
