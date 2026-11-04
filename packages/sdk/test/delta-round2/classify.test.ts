/**
 * Delta audit round 2, informational 1-3: the transport classifier (`isTransportFailure`) and `readAtBlock`.
 *
 *   1. A JSON-RPC error's `details` were read for "rate limit" even when the error was a revert, so a contract whose
 *      revert reason says "rate limit exceeded" (anyone can deploy one) read as a dead connection. A revert (code 3,
 *      revert data, viem's revert types) is now never read for words.
 *   2. A provider that answers HTTP 200 with `{"code":-32603,"message":"request timed out"}` was a transport failure
 *      under freeze-2's rule (text over name, message and details) and became an ANSWER when the rule went by type:
 *      `probeExistence` then fanned out to one read per probe against an endpoint that had just timed out. A timeout
 *      in a JSON-RPC error's words is a transport failure again.
 *   3. `readAtBlock` throws a real revert (a `ContractFunctionRevertedError`, the shape viem produces) at once rather
 *      than waiting it out as replica lag.
 *
 * The errors below are viem's own, built by viem from what a node puts on the wire: a local JSON-RPC server answers
 * exactly as a node does.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  createPublicClient,
  encodeAbiParameters,
  getContractError,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { isGasRefusal, isTransportFailure, probeExistence } from "../../src/multicall.js";
import { pinnedReadPolicy, readAtBlock } from "../../src/snapshot.js";

/** `Error(string)` revert data for `reason`. */
const revertData = (reason: string): Hex => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [reason]).slice(2)}` as Hex;

/** What the server answers every call with, per test. */
let answer: (method: string) => { result?: unknown; error?: { code: number; message: string; data?: string } } = () => ({ result: "0x" });
let calls = 0;
let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const out = msgs.map((m) => {
        if (m.method === "eth_chainId") return { jsonrpc: "2.0", id: m.id, result: "0x1" };
        if (m.method === "eth_blockNumber") return { jsonrpc: "2.0", id: m.id, result: "0x64" };
        calls++;
        return { jsonrpc: "2.0", id: m.id, ...answer(m.method) };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => createPublicClient({ transport: http(url, { retryCount: 0 }) }) as PublicClient;
const STORE = "0x00000000000000000000000000000000000000c1" as Address;
const ID = `0x${"11".repeat(32)}` as Hex;
const exists = (c: PublicClient, blockNumber?: bigint) =>
  c.readContract({ address: STORE, abi: chunkStoreAbi, functionName: "exists", args: [ID], ...(blockNumber ? { blockNumber } : {}) });
const errorOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe("a revert is never a transport failure, whatever its reason says", () => {
  for (const reason of ["rate limit exceeded", "HTTP 429", "too many requests", "request timed out", "timeout"]) {
    it(`Error("${reason}") from the contract (code 3, revert data)`, async () => {
      answer = () => ({ error: { code: 3, message: `execution reverted: ${reason}`, data: revertData(reason) } });
      const err = await errorOf(exists(client()));
      expect(err).toBeInstanceOf(BaseError);
      expect((err as BaseError).walk((e) => e instanceof ContractFunctionRevertedError)).not.toBeNull();
      expect(isTransportFailure(err)).toBe(false);
    });
  }

  it("the same words from a node that answers a revert with -32000 and revert data, or code 3 and no data", async () => {
    answer = () => ({ error: { code: -32000, message: "execution reverted: rate limit exceeded", data: revertData("rate limit exceeded") } });
    expect(isTransportFailure(await errorOf(exists(client())))).toBe(false);
    answer = () => ({ error: { code: 3, message: "execution reverted: too many requests" } });
    expect(isTransportFailure(await errorOf(exists(client())))).toBe(false);
  });

  it("an error that is not viem's: code 3 or revert data on it (or its cause) keeps its words out of it", () => {
    expect(isTransportFailure(Object.assign(new Error("execution reverted: rate limit"), { code: 3 }))).toBe(false);
    expect(isTransportFailure(Object.assign(new Error("rate limit"), { data: revertData("rate limit") }))).toBe(false);
    expect(isTransportFailure(Object.assign(new Error("call failed: rate limit"), { cause: { code: 3 } }))).toBe(false);
    expect(isTransportFailure(new Error("execution reverted: rate limit exceeded"))).toBe(false);
    // Without either, its words still decide, and an HTTP 429 always does.
    expect(isTransportFailure(new Error("rate limit exceeded"))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error("execution reverted"), { code: 3, status: 429 }))).toBe(true);
  });
});

describe("a rate limit or a timeout answered as a JSON-RPC error is a transport failure", () => {
  for (const [code, message] of [
    [-32603, "request timed out"],
    [-32000, "execution aborted (timeout = 5s)"],
    [-32016, "over rate limit"],
    [-32000, "Too Many Requests"],
    [-32005, "limit exceeded"],
  ] as const) {
    it(`${code} "${message}"`, async () => {
      answer = () => ({ error: { code, message } });
      const err = await errorOf(exists(client()));
      expect(isTransportFailure(err)).toBe(true);
      expect(isGasRefusal(err)).toBe(false);
    });
  }

  it("even though viem calls a -32603 with a message a revert (ContractFunctionRevertedError), so that type decides nothing", async () => {
    answer = () => ({ error: { code: -32603, message: "request timed out" } });
    const err = await errorOf(exists(client()));
    expect((err as BaseError).walk((e) => e instanceof ContractFunctionRevertedError)).not.toBeNull();
    expect(isTransportFailure(err)).toBe(true);
  });

  it("an answer that is neither is not: header not found, out of gas, a plain revert", async () => {
    for (const error of [
      { code: -32000, message: "header not found" },
      { code: -32000, message: "out of gas" },
      { code: 3, message: "execution reverted", data: "0x" },
    ]) {
      answer = () => ({ error });
      expect(isTransportFailure(await errorOf(exists(client())))).toBe(false);
    }
  });

  it("probeExistence rethrows a JSON-RPC timeout at once instead of fanning out to one read per probe", async () => {
    answer = () => ({ error: { code: -32603, message: "request timed out" } });
    calls = 0;
    const targets = Array.from({ length: 40 }, (_, i) => ({
      address: STORE as Hex,
      abi: chunkStoreAbi as readonly unknown[],
      fn: "exists",
      arg: `0x${i.toString(16).padStart(64, "0")}` as Hex,
    }));
    await expect(probeExistence(client(), targets)).rejects.toThrow(/request timed out/);
    expect(calls).toBe(1); // the one batched call; under the type-only rule it went on to 40 single reads
  });
});

describe("readAtBlock", () => {
  const withPolicy = async (f: () => Promise<void>) => {
    const saved = { ...pinnedReadPolicy };
    pinnedReadPolicy.delayMs = 1;
    try {
      await f();
    } finally {
      Object.assign(pinnedReadPolicy, saved);
    }
  };

  it("a revert at the pinned block is thrown at once: a ContractFunctionRevertedError, as viem builds one", async () => {
    await withPolicy(async () => {
      // The error exactly as `readContract` throws it for revert data on the wire.
      const viemShaped = getContractError(new RawContractError({ data: revertData("ChunkNotFound") }), {
        abi: chunkStoreAbi,
        address: STORE,
        args: [ID],
        functionName: "exists",
      });
      expect((viemShaped as BaseError).walk((e) => e instanceof ContractFunctionRevertedError)).not.toBeNull();
      let n = 0;
      const fake = {
        async readContract() {
          n++;
          throw viemShaped;
        },
      } as unknown as PublicClient;
      await expect(readAtBlock(fake, { address: STORE, abi: chunkStoreAbi, functionName: "exists", args: [ID] }, 100n)).rejects.toBe(viemShaped);
      expect(n).toBe(1);

      // And over the wire: a node's code-3 answer, then a JSON-RPC timeout: one call each.
      for (const error of [
        { code: 3, message: "execution reverted: ChunkNotFound", data: revertData("ChunkNotFound") },
        { code: -32603, message: "request timed out" },
      ]) {
        answer = () => ({ error });
        calls = 0;
        await expect(readAtBlock(client(), { address: STORE, abi: chunkStoreAbi, functionName: "exists", args: [ID] }, 100n)).rejects.toThrow();
        expect(calls).toBe(1);
      }
    });
  });

  it("a replica that has not seen the block (an answer that is no revert) is still waited out", async () => {
    await withPolicy(async () => {
      answer = () => ({ error: { code: -32000, message: "header not found" } });
      calls = 0;
      await expect(readAtBlock(client(), { address: STORE, abi: chunkStoreAbi, functionName: "exists", args: [ID] }, 100n)).rejects.toThrow(
        /header not found/,
      );
      expect(calls).toBe(pinnedReadPolicy.attempts);
    });
  });
});
