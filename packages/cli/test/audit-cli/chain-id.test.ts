/**
 * F3: viem sends `eth_fillTransaction` without a chain id and adopts the node's, so a hostile or misrouted RPC could
 * get a write signed for a chain the user did not choose. Against a stub RPC (no chain needed): the node's chain id is
 * checked once before anything is read, a filled transaction for another chain is refused, and a signed transaction
 * for another chain (or none) never reaches `eth_sendRawTransaction`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createClient } from "../../src/client.js";
import type { ChainConfig } from "../../src/config.js";
import { formatCliError } from "../../src/redact.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const ADDRESSES = { chunkStore: a(1), fileStore: a(2), directoryStore: a(3), sstore2Backend: a(4), fastLzBackend: a(5) };
const BASE_SEPOLIA = 84532;
const ANVIL = 31337;
const hex = (n: number | bigint) => "0x" + n.toString(16);

let server: Server;
let log: { path: string; method: string; params?: unknown[] }[];
/** Per path (`/a`, `/b`): what this endpoint says its chain is, and the chain id it fills transactions for. */
let nodes: Record<string, { chainId: number; fillChainId?: number }>;

function block() {
  const z = (n: number) => "0x" + "00".repeat(n);
  return {
    number: "0x1", baseFeePerGas: "0x989680", timestamp: "0x1", hash: "0x" + "11".repeat(32), parentHash: z(32), gasLimit: "0x1c9c380",
    gasUsed: "0x0", transactions: [], extraData: "0x", miner: z(20), difficulty: "0x0", nonce: z(8), logsBloom: z(256),
    receiptsRoot: z(32), stateRoot: z(32), transactionsRoot: z(32), sha3Uncles: z(32), size: "0x1", totalDifficulty: "0x0", uncles: [], mixHash: z(32),
  };
}

function reply(path: string, m: string, p: unknown[] | undefined): { result?: unknown; error?: { code: number; message: string } } {
  const node = nodes[path] ?? nodes["/a"]!;
  switch (m) {
    case "eth_chainId": return { result: hex(node.chainId) };
    case "eth_blockNumber": return { result: "0x1" };
    case "eth_getBlockByNumber": return { result: block() };
    case "eth_maxPriorityFeePerGas": return { result: "0xf4240" };
    case "eth_gasPrice": return { result: "0x1312d00" };
    case "eth_estimateGas": return { result: "0x5208" };
    case "eth_getTransactionCount": return { result: "0x0" };
    case "eth_getBalance": return { result: "0xde0b6b3a7640000" };
    case "eth_sendRawTransaction": return { result: "0x" + "ab".repeat(32) };
    case "eth_fillTransaction": {
      if (node.fillChainId === undefined) return { error: { code: -32601, message: "method not found" } };
      const t = (p?.[0] ?? {}) as Record<string, string>;
      return {
        result: {
          raw: "0x",
          tx: {
            ...t,
            type: "0x2",
            chainId: hex(node.fillChainId),
            nonce: "0x0",
            gas: "0x186a0",
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x3b9aca00",
            input: t["data"] ?? "0x",
            value: t["value"] ?? "0x0",
          },
        },
      };
    }
    default: return { error: { code: -32601, message: `unexpected ${m}` } };
  }
}

