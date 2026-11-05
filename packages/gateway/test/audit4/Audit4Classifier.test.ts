/**
 * AUDIT4 (FIXED): the revert-vs-transport classifier against the REAL errors viem raises, produced by a hostile or
 * flaky JSON-RPC server (not hand-built Error objects). The FINDING rows are now the safe behaviour: a revert is
 * only a JSON-RPC code 3 (or a -32000 that STARTS WITH "execution reverted" and says nothing else), and every
 * other failure, including an empty `0x` answer, is an outage. Each row prints what the classifier said.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";
import { isOrg } from "@abxfs/sdk";

import { isRevert, lookupGeneration } from "../../src/upstream.js";

type Reply = { status?: number; body?: string; json?: unknown; hang?: boolean; big?: number; code?: string };
let current: Reply = {};
let server: http.Server;
let url = "";
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (current.hang) return; // never answers
      const status = current.status ?? 200;
      let id: unknown = 1;
      let method = "";
      try {
        const p = JSON.parse(raw);
        id = Array.isArray(p) ? p[0].id : p.id;
        method = Array.isArray(p) ? p[0].method : p.method;
      } catch {}
      if (method === "eth_getCode" && current.code !== undefined) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id, result: current.code }));
      }
      res.statusCode = status;
      if (current.big) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "x".repeat(current.big) } }));
        return;
      }
      if (current.body !== undefined) return void res.end(current.body);
      const j = current.json as Record<string, unknown>;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...j }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const client = () =>
  createPublicClient({ chain: baseSepolia, transport: viemHttp(url, { retryCount: 0, timeout: 400 }) }) as never;
const ORG = "0x00000000000000000000000000000000000000a1" as const;
const factory = TEST_ADDRESSES.orgFactory!;

async function classify(reply: Reply): Promise<{ revert: boolean; names: string[]; ms: number }> {
  current = reply;
  const t = Date.now();
  try {
    await isOrg(client(), factory, ORG);
    return { revert: false, names: ["NO ERROR"], ms: Date.now() - t };
  } catch (err) {
    const names: string[] = [];
    let c: any = err;
    for (let i = 0; c && i < 12; i++, c = c.cause) names.push(c.name);
    return { revert: isRevert(err), names, ms: Date.now() - t };
  }
}

const rpcErr = (code: number, message: string, data?: unknown) => ({ json: { error: { code, message, ...(data !== undefined ? { data } : {}) } } });

const rows: Array<[string, Reply, boolean]> = [
  ["HTTP 429", { status: 429, body: "slow down" }, false],
  ["HTTP 502 whose body says execution reverted", { status: 502, body: '{"error":"execution reverted"}' }, false],
  ["HTTP 200 html page", { body: "<html>cloudflare</html>" }, false],
  ["HTTP 200 empty body", { body: "" }, false],
  ["jsonrpc -32005 limit", rpcErr(-32005, "rate limit exceeded"), false],
  ["jsonrpc -32005 limit mentioning execution reverted", rpcErr(-32005, "rate limit exceeded; execution reverted"), false],
  ["jsonrpc -32603 internal", rpcErr(-32603, "internal error"), false],
  ["jsonrpc -32000 header not found", rpcErr(-32000, "header not found"), false],
  ["jsonrpc -32000 missing trie node", rpcErr(-32000, "missing trie node abc (path ) state is not available"), false],
  ["jsonrpc -32000 out of gas", rpcErr(-32000, "out of gas"), false],
  ["jsonrpc -32000 gas required exceeds allowance", rpcErr(-32000, "gas required exceeds allowance (50000000)"), false],
  ["jsonrpc -32002 resource unavailable", rpcErr(-32002, "resource unavailable"), false],
  ["jsonrpc -32016 timeout", rpcErr(-32016, "request timed out"), false],
  ["jsonrpc code 3 execution reverted (REAL revert)", rpcErr(3, "execution reverted", "0x"), true],
  ["jsonrpc -32000 execution reverted: reason", rpcErr(-32000, "execution reverted: nope"), true],
  ["jsonrpc -32000 'execution reverted' provider timeout text", rpcErr(-32000, "execution reverted (request exceeded 10s time limit)"), false],
  ["jsonrpc code 3 with revert data (a custom error)", rpcErr(3, "execution reverted", "0x7e27328900000000000000000000000000000000000000000000000000000000000000a1"), true],
  ["jsonrpc code 3 with no data field", rpcErr(3, "execution reverted"), true],
  ["jsonrpc -32000 message merely CONTAINING 'execution reverted'", rpcErr(-32000, "node busy: execution reverted upstream"), false],
  ["jsonrpc -32601 method not found", rpcErr(-32601, "the method eth_call does not exist"), false],
  ["jsonrpc -32700 parse error", rpcErr(-32700, "parse error"), false],
  ["HTTP 500 carrying a well-formed JSON-RPC code 3 revert (the node DID answer; viem surfaces the RPC error)", { status: 500, json: { error: { code: 3, message: "execution reverted", data: "0x" } } }, true],
  ["HTTP 200 truncated JSON", { body: '{"jsonrpc":"2.0","id":1,"result":"0x0000' }, false],
  ["result 0x (zero data: dead/lagging replica)", { json: { result: "0x" } }, false],
  ["result garbage", { json: { result: "0xdeadbeef" } }, false],
  ["result is string not hex", { json: { result: "hello" } }, false],
  ["server hangs (timeout)", { hang: true }, false],
  ["1 MiB error message", { big: 1 << 20 }, false],
];

describe("AUDIT4 classifier vs real viem errors", () => {
  for (const [name, reply, want] of rows) {
    it(`${name} -> revert=${want}`, async () => {
      const r = await classify(reply);
      console.log(`ROW | ${name} | revert=${r.revert} | ${r.names.join(">")} | ${r.ms}ms`);
      expect(r.revert).toBe(want);
    });
  }

  it("lookupGeneration: zero data is UNKNOWN unless getCode proves the factory has no code", async () => {
    const addresses = TEST_ADDRESSES;
    // A replica answered 0x for the call, and the code is there: a dropped call, not an absent factory.
    current = { json: { result: "0x" }, code: "0x6080" };
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: true });
    // The same empty answer with getCode proving there is nothing at the address: a definitive no.
    current = { json: { result: "0x" }, code: "0x" };
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: false });
    // getCode itself failing proves nothing.
    current = { status: 500, body: "x" };
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: true });
  });

  it("lookupGeneration with a throttled RPC is UNKNOWN, with a revert is definitive-no, with a clean false is no", async () => {
    current = { status: 429, body: "x" };
    const addresses = TEST_ADDRESSES;
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: true });
    current = rpcErr(3, "execution reverted", "0x");
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: false });
    current = { json: { result: "0x" + "00".repeat(32) } };
    expect(await lookupGeneration(client(), addresses, ORG)).toMatchObject({ found: null, unknown: false });
  });
});

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { TEST_ADDRESSES } from "../helpers.js";

describe("AUDIT4 end to end: a node answering -32603 (internal error) for every call", () => {
  it("the gateway answers a retryable 503, not 'not an org'", async () => {
    __resetResolveCaches();
    current = rpcErr(-32603, "internal error");
    const chain = { id: 84532, contracts: TEST_ADDRESSES, client: client() };
    const gw = createGateway({ chains: [chain], hostMode: { baseHost: "content.example" }, onError: () => {} });
    const host = `84532-${ORG.slice(2)}-1.content.example`;
    const res = await gw(new Request(`http://${host}/`, { headers: { host } }));
    console.log(`E2E -32603 | status=${res.status} | cc=${res.headers.get("cache-control")} | body=${await res.text()}`);
    // expectation of the round-3 design:
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
  it("a 502 gateway page containing the words 'execution reverted' is a 503, never a cacheable 404", async () => {
    __resetResolveCaches();
    current = { status: 502, body: "Bad gateway: upstream said execution reverted" };
    const chain = { id: 84532, contracts: TEST_ADDRESSES, client: client() };
    const gw = createGateway({ chains: [chain], hostMode: { baseHost: "content.example" }, onError: () => {} });
    const host = `84532-${ORG.slice(2)}-1.content.example`;
    const res = await gw(new Request(`http://${host}/`, { headers: { host } }));
    console.log(`E2E 502 | status=${res.status} | cc=${res.headers.get("cache-control")}`);
    expect(res.status).toBe(503);
  });
  it("a real code-3 revert for an unknown org IS the definitive 404 (and a hang is a 503)", async () => {
    __resetResolveCaches();
    current = rpcErr(3, "execution reverted", "0x");
    const chain = { id: 84532, contracts: TEST_ADDRESSES, client: client() };
    const gw = createGateway({ chains: [chain], hostMode: { baseHost: "content.example" }, onError: () => {} });
    const host = `84532-${ORG.slice(2)}-1.content.example`;
    expect((await gw(new Request(`http://${host}/`, { headers: { host } }))).status).toBe(404);
    __resetResolveCaches();
    current = { hang: true };
    const hung = await gw(new Request(`http://${host}/`, { headers: { host } }));
    expect(hung.status).toBe(503);
    expect(hung.headers.get("cache-control")).toBe("no-store");
  });
});
