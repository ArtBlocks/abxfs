/**
 * Delta audit L-1 (inverted): split-on-gas-refusal never fired for code-storing writes. When a node simulates too
 * little gas for a CREATE2 write, Solady's SSTORE2 reverts `DeploymentFailed()` (0x30116425), so the bundle's failure
 * carries revert data and `isGasRefusal` called it a contract refusing the calls. A chain whose block (and so every
 * eth_call and estimate) is 10M gas, and one bundle of four 24,000-byte raw chunk writes (~5.4M each): the bundle
 * cannot run in 10M and each write alone can, so it must land as four 1-call transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RpcRequestError,
  keccak256,
  type Hex,
} from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { DEPLOYMENT_FAILED_SELECTOR, contentWriteCall, isGasRefusal, sendBundles } from "../../src/multicall.js";
import { chunkStoreWriteAbi, contentWriteErrorsAbi, directoryStoreWriteAbi, fileStoreWriteAbi } from "../../src/stores.js";
import type { Bundle } from "../../src/gas.js";
import { planChunk } from "../../src/plan.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => {
  h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", "10000000"] });
}, 300_000);
afterAll(async () => h?.stop());

function bundleOf(size: number, n: number, seed: number): Bundle {
  const calls = Array.from({ length: n }, (_, i) => {
    const data = new Uint8Array(size).fill(seed + i);
    const hex = ("0x" + Buffer.from(data).toString("hex")) as Hex;
    return contentWriteCall(h.addresses.chunkStore, { backend: h.addresses.sstore2Backend, input: hex, dataHash: keccak256(data), size }, 2_000_000);
  });
  return { target: h.addresses.chunkStore, calls, estimatedGas: 2_000_000 * n };
}

describe("split on a real gas refusal (a CREATE2 that runs out of gas)", () => {
  it("the node's refusal is DeploymentFailed(), it decodes by name through the stage ABI, and it counts as a gas refusal", async () => {
    const b = bundleOf(24_000, 4, 0x30);
    let err: unknown;
    try {
      await h.publicClient.simulateContract({
        address: h.addresses.chunkStore,
        abi: chunkStoreWriteAbi as never,
        functionName: "multicall",
        args: [b.calls.map((c) => c.data)],
        account: h.walletClient.account,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BaseError);
    const reverted = (err as BaseError).walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    expect(reverted?.data?.errorName).toBe("DeploymentFailed");
    expect(isGasRefusal(err)).toBe(true);
  }, 300_000);

  for (const [label, size, n, seed, expected] of [
    ["4 x 24,000-byte raw chunks land as four 1-call transactions", 24_000, 4, 0x30, [1, 1, 1, 1]],
    ["8 x 6,000-byte raw chunks land as two 4-call transactions", 6_000, 8, 0x50, [4, 4]],
  ] as const) {
    it(label, async () => {
      const bundle = bundleOf(size, n, seed);
      const before = await h.publicClient.getTransactionCount({ address: h.account.address });
      const sent: number[] = [];
      await sendBundles({ publicClient: h.publicClient as never, walletClient: h.walletClient as never }, [bundle], chunkStoreWriteAbi as never, {
        onBundleSent: (b) => sent.push(b.calls.length),
      });
      const after = await h.publicClient.getTransactionCount({ address: h.account.address });
      expect(sent).toEqual([...expected]);
      expect(after - before).toBe(expected.length);
      // Every chunk landed.
      for (let i = 0; i < n; i++) {
        const { id } = planChunk(new Uint8Array(size).fill(seed + i), { raw: h.addresses.sstore2Backend });
        expect(await h.publicClient.readContract({ address: h.addresses.chunkStore, abi: chunkStoreAbi, functionName: "exists", args: [id] })).toBe(true);
      }
    }, 600_000);
  }
});

describe("isGasRefusal and the stage ABIs", () => {
  const rpc = (data: string) => new BaseError("call failed", { cause: Object.assign(new RpcRequestError({ body: {}, url: "http://x", error: { code: 3, message: "execution reverted", data } }), {}) });

  it("empty revert data, or exactly DeploymentFailed(), may be gas; DeploymentFailed with trailing bytes, or any other selector, is not", () => {
    expect(DEPLOYMENT_FAILED_SELECTOR).toBe("0x30116425");
    expect(isGasRefusal(rpc("0x30116425"))).toBe(true);
    expect(isGasRefusal(rpc("0x30116425".toUpperCase().replace("0X", "0x")))).toBe(true);
    expect(isGasRefusal(rpc("0x"))).toBe(true);
    expect(isGasRefusal(new BaseError("out of gas"))).toBe(true);
    expect(isGasRefusal(rpc("0x30116425" + "00".repeat(32)))).toBe(false);
    expect(isGasRefusal(rpc("0x30786386" + "00".repeat(32)))).toBe(false);
  });

  it("never the connection or the person, by type or by EIP-1193 code", () => {
    expect(isGasRefusal(new BaseError("x", { cause: new HttpRequestError({ url: "http://x", status: 503 }) }))).toBe(false);
    expect(isGasRefusal(new BaseError("x", { cause: new HttpRequestError({ url: "http://x", status: 429 }) }))).toBe(false);
    // A wallet's refusal that is not viem's own class: EIP-1193 code 4001 anywhere in the chain (`isUserRejection`).
    expect(isGasRefusal(new BaseError("x", { cause: Object.assign(new Error("User denied"), { code: 4001 }) }))).toBe(false);
    expect(isGasRefusal(new Error("not a viem error"))).toBe(false);
  });

  it("every stage ABI declares DeploymentFailed, DataSize and NoFreeAddress exactly once", () => {
    for (const abi of [chunkStoreWriteAbi, fileStoreWriteAbi, directoryStoreWriteAbi]) {
      const errors = (abi as ReadonlyArray<{ type: string; name?: string }>).filter((e) => e.type === "error").map((e) => e.name);
      for (const { name } of contentWriteErrorsAbi) expect(errors.filter((x) => x === name)).toHaveLength(1);
      expect(new Set(errors).size).toBe(errors.length);
    }
  });
});
