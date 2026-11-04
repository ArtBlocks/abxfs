/**
 * DELTA AUDIT informational fixes in `upstream.ts`, and the branches the auditor found untested there:
 *
 *  - `chainCheckedFetch` read the `eth_chainId` answer with no cap, and ran the SHARED check on the first caller's
 *    AbortSignal, so one visitor giving up aborted the check for everyone waiting on it. The answer is now read to
 *    64 KiB and the check runs on its own timeout; each caller still stops waiting on its own signal.
 *  - `strictBatchFetch` buffered a whole batch answer with no cap. It now stops at viem's own 10 MiB (or `maxBytes`).
 */
import { describe, expect, it, vi } from "vitest";

import {
  BATCH_RESPONSE_MAX_BYTES,
  BatchIdScanner,
  CHAIN_ID_PROBE_MAX_BYTES,
  WrongChainError,
  chainCheckedFetch,
  strictBatchFetch,
} from "../../src/upstream.js";

const READ = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [] });

describe("chainCheckedFetch: the probe", () => {
  it("reads at most 64 KiB of the eth_chainId answer, refuses past it, and asks again next time", async () => {
    let huge = true;
    const calls: string[] = [];
    const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      calls.push(method);
      if (method === "eth_chainId") {
        if (huge) {
          huge = false;
          // A stream that never ends: only the cap stops the read.
          return new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(16_384).fill(0x20));
              },
            }),
          );
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
    }) as typeof fetch;
    const f = chainCheckedFetch(84532, inner);
    await expect(f("https://rpc.example/", { method: "POST", body: READ })).rejects.toThrow(new RegExp(`more than ${CHAIN_ID_PROBE_MAX_BYTES} bytes`));
    // Not a WrongChainError: the check could not complete, so it is asked again.
    expect((await f("https://rpc.example/", { method: "POST", body: READ })).status).toBe(200);
    expect(calls).toEqual(["eth_chainId", "eth_chainId", "eth_call"]);
  });

  it("runs on its own timeout signal, never the caller's, and a caller that gives up does not abort it for the others", async () => {
    const probeSignals: (AbortSignal | null | undefined)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "eth_chainId") {
        probeSignals.push(init?.signal);
        await gate;
        if (init?.signal?.aborted) throw init.signal.reason;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
    }) as typeof fetch;
    const f = chainCheckedFetch(84532, inner);
    const first = new AbortController();
    const second = new AbortController();
    const a = f("https://rpc.example/", { method: "POST", body: READ, signal: first.signal });
    const b = f(new URL("https://rpc.example/"), { method: "POST", body: READ, signal: second.signal });
    await Promise.resolve();
    first.abort(new Error("visitor left"));
    await expect(a).rejects.toThrow("visitor left");
    release();
    // The second caller (a URL object, the same endpoint) is answered by the one shared check.
    expect((await b).status).toBe(200);
    expect(probeSignals).toHaveLength(1);
    expect(probeSignals[0]).toBeInstanceOf(AbortSignal);
    expect(probeSignals[0]).not.toBe(first.signal);
    expect(probeSignals[0]!.aborted).toBe(false);
  });

  it("a caller already aborted does not wait for the check", async () => {
    const inner = (async () => new Promise<Response>(() => {})) as typeof fetch; // never answers
    const f = chainCheckedFetch(84532, inner, { probeTimeoutMs: 60_000 });
    const c = new AbortController();
    c.abort(new Error("gone"));
    await expect(f("https://rpc.example/", { method: "POST", body: READ, signal: c.signal })).rejects.toThrow("gone");
  });

  it("the probe times out on its own clock, and is then asked again", async () => {
    let n = 0;
    const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "eth_chainId" && n++ === 0) {
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
      }
      if (method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
    }) as typeof fetch;
    const f = chainCheckedFetch(84532, inner, { probeTimeoutMs: 20 });
    await expect(f("https://rpc.example/", { method: "POST", body: READ })).rejects.toThrow();
    expect((await f("https://rpc.example/", { method: "POST", body: READ })).status).toBe(200);
  });

  it("keys the check by URL whatever form the input takes (string, URL, Request)", async () => {
    const seen: string[] = [];
    const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "request";
      seen.push(`${String(input instanceof Request ? input.url : input)} ${method}`);
      if (method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }));
      return new Response("{}");
    }) as typeof fetch;
    const f = chainCheckedFetch(84532, inner);
    await f(new Request("https://rpc.example/a", { method: "POST", body: READ }));
    await f("https://rpc.example/a", { method: "POST", body: READ });
    expect(seen.filter((s) => s.endsWith("eth_chainId"))).toEqual(["https://rpc.example/a eth_chainId"]);
  });

  it("an endpoint for another chain is still refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inner = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105" }))) as typeof fetch;
    const f = chainCheckedFetch(84532, inner);
    await expect(f("https://rpc.example/", { method: "POST", body: READ })).rejects.toBeInstanceOf(WrongChainError);
    vi.restoreAllMocks();
  });
});