beforeEach(async () => {
  log = [];
  nodes = { "/a": { chainId: BASE_SEPOLIA } };
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const path = req.url ?? "/a";
      const j = JSON.parse(b);
      const one = (c: { id: number; method: string; params?: unknown[] }) => {
        log.push({ path, method: c.method, ...(c.params ? { params: c.params } : {}) });
        return { jsonrpc: "2.0", id: c.id, ...reply(path, c.method, c.params) };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["ABXFS_PRIVATE_KEY"] = PK;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  delete process.env["ABXFS_PRIVATE_KEY"];
});

const url = (path = "/a") => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
function client(extra: Partial<ChainConfig> = {}) {
  return createClient({ chainId: BASE_SEPOLIA, rpcUrl: url(), fallbackRpcUrls: [], addresses: ADDRESSES, ...extra }, { write: true });
}
const sends = () => log.filter((l) => l.method === "eth_sendRawTransaction" || l.method === "eth_sendRawTransactionSync");
const TO = "0x000000000000000000000000000000000000dEaD";

describe("F3: the RPC's chain id", () => {
  it("is checked before any read, and a mismatch refuses everything with a clear message", async () => {
    nodes["/a"] = { chainId: ANVIL };
    const c = client();
    const err = await c.publicClient.getBlockNumber().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const [line] = formatCliError(err);
    expect(line).toMatch(/refusing to continue: the RPC answers eth_chainId with chain 31337, but this command is for chain 84532/);
    expect(log.map((l) => l.method)).toEqual(["eth_chainId"]); // nothing else was asked
    await expect((c.walletClient as any).sendTransaction({ to: TO, value: 0n })).rejects.toThrow();
    expect(sends()).toEqual([]);
  });

  it("is asked once per client, shared by its public and wallet clients", async () => {
    const c = client();
    await c.publicClient.getBlockNumber({ cacheTime: 0 });
    await c.publicClient.getBalance({ address: TO });
    await (c.walletClient as any).sendTransaction({ to: TO, value: 0n });
    expect(log.filter((l) => l.method === "eth_chainId").length).toBe(1);
    expect(sends().length).toBe(1);
  });
});

describe("F3: a transaction filled or signed for another chain", () => {
  it("a node that fills the transaction for another chain is refused, and eth_sendRawTransaction is never called", async () => {
    nodes["/a"] = { chainId: BASE_SEPOLIA, fillChainId: ANVIL }; // honest eth_chainId, hostile fill
    const c = client();
    const err = await (c.walletClient as any).sendTransaction({ to: TO, value: 0n, data: "0x1234" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(formatCliError(err)[0]).toMatch(/filled a transaction for chain 31337, but this command is for chain 84532/);
    expect(log.some((l) => l.method === "eth_fillTransaction")).toBe(true);
    expect(sends()).toEqual([]);
  });

  it("an honest fill is signed for the configured chain and sent", async () => {
    nodes["/a"] = { chainId: BASE_SEPOLIA, fillChainId: BASE_SEPOLIA };
    const c = client();
    await (c.walletClient as any).sendTransaction({ to: TO, value: 0n });
    expect(sends().length).toBe(1);
    expect(parseTransaction(sends()[0]!.params![0] as Hex).chainId).toBe(BASE_SEPOLIA);
  });

  it("the SIGNED transaction is checked on its way out: another chain id, or none at all, never reaches the RPC", async () => {
    const c = client();
    const account = privateKeyToAccount(PK);
    const base = { to: TO as `0x${string}`, value: 0n, nonce: 0, gas: 21_000n };
    const otherChain = await account.signTransaction({ ...base, chainId: ANVIL, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, type: "eip1559" });
    // A legacy transaction without EIP-155 replay protection carries no chain id: valid on every chain.
    const noChain = await account.signTransaction({ ...base, gasPrice: 10n ** 9n, type: "legacy" } as never);
    for (const raw of [otherChain, noChain]) {
      for (const method of ["eth_sendRawTransaction", "eth_sendRawTransactionSync"]) {
        const err = await (c.walletClient as any).request({ method, params: [raw] }).catch((e: unknown) => e);
        expect(formatCliError(err)[0]).toMatch(/had the transaction signed for chain (31337|\(none or unreadable\)), but this command is for chain 84532/);
      }
    }
    expect(sends()).toEqual([]);
    // The right chain passes.
    const ok = await account.signTransaction({ ...base, chainId: BASE_SEPOLIA, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, type: "eip1559" });
    await (c.walletClient as any).request({ method: "eth_sendRawTransaction", params: [ok] });
    expect(sends().length).toBe(1);
  });
});

describe("F3: fallback endpoints", () => {
  it("an endpoint on the wrong chain is refused, not quietly routed around", async () => {
    nodes["/a"] = { chainId: ANVIL };
    nodes["/b"] = { chainId: BASE_SEPOLIA };
    const c = client({ fallbackRpcUrls: [url("/b")] });
    const err = await c.publicClient.getBlockNumber().catch((e: unknown) => e);
    expect(formatCliError(err)[0]).toMatch(/chain 31337, but this command is for chain 84532/);
    expect(log.filter((l) => l.path === "/b")).toEqual([]);
  });

  it("a fallback is held to the chain too, the first time it is used", async () => {
    nodes["/a"] = { chainId: BASE_SEPOLIA };
    nodes["/b"] = { chainId: ANVIL };
    // The primary is down (a port nothing listens on); the fallback answers for the wrong chain.
    const c = client({ rpcUrl: "http://127.0.0.1:9/", fallbackRpcUrls: [url("/b")] });
    const err = await c.publicClient.getBlockNumber().catch((e: unknown) => e);
    expect(formatCliError(err)[0]).toMatch(/chain 31337, but this command is for chain 84532/);
  });
});
