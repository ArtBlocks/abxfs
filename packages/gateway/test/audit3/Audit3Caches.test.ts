/**
 * AUDIT3 (regression re-audit of cd82b07), FIXED: the negative caches added for the org lookup and token
 * existence used to cache a TRANSIENT upstream failure as "nothing lives here". Now only a DEFINITIVE answer
 * is remembered (an `isOrg` that was read and said false for every generation; a call that reverted).
 * Anything else is a retryable 503, `no-store`, and nothing is cached.
 *
 * These were the FINDING tests; they now assert the safe behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { isRevert } from "../../src/upstream.js";
import { missingTokenError, outageError, revertError } from "../helpers.js";
import { TEST_ADDRESSES } from "../helpers.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const label = (id: number) => `84532-${ORG.slice(2)}-${id}`;
const addresses = TEST_ADDRESSES;

/** What viem throws for a 429, a timeout, a 5xx. */
const transport = (name = "HttpRequestError", status?: number) =>
  Object.assign(new Error("HTTP request failed."), { name, ...(status ? { status } : {}) });
/** What viem throws for a call the EVM rejected. */
const revert = () => revertError();

interface State {
  /** isOrg: "down" throws a transport error, "yes"/"no" answer. */
  org: "down" | "yes" | "no";
  /** The multicall behind readProject. */
  project: "down" | "missing" | "unpublished";
  orgCalls: number;
  projectCalls: number;
}
const ok = (result: unknown) => ({ status: "success" as const, result });
const bad = () => ({ status: "failure" as const, error: new Error("reverted") });

function fakeClient(state: State) {
  return {
    async readContract() {
      state.orgCalls++;
      if (state.org === "down") throw transport("HttpRequestError", 429);
      return state.org === "yes";
    },
    async multicall() {
      state.projectCalls++;
      if (state.project === "down") throw transport("TimeoutError");
      if (state.project === "missing") return [bad(), bad(), bad(), bad(), bad(), bad(), bad(), bad()];
      // Exists, nothing published: owner set, every param unset.
      return [ok("0x0000000000000000000000000000000000000001"), ok("0x" + "00".repeat(32)), ok("0x"), ok("0x"), ok(0n), ok(0), ok("0x"), ok("0x")];
    },
  } as never;
}

function setup(state: State) {
  const chain = { id: 84532, contracts: addresses, client: fakeClient(state) };
  const gw = createGateway({ chains: [chain], defaultChainId: 84532, hostMode: { baseHost: BASE }, onError: () => {} });
  return (id: number) => gw(new Request(`http://${label(id)}.${BASE}/`, { headers: { host: `${label(id)}.${BASE}` } }));
}

beforeEach(() => __resetResolveCaches());
afterEach(() => vi.useRealTimers());

describe("AUDIT3 negative caches vs transient RPC failure", () => {
  it("FIXED: a rate-limited RPC is a retryable 503 (no-store), NOT 'not an org', and nothing is remembered", async () => {
    const state: State = { org: "down", project: "unpublished", orgCalls: 0, projectCalls: 0 };
    const get = setup(state);

    const first = await get(1);
    expect(first.status).toBe(503);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("retry-after")).toBeTruthy();
    expect(await first.text()).not.toContain("is not an org");
    const callsAfterFirst = state.orgCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Still down: asks again (it did not remember the failure).
    expect((await get(2)).status).toBe(503);
    expect(state.orgCalls).toBeGreaterThan(callsAfterFirst);

    // The RPC recovers: the very next request sees the real org (a project that has published nothing: a
    // 404 that is NOT the "not an org" one and that no shared cache holds).
    state.org = "yes";
    const third = await get(3);
    expect(third.status).toBe(404);
    expect(await third.text()).toContain("has not published");
    expect(third.headers.get("cache-control")).toBe("no-store");
  });

  it("FIXED: a failing readProject (transport error, not a revert) is a 503, and is re-read next time", async () => {
    const state: State = { org: "yes", project: "down", orgCalls: 0, projectCalls: 0 };
    const get = setup(state);
    const res = await get(7);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("does not exist");

    expect((await get(7)).status).toBe(503);
    expect(state.projectCalls).toBe(2); // nothing cached

    state.project = "unpublished";
    const healed = await get(7);
    expect(healed.status).toBe(404);
    expect(await healed.text()).toContain("has not published");
  });

  it("FIXED: a token a stale replica reports missing is a SHORT 404 (<= 5s at the edge and in-process), never a sticky 30s one", async () => {
    vi.useFakeTimers();
    const state: State = { org: "yes", project: "missing", orgCalls: 0, projectCalls: 0 };
    const get = setup(state);

    const stale = await get(9);
    expect(stale.status).toBe(404);
    const cc = stale.headers.get("cache-control") ?? "";
    const maxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? "0");
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(5);

    // Within the window the answer is held, so a flood of a missing token costs one read...
    await get(9);
    expect(state.projectCalls).toBe(1);

    // ...and the token that was minted a moment ago is visible as soon as the window lapses and the replica catches up.
    state.project = "unpublished";
    vi.advanceTimersByTime(6_000);
    const seen = await get(9);
    expect(await seen.text()).toContain("has not published");
  });

  it("FIXED: a not-an-org answer that WAS read is definitive but short: <= 5s, then asked again", async () => {
    vi.useFakeTimers();
    const state: State = { org: "no", project: "unpublished", orgCalls: 0, projectCalls: 0 };
    const get = setup(state);
    const res = await get(1);
    expect(res.status).toBe(404);
    expect(Number(/s-maxage=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1])).toBeLessThanOrEqual(5);
    const calls = state.orgCalls;
    await get(2);
    expect(state.orgCalls).toBe(calls);
    vi.advanceTimersByTime(6_000);
    state.org = "yes";
    expect((await get(1)).status).toBe(404); // now an org; published nothing
    expect(state.orgCalls).toBeGreaterThan(calls);
  });
});

describe("AUDIT3 revert vs transport classification", () => {
  it("only a chain-side rejection is a revert", () => {
    expect(isRevert(revert())).toBe(true);
    // An EMPTY answer is not a revert: it is what a dropped call looks like. (`lookupGeneration` proves absence with getCode.)
    expect(isRevert(Object.assign(new Error("x"), { name: "ContractFunctionZeroDataError" }))).toBe(false);
    expect(isRevert(missingTokenError())).toBe(true);
    expect(isRevert(new Error("project 0x1/1 does not exist (ownerOf reverted): ContractFunctionZeroDataError: returned no data"))).toBe(false);
    expect(isRevert(new Error("project 1 does not exist (ownerOf reverted): x"))).toBe(false);
    for (const e of [
      transport("HttpRequestError", 429),
      transport("HttpRequestError", 503),
      transport("TimeoutError"),
      transport("AbortError"),
      Object.assign(new Error("fetch failed"), { name: "TypeError" }),
      new Error("HTTP 429 Too Many Requests"),
      Object.assign(new Error("call failed"), { name: "ContractFunctionExecutionError", cause: transport("HttpRequestError", 502) }),
    ]) {
      expect(isRevert(e), String(e)).toBe(false);
    }
  });
  it("a hostile or cyclic cause chain terminates", () => {
    const a: { name: string; message: string; cause?: unknown } = { name: "X", message: "x" };
    a.cause = a;
    expect(isRevert(a)).toBe(false);
  });
});
