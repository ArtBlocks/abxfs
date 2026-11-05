import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_CHAINS, loadConfig, resolveChain, setAllowConfigOverrides } from "../../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@artblocks/abxfs-sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

let cwd0 = process.cwd();
let dir: string;
let home: string;
const env0 = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "a3cwd-"));
  home = mkdtempSync(join(tmpdir(), "a3home-"));
  process.chdir(dir);
  process.env["HOME"] = home;
  for (const k of Object.keys(process.env)) if (k.startsWith("ABXFS_")) delete process.env[k];
  setAllowConfigOverrides(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.chdir(cwd0); for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k]; process.env["HOME"] = env0["HOME"]; vi.restoreAllMocks(); });

const write = (p: string, o: unknown) => writeFileSync(p, JSON.stringify(o));

describe("Audit3 config trust", () => {
  it("cwd file with prototype-ish keys inside a known chain entry does not pollute or redirect", () => {
    writeFileSync(join(dir, ".abxfs.json"), '{"chains":{"base-sepolia":{"chainId":84532,"addresses":{"__proto__":{"sstore2Backend":"0x1111111111111111111111111111111111111111"},"sstore2Backend":"0x1111111111111111111111111111111111111111"},"rpcUrl":"http://evil.example","org":"0x2222222222222222222222222222222222222222","accountLabel":"x"}}}');
    const cfg = loadConfig();
    const c = resolveChain(cfg, "base-sepolia");
    expect(c.addresses!.sstore2Backend).toBe(BUILTIN_CHAINS["base-sepolia"]!.addresses!.sstore2Backend);
    expect(c.rpcUrl).toBe(BUILTIN_CHAINS["base-sepolia"]!.rpcUrl);
    expect(c.org).toBeUndefined();
    expect(({} as any).sstore2Backend).toBeUndefined();
  });
  it("LAYERED: the user's home config is the BASE; an untrusted cwd file only overlays allowed keys", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    write(join(home, ".config/abxfs/config.json"), { chains: { "base-sepolia": { chainId: 84532, rpcUrl: "https://mine.example/KEY", org: "0x3333333333333333333333333333333333333333" } } });
    write(join(dir, ".abxfs.json"), { chains: { "base-sepolia": { chainId: 84532, accountLabel: "from-cwd", rpcUrl: "https://evil.example", org: "0x4444444444444444444444444444444444444444" } } });
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.rpcUrl).toBe("https://mine.example/KEY");                       // home survives
    expect(c.org).toBe("0x3333333333333333333333333333333333333333");        // cwd `org` is ignored
    expect((c as unknown as Record<string, unknown>)["accountLabel"]).toBeUndefined(); // a dead key (audit F20): reported and dropped
    expect(c.fallbackRpcUrls).toEqual([]);                                   // no public failover for a chosen endpoint
  });
  it("an empty cwd file no longer shadows the home config", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    write(join(home, ".config/abxfs/config.json"), { chains: { "base-sepolia": { chainId: 84532, rpcUrl: "https://mine.example/KEY" } } });
    write(join(dir, ".abxfs.json"), { chains: {} });
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://mine.example/KEY");
  });
  it("home config applied when no cwd file", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    write(join(home, ".config/abxfs/config.json"), { chains: { "base-sepolia": { chainId: 84532, rpcUrl: "https://mine.example/KEY" } } });
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://mine.example/KEY");
  });
  it("home config world-writable is still trusted (no permission check)", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    const p = join(home, ".config/abxfs/config.json");
    write(p, { chains: { "base-sepolia": { chainId: 84532, rpcUrl: "https://attacker.example/" } } });
    chmodSync(p, 0o666);
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://attacker.example/");
  });
  it("cwd file naming an unknown chain whose chainId is 1 is dropped", () => {
    write(join(dir, ".abxfs.json"), { chains: { evil: { chainId: 1, rpcUrl: "http://x", addresses: { sstore2Backend: "0x1111111111111111111111111111111111111111", fastLzBackend: "0x1111111111111111111111111111111111111111", chunkStore: "0x1111111111111111111111111111111111111111", fileStore: "0x1111111111111111111111111111111111111111", directoryStore: "0x1111111111111111111111111111111111111111" } } } });
    expect(Object.keys(loadConfig().chains)).not.toContain("evil");
  });
  it("ABXFS_CONFIG pointing at an attacker file in cwd by relative name is trusted (by design)", () => {
    write(join(dir, ".abxfs.json"), { chains: { "base-sepolia": { chainId: 84532, rpcUrl: "https://attacker.example/" } } });
    process.env["ABXFS_CONFIG"] = ".abxfs.json";
    expect(resolveChain(loadConfig(), "base-sepolia").rpcUrl).toBe("https://attacker.example/");
  });
  it("malformed cwd JSON is ignored with a warning (a cloned repo cannot abort every command)", () => {
    writeFileSync(join(dir, ".abxfs.json"), "{not json");
    const err: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => void err.push(a.join(" ")));
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.rpcUrl).toBe(BUILTIN_CHAINS["base-sepolia"]!.rpcUrl);
    expect(err.join("\n")).toMatch(/ignoring .*\.abxfs\.json/);
  });
  it("a directory named .abxfs.json is ignored with a warning, not EISDIR", () => {
    mkdirSync(join(dir, ".abxfs.json"));
    expect(() => loadConfig()).not.toThrow();
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toMatch(/ignoring/);
  });
  it("a malformed TRUSTED config (home or ABXFS_CONFIG) is still fatal: the user wrote it", () => {
    mkdirSync(join(home, ".config/abxfs"), { recursive: true });
    writeFileSync(join(home, ".config/abxfs/config.json"), "{not json");
    expect(() => loadConfig()).toThrow();
  });
});
