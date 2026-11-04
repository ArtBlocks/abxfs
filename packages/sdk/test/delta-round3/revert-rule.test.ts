/**
 * Delta audit round 3, I1: one rule for "is this a revert".
 *
 * `readAtBlock` waits out an error at a pinned block (a lagging replica answers `header not found`) and throws a revert
 * at once. It decided "revert" by its own test, any viem `ContractFunctionRevertedError`, which viem builds for any
 * JSON-RPC `-32603` with a message: a load-balanced RPC's `-32603 header not found` was thrown at once instead of
 * waited out. It now asks `isRevertFailure`, the computation `isTransportFailure` already used (code 3, revert data, a
 * node message that starts `execution reverted`, viem's `ExecutionRevertedError`).
 *
 * Also the non-viem branch of `isTransportFailure` (round 3 coverage): an error with no name, message or details.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, createPublicClient, encodeAbiParameters, http, type Hex, type PublicClient } from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { isRevertFailure, isTransportFailure } from "../../src/multicall.js";
import { pinnedReadPolicy, readAtBlock } from "../../src/snapshot.js";

type RpcError = { code: number; message: string; data?: string };
let answer: RpcError = { code: -32603, message: "internal error" };
let calls = 0;
let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const m = JSON.parse(b) as { id: number; method: string };
      if (m.method === "eth_call") calls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(m.method === "eth_chainId" ? { jsonrpc: "2.0", id: m.id, result: "0x1" } : { jsonrpc: "2.0", id: m.id, error: answer }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;
const STORE = "0x00000000000000000000000000000000000000c1";
const params = { address: STORE, abi: chunkStoreAbi, functionName: "exists", args: [`0x${"11".repeat(32)}` as Hex] } as never;
const revertData = (reason: string): Hex => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}` as Hex;

async function pinnedRead(error: RpcError): Promise<{ err: unknown; calls: number }> {
  answer = error;
  calls = 0;
  const saved = { ...pinnedReadPolicy };
  pinnedReadPolicy.delayMs = 1;
  try {
    const err = await readAtBlock(client(), params, 100n).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { err, calls };
  } finally {
    Object.assign(pinnedReadPolicy, saved);
  }
}

describe("readAtBlock and a JSON-RPC error that is not a revert", () => {
  it("-32603 header not found is waited out like -32000 header not found (it was thrown at once)", async () => {
    for (const error of [
      { code: -32000, message: "header not found" },
      { code: -32603, message: "header not found" },
      { code: -32603, message: "internal error" },
    ]) {
      const { err, calls } = await pinnedRead(error);
      expect(err, JSON.stringify(error)).toBeInstanceOf(BaseError);
      expect(isTransportFailure(err)).toBe(false);
      expect(isRevertFailure(err), JSON.stringify(error)).toBe(false);
      expect(calls, JSON.stringify(error)).toBe(pinnedReadPolicy.attempts);
    }
  });

  it("viem calls the -32603 a ContractFunctionRevertedError, which is why that type decides nothing", async () => {
    const { err } = await pinnedRead({ code: -32603, message: "header not found" });
    expect((err as BaseError).walk((e) => e instanceof ContractFunctionRevertedError)).not.toBeNull();
    expect(isRevertFailure(err)).toBe(false);
  });

  it("a real revert, and a JSON-RPC timeout, are still thrown at once", async () => {
    for (const error of [
      { code: 3, message: "execution reverted: nope", data: revertData("nope") },
      { code: 3, message: "execution reverted" },
      { code: -32000, message: "execution reverted" },
      { code: -32603, message: "execution reverted", data: revertData("hardhat answers reverts as -32603 with data") },
      { code: -32603, message: "request timed out" },
    ]) {
      const { calls } = await pinnedRead(error);
      expect(calls, JSON.stringify(error)).toBe(1);
    }
  });
});

describe("isRevertFailure is the one rule", () => {
  it("viem's errors, from the wire", async () => {
    for (const [error, reverted] of [
      [{ code: 3, message: "execution reverted: nope", data: revertData("nope") }, true],
      [{ code: 3, message: "execution reverted" }, true],
      [{ code: -32000, message: "execution reverted" }, true],
      [{ code: -32000, message: "execution reverted: nope", data: revertData("nope") }, true],
      [{ code: -32603, message: "internal error" }, false],
      [{ code: -32603, message: "header not found" }, false],
      [{ code: -32000, message: "header not found" }, false],
      [{ code: -32000, message: "out of gas" }, false],
      [{ code: -32005, message: "limit exceeded" }, false],
    ] as Array<[RpcError, boolean]>) {
      const { err } = await pinnedRead(error);
      expect(isRevertFailure(err), JSON.stringify(error)).toBe(reverted);
    }
  });

  it("any other error: code 3 or revert data on it or its cause, or words that start `execution reverted`", () => {
    expect(isRevertFailure(new Error("execution reverted: nope"))).toBe(true);
    expect(isRevertFailure(Object.assign(new Error("call failed"), { code: 3 }))).toBe(true);
    expect(isRevertFailure(Object.assign(new Error("call failed"), { data: "0x" }))).toBe(true);
    expect(isRevertFailure(Object.assign(new Error("call failed"), { cause: { data: revertData("x") } }))).toBe(true);
    expect(isRevertFailure(new Error("call failed: execution reverted"))).toBe(false);
    expect(isRevertFailure(Object.assign(new Error("call failed"), { data: "not hex" }))).toBe(false);
    expect(isRevertFailure(Object.assign(new Error("call failed"), { code: -32603 }))).toBe(false);
    for (const odd of [null, undefined, "execution reverted", 3, {}, { cause: null }]) expect(isRevertFailure(odd)).toBe(false);
  });
});

describe("isTransportFailure on an error that is not viem's, with parts missing", () => {
  it("no name, no message, no details: nothing to go on, so not the connection", () => {
    for (const odd of [null, undefined, {}, { cause: null }, { cause: {} }, Object.create(null), 0, "", "a string"]) {
      expect(isTransportFailure(odd), JSON.stringify(odd) ?? "undefined").toBe(false);
    }
  });

  it("each part on its own decides: the name, the message, the details, the status or the cause's status", () => {
    expect(isTransportFailure({ name: "HttpRequestError" })).toBe(true);
    expect(isTransportFailure({ message: "fetch failed" })).toBe(true);
    expect(isTransportFailure({ details: "rate limited" })).toBe(true);
    expect(isTransportFailure({ details: "request timed out" })).toBe(true);
    expect(isTransportFailure({ status: 429 })).toBe(true);
    expect(isTransportFailure({ cause: { status: 429 } })).toBe(true);
    expect(isTransportFailure({ status: 500 })).toBe(false);
    expect(isTransportFailure({ name: "Error", details: "header not found" })).toBe(false);
  });

  it("words of a revert never count, status 429 always does", () => {
    expect(isTransportFailure({ details: "rate limited", code: 3 })).toBe(false);
    expect(isTransportFailure({ message: "execution reverted: timeout" })).toBe(false);
    expect(isTransportFailure({ details: "timeout", cause: { data: "0x" } })).toBe(false);
    expect(isTransportFailure({ code: 3, status: 429 })).toBe(true);
  });
});
