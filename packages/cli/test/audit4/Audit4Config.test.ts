import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_CHAINS, loadConfig, resolveChain, setAllowConfigOverrides } from "../../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@abxfs/sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const cwd0 = process.cwd(); const env0 = { ...process.env };
let dir: string, home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a4c-")); home = mkdtempSync(join(tmpdir(), "a4h-"));
  process.chdir(dir); process.env["HOME"] = home;
  for (const k of Object.keys(process.env)) if (k.startsWith("ABXFS_")) delete process.env[k];
  setAllowConfigOverrides(false); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.chdir(cwd0); for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k]; process.env["HOME"] = env0["HOME"]; vi.restoreAllMocks(); });

describe("Audit4 config", () => {
  it("a DIRECTORY named .abxfs.json and a malformed cwd file are skipped, not fatal", () => {
    mkdirSync(join(dir, ".abxfs.json"));
    expect(() => loadConfig()).not.toThrow();
    process.chdir(cwd0);
    const d2 = mkdtempSync(join(tmpdir(), "a4c-")); process.chdir(d2);
    writeFileSync(join(d2, ".abxfs.json"), "{not json");
    expect(() => loadConfig()).not.toThrow();
  });
  it("cwd file cannot add a new chain, set defaultChain, or smuggle previousGenerations / org through a known chain", () => {
    const B = BUILTIN_CHAINS["base-sepolia"]!;
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ defaultChain: "evil", chains: {
      evil: { chainId: 1, rpcUrl: "http://evil", addresses: B.addresses },
      "base-sepolia": { chainId: 84532, addresses: { ...B.addresses, previousGenerations: [{ orgFactory: "0x" + "11".repeat(20) }] } } } }));
    const cfg = loadConfig();
    expect(cfg.defaultChain).toBeUndefined();
    expect(Object.keys(cfg.chains)).not.toContain("evil");
    expect(resolveChain(cfg, "base-sepolia").addresses!.previousGenerations).toEqual(B.addresses!.previousGenerations);
  });
  it("cwd overlay on a chain defined by the (trusted) HOME config cannot touch its addresses either", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    const B = BUILTIN_CHAINS["base-sepolia"]!;
    writeFileSync(join(home, ".config/abxfs/config.json"), JSON.stringify({ chains: { mine: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", addresses: { ...B.addresses, sstore2Backend: "0x" + "22".repeat(20) } } } }));
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { mine: { chainId: 31337, rpcUrl: "http://evil", addresses: { sstore2Backend: "0x" + "33".repeat(20) } } } }));
    const c = resolveChain(loadConfig(), "mine");
    expect(c.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(c.addresses!.sstore2Backend).toBe("0x" + "22".repeat(20));
  });
  it("ABXFS_CONFIG pointing at an attacker file is fully trusted BY DESIGN (env is the user's); relative path equal to cwd file is trusted too", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { chainId: 84532, rpcUrl: "http://attacker" } } }));
    process.env["ABXFS_CONFIG"] = ".abxfs.json";
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("http://attacker");
  });
});
