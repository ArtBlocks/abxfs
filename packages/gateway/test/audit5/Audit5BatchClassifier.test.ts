/**
 * AUDIT5: the classifier under the PRODUCTION transport ({timeout:4000, retryCount:1, batch:true}) and the SDK's
 * multicall path, driven against a fake JSON-RPC server that answers per request (batches included).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";
import { isOrg } from "@abxfs/sdk";

import { isRevert, lookupGeneration, strictBatchFetch } from "../../src/upstream.js";

type Item = { id: number; method: string; params: unknown[] };
type Handler = (items: Item[], isBatch: boolean) => { status?: number; body: unknown; raw?: string; delay?: number };
let handler: Handler = () => ({ body: [] });
let server: http.Server;
let url = "";
let hits = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const p = JSON.parse(raw);
      const isBatch = Array.isArray(p);
      const r = handler(isBatch ? p : [p], isBatch);
      setTimeout(() => {
        res.statusCode = r.status ?? 200;
        res.setHeader("content-type", "application/json");
        res.end(r.raw ?? JSON.stringify(r.body));
      }, r.delay ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const prod = (timeout = 4000) => createPublicClient({ chain: baseSepolia, transport: viemHttp(url, { timeout, retryCount: 1, batch: true, fetchFn: strictBatchFetch() }) }) as never;
import { appendFileSync } from "node:fs";
import { TEST_ADDRESSES } from "../helpers.js";
const log = (...a: unknown[]) => appendFileSync("/tmp/audit5-batch.log", a.join(" ") + "\n");
const ORG = "0x00000000000000000000000000000000000000a1" as const;
const factory = TEST_ADDRESSES.orgFactory!;
const revertErr = { code: 3, message: "execution reverted", data: "0x" };

async function classify(c: any) {
  try { await isOrg(c, factory, ORG); return { revert: false, err: null as any, ok: true }; }
  catch (err: any) { const names: string[] = []; let e = err; for (let i = 0; e && i < 12; i++, e = e.cause) names.push(e.name); return { revert: isRevert(err), names, ok: false }; }
}

describe("AUDIT5 classifier under batch:true", () => {
  const rows: Array<[string, Handler, boolean]> = [
    ["batch: per-item code 3 revert", (it) => ({ body: it.map((i) => ({ jsonrpc: "2.0", id: i.id, error: revertErr })) }), true],
    ["batch: one item answered with a bare (non-array) JSON-RPC error object, id null, -32000 execution reverted", () => ({ body: { jsonrpc: "2.0", id: null, error: { code: -32000, message: "execution reverted" } } }), false],
    ["batch: non-array error code 3", () => ({ body: { jsonrpc: "2.0", id: null, error: revertErr } }), false],
    ["batch: empty array answer", () => ({ body: [] }), false],
    ["batch: array with wrong ids", () => ({ body: [{ jsonrpc: "2.0", id: 999, error: revertErr }] }), false],
    ["batch: HTTP 429 with revert-ish body", () => ({ status: 429, body: [{ jsonrpc: "2.0", id: 1, error: revertErr }] }), false],
    ["batch: HTTP 520 cloudflare html mentioning execution reverted", () => ({ status: 520, raw: "<html>execution reverted</html>", body: null }), false],
    ["batch: HTTP 200 html mentioning execution reverted", () => ({ raw: "<html>execution reverted</html>", body: null }), false],
    ["batch: 200 + id mismatch item error -32000 execution reverted (provider batch quirk)", (it) => ({ body: it.map((i) => ({ jsonrpc: "2.0", id: i.id + 1000, error: { code: -32000, message: "execution reverted" } })) }), false],
    ["batch: item -32005 rate limit while sibling ok", (it) => ({ body: it.map((i) => ({ jsonrpc: "2.0", id: i.id, error: { code: -32005, message: "limit exceeded" } })) }), false],
    ["batch: result 0x", (it) => ({ body: it.map((i) => ({ jsonrpc: "2.0", id: i.id, result: "0x" })) }), false],
  ];
  for (const [name, h, want] of rows) {
    it(`${name} -> revert=${want}`, async () => {
      handler = h;
      const r = await classify(prod(1500));
      log(`ROW5 | ${name} | revert=${r.revert} | ${(r as any).names?.join(">")}`);
      expect(r.revert).toBe(want);
    });
  }

  it("batch of two parallel isOrg calls: one revert, one 429-style JSON-RPC error: each classified independently", async () => {
    let n = 0;
    handler = (items) => ({ body: items.map((i) => ({ jsonrpc: "2.0", id: i.id, error: n++ === 0 ? revertErr : { code: -32005, message: "limit" } })) });
    const c = prod(1500);
    const [a, b] = await Promise.all([classify(c), classify(c)]);
    log("ROW5 mixed", a.revert, b.revert);
    expect([a.revert, b.revert].sort()).toEqual([false, true]);
  });

  it("a revert for isOrg then a 429 for the very next request -> lookupGeneration is UNKNOWN only if a generation 429s", async () => {
    const addresses = TEST_ADDRESSES;
    let n = 0;
    handler = (items) => ({ body: items.map((i) => ({ jsonrpc: "2.0", id: i.id, error: n++ === 0 ? revertErr : { code: -32005, message: "limit" } })) });
    const res = await lookupGeneration(prod(1500), addresses, ORG);
    log("ROW5 lookup mixed", JSON.stringify(res));
    // if there is more than one generation, a revert for one and a rate-limit for another must be UNKNOWN
    expect(res.found).toBeNull();
  });

  it("timeout (server delays past timeout): outage, and request count under retryCount 1", async () => {
    handler = (items) => ({ delay: 600, body: items.map((i) => ({ jsonrpc: "2.0", id: i.id, error: revertErr })) });
    hits = 0;
    const r = await classify(prod(200));
    log("ROW5 timeout", r.revert, "hits", hits);
    expect(r.revert).toBe(false);
  });

  it("connection refused / fetch failed / TLS-to-plain: outage", async () => {
    const dead = createPublicClient({ chain: baseSepolia, transport: viemHttp("http://127.0.0.1:1", { timeout: 1500, retryCount: 0, batch: true }) }) as never;
    expect((await classify(dead)).revert).toBe(false);
    const tls = createPublicClient({ chain: baseSepolia, transport: viemHttp(url.replace("http:", "https:"), { timeout: 1500, retryCount: 0, batch: true }) }) as never;
    expect((await classify(tls)).revert).toBe(false);
  });

  it("readProject-style multicall (aggregate3) whose subcall fails with empty return data / revert", async () => {
    // eth_call to Multicall3 returning aggregate3 results: [(false,"0x")] -> viem builds a revert-looking failure
    const { encodeAbiParameters } = await import("viem");
    const enc = (success: boolean, ret: `0x${string}`) =>
      encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }], [[{ success, returnData: ret }]]);
    handler = (items) => ({ body: items.map((i) => ({ jsonrpc: "2.0", id: i.id, result: enc(false, "0x") })) });
    const c: any = prod(1500);
    const [o] = await c.multicall({ allowFailure: true, contracts: [{ address: ORG, abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }], functionName: "ownerOf", args: [1n] }] });
    log("ROW5 multicall failure:", o.status, String(o.error).slice(0, 200));
    const wrapper = new Error(`project ${ORG}/1 does not exist (ownerOf reverted): ${String(o.error)}`);
    log("ROW5 isRevert(sdk wrapper over EMPTY-returndata subcall failure) =", isRevert(wrapper));
  });
});
