/**
 * DELTA-2: `chainCheckedFetch` now lives as long as its process (one per chain), so a wrong-chain refusal cached in it
 * lasted the life of the instance: an operator who fixed the endpoint behind the same URL needed a restart. It is now
 * refused for {@link WRONG_CHAIN_TTL_MS} and then asked again; an endpoint that answered for the right chain is still
 * asked once. And the two branches nothing exercised: a probe answer with no body, and a caller with a signal whose
 * probe rejects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WRONG_CHAIN_TTL_MS, WrongChainError, chainCheckedFetch } from "../../src/upstream.js";

const READ = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [] });

/** An endpoint whose `eth_chainId` answer is `answer()`, counting probes and reads. */
function endpoint(answer: () => Response | Promise<Response>) {
  const counts = { probes: 0, reads: 0 };
  const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "eth_chainId") {
      counts.probes++;
      return answer();
    }
    counts.reads++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" }));
  }) as typeof fetch;
  return { inner, counts };
}
const chainIs = (hex: string) => () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex }));
const read = (f: typeof fetch, init: RequestInit = {}) => f("https://rpc.example/", { method: "POST", body: READ, ...init });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a wrong-chain refusal lapses", () => {
  it("is refused for five minutes, then asked again: a fixed endpoint serves without a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(WRONG_CHAIN_TTL_MS).toBe(5 * 60_000);
    let hex = "0x2105"; // Base mainnet, configured as Base Sepolia
    const { inner, counts } = endpoint(() => chainIs(hex)());
    const f = chainCheckedFetch(84532, inner);
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    vi.advanceTimersByTime(WRONG_CHAIN_TTL_MS - 1_000);
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    expect(counts).toEqual({ probes: 1, reads: 0 });
    // Still wrong after the TTL: asked again, refused again, and logged again.
    vi.advanceTimersByTime(2_000);
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    expect(counts).toEqual({ probes: 2, reads: 0 });
    expect(log).toHaveBeenCalledTimes(2);
    // Fixed behind the same URL: the next probe after the TTL passes, and reads flow.
    hex = "0x14a34";
    vi.advanceTimersByTime(WRONG_CHAIN_TTL_MS + 1);
    await read(f);
    expect(counts).toEqual({ probes: 3, reads: 1 });
  });

  it("an endpoint that answered for the right chain is asked once, however long the process lives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { inner, counts } = endpoint(chainIs("0x14a34"));
    const f = chainCheckedFetch(84532, inner);
    await read(f);
    vi.advanceTimersByTime(10 * WRONG_CHAIN_TTL_MS);
    await read(f);
    await read(f);
    expect(counts).toEqual({ probes: 1, reads: 3 });
  });

  it("the TTL is an option", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { inner, counts } = endpoint(chainIs("0x2105"));
    const f = chainCheckedFetch(84532, inner, { wrongChainTtlMs: 10 });
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    vi.advanceTimersByTime(11);
    await expect(read(f)).rejects.toBeInstanceOf(WrongChainError);
    expect(counts.probes).toBe(2);
  });
});

describe("the branches nothing exercised", () => {
  it("a probe answer with no body is not a chain id: refused, and asked again next time", async () => {
    let empty = true;
    const { inner, counts } = endpoint(() => (empty ? new Response(null, { status: 200 }) : chainIs("0x14a34")()));
    const f = chainCheckedFetch(84532, inner);
    await expect(read(f)).rejects.toThrow(/eth_chainId answered with something that is not JSON-RPC \(HTTP 200\)/);
    expect(counts).toEqual({ probes: 1, reads: 0 });
    empty = false;
    await read(f);
    expect(counts).toEqual({ probes: 2, reads: 1 });
  });

  it("a caller with a live signal gets the probe's own rejection, and its abort listener is removed", async () => {
    const { inner } = endpoint(() => {
      throw new TypeError("fetch failed");
    });
    const f = chainCheckedFetch(84532, inner);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(read(f, { signal: controller.signal })).rejects.toThrow(/fetch failed/);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    // Aborting afterwards changes nothing: the listener is gone.
    controller.abort();
  });
});
