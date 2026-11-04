/** Stage N+1's first nonce read can be stale even though stage N's settle() passed (replicas flap). */
import { describe, expect, it } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";
import { sendBundles } from "../../src/multicall.js";
import type { Bundle } from "../../src/gas.js";

const T = "0x00000000000000000000000000000000000000aa" as const;
const b: Bundle = { target: T, calls: [{ target: T, data: "0x01" as Hex, estimatedGas: 1 }], estimatedGas: 1 };
const abi = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "r", type: "bytes[]" }] }] as const;

it("second sendBundles call (next stage) reuses an already-mined nonce when its first read hits a lagging replica", async () => {
  let mined = 5;
  const usedOnChain = new Set<number>();
  let reads = 0;
  const pub = {
    async simulateContract(a: { account: unknown }) { return { request: { account: a.account, address: T, abi, functionName: "multicall", args: [[]] } }; },
    async getTransactionCount() {
      reads++;
      // read #1 (stage 1 start): fresh. read #2 (stage 1 settle): fresh. read #3 (stage 2 start): lagging replica.
      return reads === 3 ? mined - 1 : mined;
    },
    async waitForTransactionReceipt() { return { status: "success" }; },
    async getTransactionReceipt() { return { status: "success" }; },
  } as unknown as PublicClient;
  const wallet = {
    account: { type: "local", address: "0x00000000000000000000000000000000000000ee" },
    async writeContract(req: { nonce?: number }) {
      if (usedOnChain.has(req.nonce!)) throw new Error(`nonce too low: ${req.nonce}`);
      usedOnChain.add(req.nonce!); mined++;
      return "0x01" as Hex;
    },
  } as unknown as WalletClient;
  await sendBundles({ publicClient: pub, walletClient: wallet }, [b], abi as never);
  // stage 2 must not throw: it should never send a nonce below what it already sent itself
  await expect(sendBundles({ publicClient: pub, walletClient: wallet }, [b], abi as never)).resolves.toHaveLength(1);
});
