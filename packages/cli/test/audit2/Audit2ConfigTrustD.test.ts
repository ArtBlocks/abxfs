/** Audit2 (D): can an untrusted ./.abxfs.json still steer writes without --allow-config-overrides? */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveChain, setAllowConfigOverrides } from "../../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@artblocks/abxfs-sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const saved = { ...process.env };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-a2-"));
  for (const k of ["ABXFS_CONFIG", "ABXFS_RPC_URL", "ABXFS_RPC_URL_84532", "ABXFS_ALLOW_CONFIG_OVERRIDES"]) delete process.env[k];
  setAllowConfigOverrides(false);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...saved }; vi.restoreAllMocks(); });

const A = "0x00000000000000000000000000000000000a77ac";
describe("untrusted cwd config", () => {
  it("a NEW chain name with a canonical chainId and attacker addresses is NOT vetted when a different existing name is not used", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({
      defaultChain: "evil",
      chains: { evil: { chainId: 84532, rpcUrl: "https://attacker.example", addresses: { sstore2Backend: A, fastLzBackend: A, chunkStore: A, fileStore: A, directoryStore: A, projectHook: A } } },
    }));
    const cfg = loadConfig();
    // Expectation if secure: the new name is dropped, and its defaultChain cannot select anything.
    expect(cfg.chains["evil"]).toBeUndefined();
    expect(() => resolveChain(cfg, undefined)).toThrow(/no network chosen/);
    expect(resolveChain(cfg, "base-sepolia").addresses!.sstore2Backend.toLowerCase()).not.toBe(A);
  });
  it("defaultChain/org from the cwd file are IGNORED (fixed)", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({
      defaultChain: "base-sepolia",
      chains: { "base-sepolia": { org: A } },
    }));
    expect(loadConfig().defaultChain).toBeUndefined();
    expect(() => resolveChain(loadConfig(), undefined)).toThrow(/no network chosen/);
    expect(resolveChain(loadConfig(), "base-sepolia").org).toBeUndefined();
  });
  it("a cwd file's defaultChain is ignored; home config is still shadowed (not merged) by it (accepted: only the first file that exists is read)", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ defaultChain: "base-sepolia", chains: {} }));
    const cfg = loadConfig();
    expect(cfg.defaultChain).toBeUndefined();
  });
});

describe("untrusted cwd: non-canonical chainId", () => {
  it("chainId 1 (mainnet, no canonical ABX FS) with attacker rpc+addresses can NOT be selected by defaultChain (fixed)", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({
      defaultChain: "evil",
      chains: { evil: { chainId: 1, rpcUrl: "https://attacker.example", addresses: { sstore2Backend: A, fastLzBackend: A, chunkStore: A, fileStore: A, directoryStore: A } } },
    }));
    const cfg = loadConfig();
    expect(cfg.chains["evil"]).toBeUndefined();
    expect(() => resolveChain(cfg, undefined)).toThrow(/no network chosen/);
    expect(() => resolveChain(cfg, "evil")).toThrow(/unknown chain/);
  });
});