describe("strictBatchFetch: bounded buffering, and the branches nothing exercised", () => {
  const batch = JSON.stringify([{ id: 1 }, { id: 2 }]);
  const via = (res: () => Response, options?: { maxBytes?: number }) =>
    strictBatchFetch((async () => res()) as typeof fetch, options)("http://x", { method: "POST", body: batch });

  it("defaults to viem's own 10 MiB", () => {
    expect(BATCH_RESPONSE_MAX_BYTES).toBe(10_485_760);
  });

  it("stops reading a streamed answer past the cap: a 502, and the stream is cancelled", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024).fill(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await via(() => new Response(stream), { maxBytes: 4096 });
    expect(r.status).toBe(502);
    expect(await r.text()).toMatch(/larger than 4096 bytes/);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("refuses a declared Content-Length past the cap without reading", async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(c) {
        pulled += 1;
        c.enqueue(new TextEncoder().encode("[]"));
        c.close();
      },
    });
    const r = await via(() => new Response(stream, { headers: { "content-length": "99999" } }), { maxBytes: 1000 });
    expect(r.status).toBe(502);
    expect(pulled).toBeLessThanOrEqual(1); // a stream may pre-pull once; nothing is read by the fetch
  });

  it("a matching answer at the cap passes intact", async () => {
    const body = JSON.stringify([{ id: 1, result: "0x" }, { id: 2, result: "0x" }]);
    const r = await via(() => new Response(body), { maxBytes: body.length });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(body);
  });

  it("a request body that starts with [ but is not JSON is passed through untouched", async () => {
    const original = new Response("whatever");
    const f = strictBatchFetch((async () => original) as typeof fetch);
    expect(await f("http://x", { method: "POST", body: "[not json" })).toBe(original);
  });

  it("a body that breaks off mid-read rejects (viem reports the transport failure)", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('[{"id":1}'));
        c.error(new Error("connection reset"));
      },
    });
    await expect(via(() => new Response(stream))).rejects.toThrow("connection reset");
  });

  it("a null-body status from a non-standard fetch is replayed with no body", async () => {
    const fake = {
      status: 304,
      statusText: "Not Modified",
      headers: new Headers({ "content-length": "21" }),
      body: new Response(batch).body,
    } as unknown as Response;
    const r = await via(() => fake);
    expect(r.status).toBe(304);
    expect(r.body).toBeNull();
  });
});

describe("BatchIdScanner: the rare paths", () => {
  const scan = (text: string) => {
    const s = new BatchIdScanner();
    s.push(new TextEncoder().encode(text));
    return s.finish();
  };

  it("a key longer than 64 bytes is never `id`, and the real id after it is read", () => {
    expect(scan(`[{"${"i".repeat(70)}d":5,"id":1},{"id":2}]`)).toEqual({ kind: "ids", ids: [1, 2] });
  });

  it("an id value that is not JSON is unreadable (matches no request)", () => {
    const out = scan('[{"id":01},{"id":2}]');
    expect(out.kind).toBe("ids");
    expect(typeof (out as { ids: unknown[] }).ids[0]).toBe("symbol");
  });

  it("a key with an invalid escape reads as no key at all", () => {
    expect(scan('[{"\\q":5,"id":1},{"id":2}]')).toEqual({ kind: "ids", ids: [1, 2] });
  });

  it("a second `id` in one element makes it unreadable", () => {
    const out = scan('[{"id":1,"id":1},{"id":2}]') as { kind: string; ids: unknown[] };
    expect(typeof out.ids[0]).toBe("symbol");
  });
});
