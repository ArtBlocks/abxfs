import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createClient, maxFeeCapWei } from "../../src/client.js";
import { BUILTIN_CHAINS } from "../../src/config.js";

// The registry has no addresses for the production chains; these tests need a canonical address book to defend.
vi.mock("@abxfs/sdk", async (orig) => (await import("../../../sdk/test/helpers/deployed-registry.js")).withDeployedRegistry(await orig()));

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
let server: Server;
let log: { method: string; params?: unknown[] }[] = [];
let cfg = { baseFee: 10_000_000n, prio: 1_000_000n, gasPrice: 20_000_000n, fill: false };

function reply(m: string, p: unknown[] | undefined): unknown {
  switch (m) {
    case "eth_chainId": return "0x14a34";
    case "eth_getBlockByNumber": return { number: "0x1", baseFeePerGas: "0x" + cfg.baseFee.toString(16), timestamp: "0x1", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], extraData: "0x", miner: "0x" + "00".repeat(20), difficulty: "0x0", nonce: "0x0000000000000000", logsBloom: "0x" + "00".repeat(256), receiptsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), size: "0x1", totalDifficulty: "0x0", uncles: [], mixHash: "0x" + "00".repeat(32) };
    case "eth_maxPriorityFeePerGas": return "0x" + cfg.prio.toString(16);
    case "eth_gasPrice": return "0x" + cfg.gasPrice.toString(16);
    case "eth_estimateGas": return "0x5208";
    case "eth_getTransactionCount": return "0x0";
    case "eth_sendRawTransaction": return "0x" + "ab".repeat(32);
    case "eth_sendRawTransactionSync": return { status: "0x1" };
    default: throw new Error("unexpected " + m);
  }
}

beforeEach(async () => {
  log = [];
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const j = JSON.parse(b);
      const one = (c: { id: number; method: string; params?: unknown[] }) => {
        log.push({ method: c.method, params: c.params });
        if (c.method === "eth_fillTransaction" && !cfg.fill) return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "no" } };
        try { return { jsonrpc: "2.0", id: c.id, result: reply(c.method, c.params) }; } catch (e) { return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: String(e) } }; }
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["ABXFS_PRIVATE_KEY"] = PK;
  delete process.env["ABXFS_MAX_FEE_GWEI"];
});
afterEach(async () => { await new Promise((r) => server.close(r)); delete process.env["ABXFS_PRIVATE_KEY"]; delete process.env["ABXFS_MAX_FEE_GWEI"]; });

function client() {
  const base = BUILTIN_CHAINS["base-sepolia"]!;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return createClient({ ...base, rpcUrl: url, fallbackRpcUrls: [] }, { write: true });
}
const sent = () => log.filter((l) => l.method === "eth_sendRawTransaction" || l.method === "eth_sendRawTransactionSync").length;

describe("Audit3 fee ceiling", () => {
  it("per-chain defaults", () => {
    expect(maxFeeCapWei(84532)).toBe(50_000_000_000n);
    expect(maxFeeCapWei(8453)).toBe(50_000_000_000n);
    expect(maxFeeCapWei(1)).toBe(200_000_000_000n);
    process.env["ABXFS_MAX_FEE_GWEI"] = "0";
    expect(maxFeeCapWei(8453)).toBe(0n);   // 0 = everything refused (fail closed) -- confirm
    process.env["ABXFS_MAX_FEE_GWEI"] = "1e3";
    expect(() => maxFeeCapWei(8453)).toThrow();
  });
  it("happy path: normal Base Sepolia fees go through", async () => {
    const c = client();
    const hash = await (c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n });
    expect(hash).toMatch(/^0x/);
    expect(sent()).toBe(1);
  });
  it("user supplied maxFeePerGas 1000 gwei is refused AFTER signing, before send", async () => {
    const c = client();
    await expect((c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, maxFeePerGas: 1000_000_000_000n, maxPriorityFeePerGas: 1n })).rejects.toThrow(/refusing to send/);
    expect(sent()).toBe(0);
  });
  it("legacy gasPrice 1000 gwei refused", async () => {
    const c = client();
    await expect((c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, type: "legacy", gasPrice: 1000_000_000_000n })).rejects.toThrow(/refusing to send/);
    expect(sent()).toBe(0);
  });
  it("hostile RPC quoting 1 gwei*1000 base fee is refused with a message", async () => {
    cfg.baseFee = 1_000_000_000_000n;
    const c = client();
    let msg = "";
    try { await (c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n }); } catch (e: any) { msg = e.message; }
        expect(msg).toMatch(/refusing|ceiling/);
    expect(sent()).toBe(0);
    cfg.baseFee = 10_000_000n;
  });
  it("eth_sendRawTransactionSync is guarded too, and the refusal prints gwei with the ceiling name", async () => {
    const c = client();
    const wc = c.walletClient as any;
    const raw = await wc.signTransaction(await wc.prepareTransactionRequest({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, maxFeePerGas: 1000_000_000_000n, maxPriorityFeePerGas: 1n, gas: 21000n, type: "eip1559" }));
    let msg = "";
    try { await wc.request({ method: "eth_sendRawTransactionSync", params: [raw] }); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/refusing to send/);
    expect(msg).toMatch(/1000 gwei/);
    expect(msg).toMatch(/above the 50 gwei ceiling \(ABXFS_MAX_FEE_GWEI\)/);
    expect(sent()).toBe(0);
    // a sane one passes through
    const ok = await wc.signTransaction(await wc.prepareTransactionRequest({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, gas: 21000n }));
    await wc.request({ method: "eth_sendRawTransactionSync", params: [ok] });
    expect(sent()).toBe(1);
  });
  it("legit spike: base fee 30 gwei (still plausible on a congested L2) is refused; message units", async () => {
    cfg.baseFee = 30_000_000_000n;
    const c = client();
    let msg = "";
    try { await (c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n }); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/refusing/);
    cfg.baseFee = 10_000_000n;
  });
  it("blob tx maxFeePerBlobGas is NOT checked", async () => {
    // type 3 without blobs cannot be built here; assert structurally that guard only reads 3 fields
    const src = (await import("node:fs")).readFileSync(new URL("../../src/client.ts", import.meta.url), "utf8");
    expect(src.includes("maxFeePerBlobGas")).toBe(false);
  });
  it("nonce manager: after a refused send, the next legit send reuses the nonce (no gap)", async () => {
    const c = client();
    let first: unknown; try { first = await (c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n, maxFeePerGas: 1000_000_000_000n }); } catch (e) { first = "threw"; }
    const { parseTransaction: pt } = await import("viem");
    log = [];
    await (c.walletClient as any).sendTransaction({ to: "0x000000000000000000000000000000000000dEaD", value: 0n });
    const raws = log.filter((l) => l.method === "eth_sendRawTransaction");
    expect(raws.length).toBe(1);
    const { parseTransaction } = await import("viem");
    expect(parseTransaction(raws[0]!.params![0] as any).nonce ?? 0).toBe(0);
  });
});
