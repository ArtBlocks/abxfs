/**
 * Config validation (F20), chain resolution (F17 and the untested branches), the program's own flags (F4 through
 * `buildProgram()`, `--allow-config-overrides` anywhere), and what an error prints (F14, F16, F18).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionTimeoutError } from "@abxfs/sdk";
import type { Hex } from "viem";

import { buildProgram, run } from "../../src/index.js";
import { getPrivateKey, loadConfig, resolveChain, setAllowConfigOverrides, type CliConfig } from "../../src/config.js";
import { CliRefusal, formatCliError } from "../../src/redact.js";
import { collapseHex, ipfsCidText, shortTxHash, txHash } from "../../src/text.js";

// The registry has no addresses for the production chains; these tests need a canonical address book.
vi.mock("@abxfs/sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

let dir: string;
let err: string[];
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-cfg2-"));
  for (const k of ["ABXFS_CONFIG", "ABXFS_RPC_URL", "ABXFS_RPC_URL_84532", "ABXFS_ALLOW_CONFIG_OVERRIDES", "ABXFS_PRIVATE_KEY"]) delete process.env[k];
  process.env["ABXFS_CONFIG"] = join(dir, "missing.json");
  setAllowConfigOverrides(false);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  err = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...saved };
  setAllowConfigOverrides(false);
  vi.restoreAllMocks();
});

const trusted = (obj: unknown) => {
  const p = join(dir, "cfg.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env["ABXFS_CONFIG"] = p;
};
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const LOCAL = { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", addresses: { chunkStore: addr(1), fileStore: addr(2), directoryStore: addr(3), sstore2Backend: addr(4), fastLzBackend: addr(5) } };

describe("F20: config values are validated", () => {
  it.each([
    [{ "base-sepolia": { rpcUrl: "not a url" } }, /rpcUrl must be an http\(s\) URL/],
    [{ "base-sepolia": { rpcUrl: "ws://x.example" } }, /rpcUrl must be an http\(s\) URL/],
    [{ "base-sepolia": { fallbackRpcUrls: "https://x.example" } }, /fallbackRpcUrls must be an array/],
    [{ "base-sepolia": { fallbackRpcUrls: ["https://x.example", 3] } }, /fallbackRpcUrls\[1\] must be an http\(s\) URL/],
    [{ "base-sepolia": { org: "0x123" } }, /org must be an address/],
    [{ "base-sepolia": { defaultBundleGasBudget: 0 } }, /defaultBundleGasBudget must be a positive whole number/],
    [{ "base-sepolia": { defaultBundleGasBudget: "12000000" } }, /defaultBundleGasBudget/],
    [{ "base-sepolia": { defaultBundleGasBudget: -5 } }, /defaultBundleGasBudget/],
    [{ "base-sepolia": { addresses: { fileStore: "0x1" } } }, /addresses\.fileStore must be an address/],
    [{ "base-sepolia": "nope" }, /its entry must be an object/],
  ])("a trusted config with %j is refused", (chains, re) => {
    trusted({ chains });
    expect(() => loadConfig()).toThrow(re);
  });

  it("the same values in an untrusted ./.abxfs.json make it skipped with a warning, not fatal", () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { org: "0x123" } } }));
    expect(() => loadConfig()).not.toThrow();
    expect(err.join("\n")).toMatch(/ignoring .*\.abxfs\.json.*org must be an address/);
  });

  it("unknown keys are reported and dropped", () => {
    trusted({ defaultChian: "x", chains: { local: { ...LOCAL, accountLabel: "mine", rpcURL: "https://typo.example", addresses: { ...LOCAL.addresses, fileStor: addr(9) } } } });
    const c = resolveChain(loadConfig(), "local") as unknown as Record<string, unknown>;
    const out = err.join("\n");
    for (const k of ['unknown key "defaultChian"', 'unknown key "chains.local.accountLabel"', 'unknown key "chains.local.rpcURL"', 'unknown key "chains.local.addresses.fileStor"']) {
      expect(out).toContain(k);
    }
    expect(c["accountLabel"]).toBeUndefined();
    expect(c["rpcURL"]).toBeUndefined();
    expect((c["addresses"] as Record<string, unknown>)["fileStor"]).toBeUndefined();
  });

  it("a key-like key is reported loudly, never with its value, and never used", () => {
    trusted({ privateKey: "0x" + "ab".repeat(32), chains: { local: { ...LOCAL, mnemonic: "test test test", apiKey: "sk-123456" } } });
    const c = resolveChain(loadConfig(), "local") as unknown as Record<string, unknown>;
    const out = err.join("\n");
    expect(out).toMatch(/has a key named "privateKey"\. A config file must never hold a key or a secret/);
    expect(out).toMatch(/"chains\.local\.mnemonic"/);
    expect(out).toMatch(/"chains\.local\.apiKey"/);
    expect(out).not.toContain("ab".repeat(32));
    expect(out).not.toContain("sk-123456");
    expect(c["mnemonic"]).toBeUndefined();
  });
});

describe("resolveChain", () => {
  it("F17: only the config's own chain names resolve, never Object.prototype's", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => resolveChain(loadConfig(), name), name).toThrow(/unknown chain/);
    }
  });

  it("a misspelled name lists what is available", () => {
    expect(() => resolveChain(loadConfig(), "base-sepolai")).toThrow(/unknown chain "base-sepolai"\. Available: .*base-sepolia/);
  });

  it("with no name: defaultChain, else the only chain, else it asks for --chain", () => {
    const one: CliConfig = { chains: { local: LOCAL as never } };
    expect(resolveChain(one).chainId).toBe(31337);
    const two: CliConfig = { chains: { a: { ...LOCAL, chainId: 1 } as never, b: { ...LOCAL, chainId: 2 } as never } };
    expect(() => resolveChain(two)).toThrow(/no network chosen — pass --chain <name>, set ABXFS_CHAIN, or set defaultChain .*\. Available: a, b/);
    expect(resolveChain({ ...two, defaultChain: "b" }).chainId).toBe(2);
    expect(() => resolveChain({ chains: {} })).toThrow(/no chain configured/);
  });
});

describe("ABXFS_PRIVATE_KEY", () => {
  it.each(["0x123", "ab".repeat(32), "0x" + "zz".repeat(32), "0x" + "ab".repeat(33)])("a malformed key %j is refused, and never echoed", (k) => {
    process.env["ABXFS_PRIVATE_KEY"] = k;
    expect(() => getPrivateKey()).toThrow(/^ABXFS_PRIVATE_KEY must be 0x-prefixed 32 bytes$/);
  });
});

describe("the program", () => {
  it("F4: `pin --version <n>` reaches pin (built from buildProgram, not the subcommand alone)", async () => {
    const program = buildProgram().exitOverride();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(program.parseAsync(["node", "abxfs", "pin", "--project-id", "1", "--version", "2"])).rejects.toThrow(/now `--project-version`/);
    expect(write.mock.calls.flat().join("")).not.toContain("0.0.0");
    const pin = program.commands.find((c) => c.name() === "pin")!;
    expect(pin.options.map((o) => o.long)).toContain("--project-version");
    expect(pin.helpInformation()).not.toMatch(/--version/);
  });

  it("`--allow-config-overrides` counts anywhere on the line, before or after the subcommand", async () => {
    writeFileSync(join(dir, ".abxfs.json"), JSON.stringify({ chains: { "base-sepolia": { rpcUrl: "https://from-cwd.example" } } }));
    process.exitCode = undefined;
    await run(["node", "abxfs", "org", "info", "not-an-address", "--chain", "base-sepolia", "--allow-config-overrides"]);
    expect(err.join("\n")).toMatch(/Applying them because --allow-config-overrides/);
    err.length = 0;
    setAllowConfigOverrides(false);
    await run(["node", "abxfs", "--allow-config-overrides", "org", "info", "not-an-address", "--chain", "base-sepolia"]);
    expect(err.join("\n")).toMatch(/Applying them because --allow-config-overrides/);
    process.exitCode = undefined;
  });
});

describe("what an error prints", () => {
  it("F14: long hex runs (calldata, a raw transaction) are collapsed to their ends and a byte count", () => {
    const calldata = "0x" + "ab".repeat(48 * 1024);
    const [line] = formatCliError(new Error(`insufficient funds for gas * price + value\nRequest Arguments:\n  data: ${calldata}`));
    expect(line!.length).toBeLessThan(300);
    expect(line).toMatch(/insufficient funds/);
    expect(line).toMatch(/0xabababababababab…\(49,152 bytes\)…abababab/);
    // A CID or tx hash is kept whole.
    expect(collapseHex(`cid 0x${"cd".repeat(32)}`)).toBe(`cid 0x${"cd".repeat(32)}`);
  });

  it("F16: a timed-out transaction's explorer link is printed whole, on its own line; the message is still scrubbed", () => {
    const hash = ("0x" + "12".repeat(32)) as Hex;
    const e = new TransactionTimeoutError(hash, "mint", `https://sepolia.basescan.org/tx/${hash}`);
    const lines = formatCliError(new Error("wrapped", { cause: e }));
    expect(lines).toContain(`  explorer: https://sepolia.basescan.org/tx/${hash}`);
    // Not a link of that shape: never printed whole.
    const bad = new TransactionTimeoutError(hash, "mint", `https://evil.example/x?key=SECRET`);
    expect(formatCliError(bad).join("\n")).not.toContain("SECRET");
    expect(formatCliError(bad).join("\n")).not.toContain("explorer:");
  });

  it("a refusal the CLI made is printed as itself, however deep viem wrapped it", () => {
    const refusal = new CliRefusal("refusing to send: the transaction's maxFeePerGas is 1000 gwei, above the 50 gwei ceiling");
    const wrapped = new Error("Transaction failed.\n\nRequest Arguments: ... URL: https://rpc.example/v2/KEY", { cause: new Error("x", { cause: refusal }) });
    expect(formatCliError(wrapped)).toEqual([refusal.message]);
  });

  it("terminal control is stripped and URLs scrubbed", () => {
    const [line] = formatCliError(new Error("boom \u001b]52;c;ZXZpbA==\u0007 at https://rpc.example/v2/KEY"));
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("KEY");
  });

  it("F18: RPC-sourced hashes and CIDs are printed only when well-formed", () => {
    const good = "0x" + "ab".repeat(32);
    expect(txHash(good)).toBe(good);
    expect(shortTxHash(good)).toBe("0xabababab…");
    for (const bad of ["0x12\u001b[2J", "0x" + "ab".repeat(31), 42, undefined, "0x" + "gg".repeat(32)]) {
      expect(txHash(bad)).toBe("(malformed transaction hash from the RPC)");
      expect(shortTxHash(bad)).not.toContain("\u001b");
    }
    expect(ipfsCidText("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toMatch(/^bafy/);
    expect(ipfsCidText("baf\u001b]0;x\u0007")).toBe("(malformed IPFS CID)");
    expect(ipfsCidText("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe("(malformed IPFS CID)");
  });
});
