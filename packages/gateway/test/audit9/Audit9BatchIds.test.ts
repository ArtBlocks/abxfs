/**
 * AUDIT 9, L4: `strictBatchFetch` passed a batch answer over 4 MiB through UNCHECKED, believing viem validated it.
 * viem does not check ids: it hands each call the result at its position. A batch over 4 MiB is exactly one that
 * carries chunk data, so a mismatched id there was a silently mis-attributed chunk. Now every batch is checked, at any
 * size, by reading only the ids.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, http } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BatchIdScanner, strictBatchFetch } from "../../src/upstream.js";

const BIG = "0x" + "11".repeat(2_200_000); // ~4.4 MB of hex per result
const SMALL = "0x" + "aa".repeat(32);
const mode = { big: false, mismatch: true };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const calls = JSON.parse(body) as Array<{ id: number; params: [{ data: string }] }>;
    const result = (c: (typeof calls)[number]) => (mode.big && c.params[0].data.endsWith("01") ? BIG : SMALL + c.params[0].data.slice(-2));
    // The proxy quirk from the audit: answers reversed and ids off by one (not the request's ids). viem sorts by id and
    // hands out by position, so unchecked, call 01 got call 02's answer and the reverse, with no error anywhere.
    const out = mode.mismatch
      ? calls.slice().reverse().map((c, i) => ({ jsonrpc: "2.0", id: calls[i]!.id + 1, result: result(c) }))
      : calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: result(c) }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
});
let url = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const call = (client: ReturnType<typeof createPublicClient>, tag: string) =>
  client.call({ to: "0x00000000000000000000000000000000000000c1", data: `0xdeadbeef${tag}` as `0x${string}` });

describe("L4: through a real viem client", () => {
  const client = () => createPublicClient({ transport: http(url, { batch: true, retryCount: 0, fetchFn: strictBatchFetch() }) });

  it("a small mis-attributed batch fails every call", async () => {
    Object.assign(mode, { big: false, mismatch: true });
    // two calls at once on ONE client, so viem batches them
    const c = client();
    const both = await Promise.allSettled([call(c, "01"), call(c, "02")]);
    expect(both.map((x) => x.status)).toEqual(["rejected", "rejected"]);
  });

  it("a LARGE mis-attributed batch (over the old 4 MiB cap) fails every call too, instead of swapping answers", async () => {
    Object.assign(mode, { big: true, mismatch: true });
    const c = client();
    const both = await Promise.allSettled([call(c, "01"), call(c, "02")]);
    expect(both.map((x) => x.status)).toEqual(["rejected", "rejected"]);
  });

  it("a large, correct batch is delivered to the right calls", async () => {
    Object.assign(mode, { big: true, mismatch: false });
    const c = client();
    const [a, b] = await Promise.all([call(c, "01"), call(c, "02")]);
    expect(a.data!.length).toBe(BIG.length);
    expect(b.data).toBe(`${SMALL}02`);
  });
});

/** Feed `text` to a scanner in pieces of `step` bytes (every boundary a real stream might cut at). */
function scan(text: string, step = Infinity) {
  const bytes = new TextEncoder().encode(text);
  const s = new BatchIdScanner();
  for (let i = 0; i < bytes.length; i += step === Infinity ? bytes.length : step) s.push(bytes.subarray(i, Math.min(bytes.length, i + (step === Infinity ? bytes.length : step))));
  return s.finish();
}

