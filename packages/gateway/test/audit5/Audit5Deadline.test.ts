/** AUDIT5: per-request deadline vs background work, single-flight sharing, root probe amplification. */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http as viemHttp } from "viem";
import { baseSepolia } from "viem/chains";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { singleFlight } from "../../src/upstream.js";
import { TEST_ADDRESSES } from "../helpers.js";

const log = (...a: unknown[]) => appendFileSync("/tmp/audit5-deadline.log", a.join(" ") + "\n");
let server: http.Server;
let url = "";
let calls: string[] = [];
let delay = 0;
let mode: "hang" | "slow-true" = "slow-true";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const p = JSON.parse(raw);
      const items = Array.isArray(p) ? p : [p];
      for (const i of items) calls.push(i.method);
      if (mode === "hang") return;
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        const out = items.map((i: any) => ({ jsonrpc: "2.0", id: i.id, result: "0x" + "00".repeat(31) + "01" }));
        res.end(JSON.stringify(Array.isArray(p) ? out : out[0]));
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

const ORG = "0x00000000000000000000000000000000000000a1";
const mk = (timeout = 4000, requestTimeoutMs = 300) => {
  const client = createPublicClient({ chain: baseSepolia, transport: viemHttp(url, { timeout, retryCount: 1, batch: true }) }) as never;
  const chain = { id: 84532, contracts: TEST_ADDRESSES, client };
  return createGateway({ chains: [chain], hostMode: { baseHost: "content.example" }, requestTimeoutMs, onError: () => {} });
};
const req = (n = 1) => new Request(`http://84532-${ORG.slice(2)}-${n}.content.example/`, { headers: { host: `84532-${ORG.slice(2)}-${n}.content.example` } });

describe("AUDIT5 deadline", () => {
  it("hung RPC: deadline answers 503 at ~requestTimeoutMs, but the RPC work keeps going (viem timeout 4s x retry)", async () => {
    __resetResolveCaches(); calls = []; mode = "hang";
    const gw = mk(4000, 300);
    const t = Date.now();
    const res = await gw(req());
    log("hang: status", res.status, "after", Date.now() - t, "cc", res.headers.get("cache-control"), "calls@deadline", calls.length);
    await new Promise((r) => setTimeout(r, 6000));
    log("hang: calls 6s later", calls.length);
    expect(res.status).toBe(503);
  }, 20_000);

  it("N concurrent distinct tokens against a hung RPC: how many upstream HTTP calls pile up (batch folds them)?", async () => {
    __resetResolveCaches(); calls = []; mode = "hang";
    const gw = mk(4000, 300);
    const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => gw(req(i + 1))));
    log("flood200: statuses", [...new Set(rs.map((r) => r.status))], "rpc calls", calls.length);
  }, 30_000);

  it("singleFlight: rejected shared promise reaches all waiters once, entry removed; a never-settling promise stays forever (leak, limit 2000)", async () => {
    const m = new Map<string, Promise<number>>();
    const never = () => new Promise<number>(() => {});
    const a = singleFlight(m, "k", never); const b = singleFlight(m, "k", never);
    log("singleFlight never-settling shares:", a === b, "size", m.size);
    const rej = () => Promise.reject(new Error("boom"));
    const m2 = new Map<string, Promise<number>>();
    const r1 = singleFlight(m2, "x", rej); const r2 = singleFlight(m2, "x", rej);
    const out = await Promise.allSettled([r1, r2]);
    log("reject shared:", out.map((o) => o.status), "size after", m2.size);
    // synchronous throw inside work
    const m3 = new Map<string, Promise<number>>();
    let threw = false;
    try { singleFlight(m3, "s", (() => { throw new Error("sync"); }) as never); } catch { threw = true; }
    log("sync throw escapes as sync throw:", threw, "size", m3.size);
    expect(true).toBe(true);
  });
});
