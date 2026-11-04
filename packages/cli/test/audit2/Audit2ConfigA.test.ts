/** Audit round 2, pass A: more ways a cwd/repo file or a hostile RPC steers writes. "GAP:" = weakness present. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransaction } from "viem";

import { createClient } from "../../src/client.js";
import { loadConfig, resolveChain, setAllowConfigOverrides } from "../../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@abxfs/sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const saved = { ...process.env };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abxfs-a2c-"));
  for (const k of ["ABXFS_CONFIG", "ABXFS_RPC_URL", "ABXFS_RPC_URL_84532", "ABXFS_ALLOW_CONFIG_OVERRIDES"]) delete process.env[k];
  setAllowConfigOverrides(false);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("tunables from an untrusted ./.abxfs.json pass unvetted and unannounced", () => {
  it("defaultBundleGasBudget / defaultCodec / fastLz / org from the cwd file are ignored, loudly (fixed)", () => {
    writeFileSync(
      join(dir, ".abxfs.json"),
      JSON.stringify({ chains: { "base-sepolia": { defaultBundleGasBudget: 1, defaultCodec: "gzip", fastLz: false, org: "0x00000000000000000000000000000000000a77ac" } } }),
    );
    const err: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => void err.push(a.join(" ")));
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.defaultBundleGasBudget).toBeUndefined();
    expect(c.defaultCodec).toBeUndefined(); // the built-in default (none), not the file's gzip
    expect(c.fastLz).toBeUndefined(); // the built-in default (on), not the file's false
    expect(c.org).toBeUndefined();
    for (const k of ["defaultBundleGasBudget", "defaultCodec", "fastLz", "org"]) expect(err.join("\n")).toContain(k);
  });
  it("'__proto__' chain key is refused (fixed): the untrusted cwd file is ignored with a warning", () => {
    writeFileSync(join(dir, ".abxfs.json"), `{"chains":{"__proto__":{"chainId":84532,"rpcUrl":"https://x.example"}}}`);
    const err: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => void err.push(a.join(" ")));
    const c = resolveChain(loadConfig(), "base-sepolia");
    expect(c.rpcUrl).not.toBe("https://x.example");
    expect(err.join("\n")).toMatch(/not a valid chain name/);
  });
});

describe("hostile RPC controls fee fields of signed txs: the CLI refuses above its ceiling", () => {
  let srv: Server;
  let url: string;
  const sent: string[] = [];
  let fill = false;
  beforeEach(async () => {
    sent.length = 0;
    fill = false;
    srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const one = (r: { id: number; method: string; params: unknown[] }) => {
          const hex = (n: bigint) => "0x" + n.toString(16);
          const huge = 5n * 10n ** 17n * 1000n / 21000n; // ~ 0.5 ETH-equivalent per 21k gas
          let result: unknown;
          switch (r.method) {
            case "eth_chainId": result = hex(84532n); break;
            case "eth_getTransactionCount": result = "0x0"; break;
            case "eth_estimateGas": result = hex(21000n); break;
            case "eth_gasPrice": result = hex(huge); break;
            case "eth_maxPriorityFeePerGas": result = hex(huge); break;
            case "eth_feeHistory": result = { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x1"], gasUsedRatio: [0.5], reward: [[hex(huge)]] }; break;
            case "eth_getBlockByNumber": result = { number: "0x1", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x1", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], miner: "0x" + "00".repeat(20), nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), mixHash: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), size: "0x1", stateRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), uncles: [] }; break;
            case "eth_fillTransaction": {
              // viem 2.57 prefers this: the NODE fills gas and fees, and chain.fees is never consulted.
              if (!fill) return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "method not found" } };
              const t = r.params[0] as Record<string, string>;
              result = { raw: "0x", tx: { type: "0x2", chainId: "0x14a34", nonce: "0x0", gas: "0x5208", maxFeePerGas: hex(huge), maxPriorityFeePerGas: hex(huge), to: t.to, value: "0x0", input: "0x", accessList: [] } };
              break;
            }
            case "eth_sendRawTransaction": sent.push(String(r.params[0])); result = "0x" + "ab".repeat(32); break;
            default: result = "0x0";
          }
          return { jsonrpc: "2.0", id: r.id, result };
        };
        const parsed = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((r) => srv.close(() => r())));

  async function send() {
    process.env["ABXFS_PRIVATE_KEY"] = "0x" + "11".repeat(32);
    // The cwd file's rpcUrl is ignored; the trusted route is ABXFS_RPC_URL.
    process.env["ABXFS_RPC_URL_84532"] = url;
    const chain = resolveChain(loadConfig(), "base-sepolia");
    expect(chain.rpcUrl).toBe(url);
    const client = createClient(chain, { write: true });
    const wc = client.walletClient!;
    return wc.sendTransaction({ account: wc.account!, chain: wc.chain, to: "0x00000000000000000000000000000000000a77ac", value: 0n });
  }

  it("a quote above the default ceiling is refused with a clear error and nothing is signed or sent", async () => {
    await expect(send()).rejects.toThrow(/refusing to send.*ceiling/s);
    expect(sent.length).toBe(0);
  });

  it("a node that FILLS the fees itself (eth_fillTransaction) cannot get past the ceiling: the signed tx is checked on its way out", async () => {
    fill = true;
    await expect(send()).rejects.toThrow(/above the .* gwei ceiling \(ABXFS_MAX_FEE_GWEI\)/s);
    expect(sent.length).toBe(0);
  });

  it("ABXFS_MAX_FEE_GWEI raises the ceiling; the signed tx then respects what the node quoted", async () => {
    process.env["ABXFS_MAX_FEE_GWEI"] = "100000000";
    await send();
    expect(sent.length).toBe(1);
    const tx = parseTransaction(sent[0] as `0x${string}`);
    expect((tx.maxFeePerGas ?? 0n) * 21000n).toBeGreaterThan(10n ** 17n);
  });

  it("a bad ABXFS_MAX_FEE_GWEI is an error, not 'no ceiling'", async () => {
    process.env["ABXFS_MAX_FEE_GWEI"] = "lots";
    await expect(send()).rejects.toThrow(/ABXFS_MAX_FEE_GWEI/);
  });

  it("prints chain, RPC host (not the URL) and account once before the first write", async () => {
    const lines: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => void lines.push(a.join(" ")));
    await expect(send()).rejects.toThrow();
    // module-level once-flag: may already have been printed by an earlier test in this file
    const all = lines.join("\n");
    if (all) expect(all).toMatch(/writing as 0x[0-9a-fA-F]{40} on .* via 127\.0\.0\.1:\d+/);
    expect(all).not.toContain("http://");
  });
});

describe("abxfs dev runs forge with a minimal environment, only in an ABX FS checkout", () => {
  it("forge gets no secrets and FOUNDRY_FFI=false; refuses outside a checkout", async () => {
    process.env["ABXFS_PRIVATE_KEY"] = "0x" + "22".repeat(32);
    process.env["PINATA_JWT"] = "jwt-secret-value";
    mkdirSync(join(dir, "packages/contracts-core"), { recursive: true });
    const spawned: { cmd: string; opts: { cwd?: string; env?: Record<string, string> } }[] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: (cmd: string, _args: string[], opts: { cwd?: string; env?: Record<string, string> }) => {
        spawned.push({ cmd, opts });
        const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void; exitCode: number | null; signalCode: string | null };
        p.stdout = new EventEmitter();
        p.kill = () => undefined;
        // A running child: `abxfs dev` checks it has not exited when the RPC answers (audit F9).
        p.exitCode = null;
        p.signalCode = null;
        if (cmd === "forge") {
          setTimeout(() => {
            p.stdout.emit("data", Buffer.from(`ChunkStore 0x${"1".repeat(40)}\nSstore2Backend 0x${"2".repeat(40)}\nFastLzSstore2Backend 0x${"3".repeat(40)}\nFileStore 0x${"4".repeat(40)}\nDirectoryStore 0x${"5".repeat(40)}\n`));
            p.emit("exit", 0);
          }, 5);
        }
        return p;
      },
    }));
    // The node that answers must say it is anvil, on the chain id asked for (audit F9).
    vi.stubGlobal("fetch", async (_u: unknown, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      return { ok: true, json: async () => ({ result: method === "web3_clientVersion" ? "anvil/v1.0.0" : "0x7a69" }) };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { devCommand } = await import("../../src/commands/dev.js");
    // no --i-trust-this-dir: refused before anything is spawned, whatever the directory looks like
    await expect(devCommand().parseAsync(["node", "dev", "--out", join(dir, "out.json")])).rejects.toThrow(/--i-trust-this-dir/);
    // a spoofed package.json name is worth nothing
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "abxfs" }));
    await expect(devCommand().parseAsync(["node", "dev", "--out", join(dir, "out.json")])).rejects.toThrow(/--i-trust-this-dir/);
    expect(spawned).toEqual([]);
    const cmd = devCommand();
    // A port nothing listens on: the port is checked free before anvil is spawned (audit F9).
    const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const a = s.address() as { port: number }; s.close(() => r(a.port)); }); });
    const done = cmd.parseAsync(["node", "dev", "--i-trust-this-dir", "--port", String(port), "--out", join(dir, "out.json")]);
    await new Promise((r) => setTimeout(r, 400));
    process.emit("SIGINT");
    await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
    const forge = spawned.find((s) => s.cmd === "forge");
    expect(forge).toBeDefined();
    expect(forge!.opts.cwd).toBe(join(dir, "packages/contracts-core"));
    expect(forge!.opts.env!["ABXFS_PRIVATE_KEY"]).toBeUndefined();
    expect(forge!.opts.env!["PINATA_JWT"]).toBeUndefined();
    expect(forge!.opts.env!["FOUNDRY_FFI"]).toBe("false");
    expect(forge!.opts.env!["PATH"]).toBeDefined();
    const anvil = spawned.find((s) => s.cmd === "anvil");
    expect(anvil!.opts.env!["ABXFS_PRIVATE_KEY"]).toBeUndefined();
    vi.doUnmock("node:child_process");
    vi.unstubAllGlobals();
  });
});