describe("L4: the id scanner", () => {
  it("reads numeric, string and null ids, in order, with whitespace anywhere", () => {
    expect(scan('[{"jsonrpc":"2.0","id":1,"result":"0x"},{"id":"a","result":"0x"},{"id":null,"error":{"code":3}}]')).toEqual({ kind: "ids", ids: [1, "a", null] });
    expect(scan(' \n[ { "id" : 7 , "result" : "0x12" } , { "result":"0x", "id" : 8 } ] \n')).toEqual({ kind: "ids", ids: [7, 8] });
    expect(scan("﻿[{\"id\":1}]")).toEqual({ kind: "ids", ids: [1] });
  });

  it("is not fooled by an `id` inside a string or a nested object", () => {
    const tricky = '[{"result":"\\"id\\":99","error":{"id":42,"data":{"id":5}},"id":3}]';
    expect(scan(tricky)).toEqual({ kind: "ids", ids: [3] });
    expect(scan('[{"\\u0069d":4}]')).toEqual({ kind: "ids", ids: [4] }); // an escaped key IS "id" to JSON.parse
  });

  it("gives the same answer however the bytes are split", () => {
    const text = JSON.stringify([{ jsonrpc: "2.0", id: 10, result: "0x" + "ab".repeat(300) }, { jsonrpc: "2.0", id: 11, error: { code: -32000, message: 'a "quoted", \\ thing' } }]);
    for (const step of [1, 2, 3, 7, 64, 1000]) expect(scan(text, step), String(step)).toEqual({ kind: "ids", ids: [10, 11] });
  });

  it("marks what it cannot trust", () => {
    const ids = (t: string) => {
      const r = scan(t);
      return r.kind === "ids" ? r.ids.map((x) => (typeof x === "symbol" ? "?" : x)) : r.kind;
    };
    expect(ids('[{"id":1,"id":2}]')).toEqual(["?"]); // a repeated id: neither
    expect(ids('[{"result":"0x"}]')).toEqual(["?"]); // no id
    expect(ids("[1,2]")).toEqual(["?", "?"]); // not objects
    expect(ids(`[{"id":"${"x".repeat(300)}"}]`)).toBe("malformed"); // an id too long to be one
    expect(ids('[{"id":1}')).toBe("malformed"); // truncated
    expect(ids('[{"id":1}] x')).toBe("malformed"); // trailing junk
    expect(ids('[{"id":1}}')).toBe("malformed");
    expect(ids("[]")).toEqual([]);
  });

  it("reads a non-array answer (an error object, an HTML page) as not an array", () => {
    expect(scan('{"jsonrpc":"2.0","id":1,"error":{"code":-32600}}').kind).toBe("not-an-array");
    expect(scan("<html>502</html>").kind).toBe("not-an-array");
    expect(scan("").kind).toBe("not-an-array");
  });

  it("scans a multi-megabyte answer quickly", () => {
    const text = JSON.stringify(Array.from({ length: 64 }, (_, i) => ({ jsonrpc: "2.0", id: i, result: "0x" + "cd".repeat(200_000) })));
    const t0 = performance.now();
    expect(scan(text, 65_536)).toEqual({ kind: "ids", ids: Array.from({ length: 64 }, (_, i) => i) });
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe("a batch answered with something other than an array", () => {
  // viem (since 2.57) hands a bare error answering a batch to EVERY call in it, so one `execution reverted` would
  // read as each call reverting. The answer is refused instead: a 2xx becomes a 502, a non-2xx keeps its status.
  const answer = (status: number, text: string) => async () => new Response(text, { status, headers: { "content-type": "application/json" } });
  const batch = { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_call" }, { jsonrpc: "2.0", id: 2, method: "eth_call" }]) };
  const bare = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 3, message: "execution reverted", data: "0x" } });

  it("a bare error object or an HTML page with a 2xx is a 502 that names neither", async () => {
    for (const text of [bare, "<html>execution reverted</html>", ""]) {
      const res = await strictBatchFetch(answer(200, text))("http://rpc.test", batch);
      expect(res.status, text).toBe(502);
      expect(await res.text()).not.toMatch(/execution reverted/);
    }
  });

  it("a non-2xx keeps its status (a 429 stays a 429), without the body", async () => {
    const res = await strictBatchFetch(answer(429, bare))("http://rpc.test", batch);
    expect(res.status).toBe(429);
    expect(await res.text()).not.toMatch(/execution reverted/);
  });

  it("a single (non-batch) request's answer is passed through untouched", async () => {
    const res = await strictBatchFetch(answer(200, bare))("http://rpc.test", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call" }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bare);
  });
});
