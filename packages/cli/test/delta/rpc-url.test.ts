/**
 * Delta audit (informational, ported from the auditor's PoC): `ABXFS_RPC_URL` and a chain with no endpoint.
 *
 *  (a) a trusted config entry for a built-in chain that sets only `org` keeps the built-in endpoint, so the unsuffixed
 *      ABXFS_RPC_URL still applies to it when it is selected (the `builtinRpc.add(out)` branch of `mergeChain`);
 *  (b) a trusted config entry for a custom chain with no `rpcUrl` (which freeze-1 loaded from ABXFS_RPC_URL) made
 *      `loadConfig` throw, so EVERY command failed, whichever chain it was for. It is now refused only when that chain
 *      is selected, and ABXFS_RPC_URL_<chainId> (not the unsuffixed variable) gives it an endpoint.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, resolveChain } from "../../src/config.js";

const saved = { ...process.env };
let cfgPath: string;
let stderr: string[];
beforeEach(() => {
  cfgPath = join(mkdtempSync(join(tmpdir(), "abxfs-rpc-")), "config.json");
  process.env["ABXFS_CONFIG"] = cfgPath;
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "abxfs-home-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("ABXFS_RPC_URL")) delete process.env[k];
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.map(String).join(" ")));
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const LOCAL = { chainId: 31337, addresses: { chunkStore: a(1), fileStore: a(2), directoryStore: a(3), sstore2Backend: a(4), fastLzBackend: a(5) } };

describe("ABXFS_RPC_URL", () => {
  it("(a) still applies to a built-in chain whose config entry sets only org", () => {
    writeFileSync(cfgPath, JSON.stringify({ chains: { "base-sepolia": { org: a(0xa1) } } }));
    process.env["ABXFS_RPC_URL"] = "https://keyed.example/KEY";
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.rpcUrl).toBe("https://keyed.example/KEY");
    expect(c.fallbackRpcUrls).toEqual([]);
    expect(c.org).toBe(a(0xa1));
    expect(stderr.join("\n")).toMatch(/ABXFS_RPC_URL applies to the selected chain only: base-sepolia/);
  });

  it("(a') a built-in chain whose config entry sets its own rpcUrl keeps it, and says ABXFS_RPC_URL is not used", () => {
    writeFileSync(cfgPath, JSON.stringify({ chains: { "base-sepolia": { rpcUrl: "https://mine.example/" } } }));
    process.env["ABXFS_RPC_URL"] = "https://keyed.example/KEY";
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.rpcUrl).toBe("https://mine.example/");
    expect(stderr.join("\n")).toMatch(/ABXFS_RPC_URL is not used for base-sepolia/);
  });

  it("(b) a custom chain with no rpcUrl no longer stops commands on other chains", () => {
    writeFileSync(cfgPath, JSON.stringify({ chains: { local: LOCAL } }));
    process.env["ABXFS_RPC_URL"] = "http://127.0.0.1:8545";
    const cfg = loadConfig(); // freeze-2 threw here, for every command
    expect(resolveChain(cfg, "base-sepolia").chainId).toBe(84532);
  });

  it("(b) ...and is refused when it is the chain selected, the unsuffixed ABXFS_RPC_URL notwithstanding", () => {
    writeFileSync(cfgPath, JSON.stringify({ chains: { local: LOCAL } }));
    process.env["ABXFS_RPC_URL"] = "http://127.0.0.1:8545";
    expect(() => resolveChain(loadConfig(), "local")).toThrow(/Refusing to use chain "local": rpcUrl is required \(or set ABXFS_RPC_URL_31337\)/);
  });

  it("(b) ...and as the configured defaultChain, with no --chain", () => {
    writeFileSync(cfgPath, JSON.stringify({ defaultChain: "local", chains: { local: LOCAL } }));
    expect(() => resolveChain(loadConfig())).toThrow(/rpcUrl is required/);
  });

  it("(b) ABXFS_RPC_URL_<chainId> gives it an endpoint", () => {
    writeFileSync(cfgPath, JSON.stringify({ chains: { local: LOCAL } }));
    process.env["ABXFS_RPC_URL_31337"] = "http://127.0.0.1:8545";
    const c = resolveChain(loadConfig(), "local");
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(c.fallbackRpcUrls).toEqual([]);
  });
});
