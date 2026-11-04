/**
 * An RPC endpoint must answer for the chain it is configured for. The stores and the factory sit at the same address
 * on every chain, so an endpoint for another chain would answer every read plausibly and serve that chain's content
 * under this chain's URLs. `chainCheckedFetch` asks `eth_chainId` before the first request to each URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WrongChainError, chainCheckedFetch } from "../src/upstream.js";

/** A fake endpoint answering `eth_chainId` with `chainHex` and anything else with `{ result: "ok" }`, counting calls. */
function endpoint(chainHex: string | (() => Response)) {
  const calls: string[] = [];
  const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    calls.push(`${String(input)} ${body.method}`);
    if (body.method === "eth_chainId") {
      return typeof chainHex === "function" ? chainHex() : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chainHex }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
  }) as typeof fetch;
  return { inner, calls };
}

const read = (f: typeof fetch, url = "https://rpc.example/") =>
  f(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [] }) });

afterEach(() => vi.restoreAllMocks());

describe("chainCheckedFetch", () => {
  it("asks eth_chainId once per URL, then passes every request through", async () => {
    const { inner, calls } = endpoint("0x14a34");
    const f = chainCheckedFetch(84532, inner);
    await read(f);
    await read(f);
    await read(f, "https://other.example/");
    expect(calls).toEqual([
      "https://rpc.example/ eth_chainId",
      "https://rpc.example/ eth_call",
      "https://rpc.example/ eth_call",
      "https://other.example/ eth_chainId",
      "https://other.example/ eth_call",
    ]);
  });

  it("refuses every request to an endpoint for another chain, and never forwards one", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { inner, calls } = endpoint("0x2105"); // Base mainnet, configured as Base Sepolia
    const f = chainCheckedFetch(84532, inner);
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    await expect(read(f)).rejects.toThrow(/chain 84532 answers for chain 8453/);
    expect(calls).toEqual(["https://rpc.example/ eth_chainId"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("asks again after a check that could not complete", async () => {
    let fail = true;
    const { inner, calls } = endpoint(() => {
      if (fail) {
        fail = false;
        return new Response("<html>bad gateway</html>", { status: 502 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }));
    });
    const f = chainCheckedFetch(84532, inner);
    await expect(read(f)).rejects.toThrow(/not JSON-RPC/);
    expect((await (await read(f)).json()).result).toBe("ok");
    expect(calls.filter((c) => c.endsWith("eth_chainId"))).toHaveLength(2);
  });

  it("refuses an answer that carries no chain id", async () => {
    const { inner } = endpoint(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "84532" })));
    await expect(read(chainCheckedFetch(84532, inner))).rejects.toThrow(/without a chain id/);
  });
});
