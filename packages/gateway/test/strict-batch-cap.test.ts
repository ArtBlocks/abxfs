import { describe, expect, it } from "vitest";
import { strictBatchFetch } from "../src/upstream.js";

const req = JSON.stringify([{ id: 1 }, { id: 2 }]);
const call = (resp: () => Response) => strictBatchFetch((async () => resp()) as typeof fetch)("http://x", { method: "POST", body: req });

/**
 * There is no size past which a batch answer goes unchecked any more (audit 9, L4): the large answers are the ones
 * that carry chunk data, and viem hands out results by position without looking at ids.
 */
describe("strictBatchFetch checks ids at any size", () => {
  it("still rejects a mismatched small batch", async () => {
    const r = await call(() => new Response(JSON.stringify([{ id: 9 }, { id: 2 }]), { headers: { "content-type": "application/json" } }));
    expect(r.status).toBe(502);
  });
  it("rejects a mismatched batch over the old 4 MiB inspection cap", async () => {
    const big = JSON.stringify([{ id: 9, result: "x".repeat(5 * 1024 * 1024) }]);
    const r = await call(() => new Response(big));
    expect(r.status).toBe(502);
  });
  it("passes a MATCHING batch over the old cap through intact", async () => {
    const big = JSON.stringify([{ jsonrpc: "2.0", id: 2, result: "x".repeat(5 * 1024 * 1024) }, { jsonrpc: "2.0", id: 1, result: "0x" }]);
    const r = await call(() => new Response(big, { headers: { "content-type": "application/json" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.text()).toBe(big);
  });
  it("a declared oversize length no longer buys a pass: the ids are read from what arrives", async () => {
    const r = await call(() => new Response("[]", { headers: { "content-length": String(50 * 1024 * 1024) } }));
    expect(r.status).toBe(502);
  });
});
