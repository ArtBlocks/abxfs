/**
 * The chain-id guard's branches the delta audit found untested (`client.ts`): every spelling of a chain id a node may
 * answer with (a JSON number, a hex string past 2^53, something that is not a number at all), a signed transaction
 * that cannot be parsed, and the first check failing on the network (not cached: the next request asks again).
 * Against a stub JSON-RPC server; no chain needed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient } from "../../src/client.js";
import type { ChainConfig } from "../../src/config.js";
import { formatCliError } from "../../src/redact.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const a = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const ADDRESSES = { chunkStore: a(1), fileStore: a(2), directoryStore: a(3), sstore2Backend: a(4), fastLzBackend: a(5) };
const BASE_SEPOLIA = 84532;

let server: Server;
let url: string;
let methods: string[];
/** What `eth_chainId` answers next; a function may vary it per call. `"fail"` answers HTTP 500. */
let chainIdAnswer: () => unknown;

beforeEach(async () => {
  methods = [];
  chainIdAnswer = () => "0x" + BASE_SEPOLIA.toString(16);
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b) as { id: number; method: string } | Array<{ id: number; method: string }>;
      const one = (r: { id: number; method: string }) => {
        methods.push(r.method);
        if (r.method === "eth_chainId") {
          const v = chainIdAnswer();
          if (v === "fail") return "fail";
          return { jsonrpc: "2.0", id: r.id, result: v };
        }
        if (r.method === "eth_blockNumber") return { jsonrpc: "2.0", id: r.id, result: "0x10" };
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
      };
      const answers = Array.isArray(body) ? body.map(one) : one(body);
      if (answers === "fail" || (Array.isArray(answers) && answers.includes("fail"))) {
        res.statusCode = 500;
        return res.end("upstream down");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answers));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env["ABXFS_PRIVATE_KEY"];
  await new Promise((r) => server.close(r));
});

const chain = (): ChainConfig => ({ chainId: BASE_SEPOLIA, rpcUrl: url, fallbackRpcUrls: [], addresses: ADDRESSES as never });
const message = async (p: Promise<unknown>) => formatCliError(await p.then(() => new Error("no error"), (e: unknown) => e)).join("\n");

describe("the chain id as a node states it", () => {
  it("a JSON number equal to the configured chain is accepted", async () => {
    chainIdAnswer = () => BASE_SEPOLIA;
    expect(await createClient(chain()).publicClient.getBlockNumber()).toBe(16n);
  });

  it("a JSON number for another chain is refused", async () => {
    chainIdAnswer = () => 1;
    expect(await message(createClient(chain()).publicClient.getBlockNumber())).toMatch(/answers eth_chainId with chain 1, but this command is for chain 84532/);
  });

  it("a hex chain id past 2^53 is not a chain id (never rounded onto one)", async () => {
    chainIdAnswer = () => "0x" + (2n ** 60n + BigInt(BASE_SEPOLIA)).toString(16);
    expect(await message(createClient(chain()).publicClient.getBlockNumber())).toMatch(/chain \(none or unreadable\), but this command is for chain 84532/);
    expect(methods).not.toContain("eth_blockNumber");
  });

  it.each([[null], [{ id: BASE_SEPOLIA }], ["base-sepolia"], [true]])("%j is not a chain id", async (answer) => {
    chainIdAnswer = () => answer;
    expect(await message(createClient(chain()).publicClient.getBlockNumber())).toMatch(/\(none or unreadable\)/);
  });

  it("a failed first check is not cached: the next request asks again, and goes ahead", async () => {
    // viem retries an HTTP 500 itself (3 times), so the first check fails outright only after 4 failed answers.
    let n = 0;
    chainIdAnswer = () => (n++ < 4 ? "fail" : "0x" + BASE_SEPOLIA.toString(16));
    const client = createClient(chain());
    await expect(client.publicClient.getBlockNumber()).rejects.toThrow();
    expect(methods).not.toContain("eth_blockNumber");
    // Not latched as a mismatch and not cached as a failure: asked again, and this time it answers.
    expect(await client.publicClient.getBlockNumber()).toBe(16n);
    expect(methods.filter((m) => m === "eth_chainId").length).toBe(5);
  });
});

describe("the signed transaction on its way out", () => {
  it("one that cannot be parsed is refused, and never reaches the node", async () => {
    process.env["ABXFS_PRIVATE_KEY"] = PK;
    const client = createClient(chain(), { write: true });
    const err = await message(client.walletClient!.sendRawTransaction({ serializedTransaction: "0x02deadbeef" }));
    expect(err).toMatch(/refusing to send: could not inspect the signed transaction/);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });
});
