/**
 * Sequential transactions behind a load-balanced RPC. After a receipt, the node that answers the next
 * `eth_getTransactionCount` may not have counted the transaction yet, so a signer that lets viem fetch the nonce for
 * each send reuses one and fails `replacement transaction underpriced` (seen on Base Sepolia behind Alchemy). A
 * locally held key therefore sends with explicit, incrementing nonces, and waits for the node to catch up before
 * returning.
 */
import { describe, expect, it } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";

import { feeBumpPolicy, sendBundles } from "../src/multicall.js";
import type { Bundle } from "../src/gas.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as const;
const bundle = (n: number): Bundle => ({ target: TARGET, calls: [{ target: TARGET, data: `0x${n.toString(16).padStart(2, "0")}` as Hex, estimatedGas: 1 }], estimatedGas: 1 });
const abi = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "r", type: "bytes[]" }] }] as const;

function rig(accountType: "local" | "json-rpc") {
  const sent: Array<number | undefined> = [];
  let mined = 5; // nonce of the next transaction on chain
  let staleReads = 0; // how many count reads still answer from a replica that is behind
  const publicClient = {
    async simulateContract(a: { account: unknown }) {
      return { request: { account: a.account, address: TARGET, abi, functionName: "multicall", args: [[]] } };
    },
    async getTransactionCount() {
      if (staleReads > 0) {
        staleReads--;
        return mined - 1; // a replica that has not yet counted the last transaction
      }
      return mined;
    },
    async waitForTransactionReceipt() {
      return { status: "success" };
    },
    async getTransactionReceipt() {
      return { status: "success" };
    },
  } as unknown as PublicClient;
  const walletClient = {
    account: { type: accountType, address: "0x00000000000000000000000000000000000000ee" },
    async writeContract(req: { nonce?: number }) {
      sent.push(req.nonce);
      mined++;
      staleReads = 2; // after every mined transaction the next reads are stale
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
  } as unknown as WalletClient;
  return { publicClient, walletClient, sent, mined: () => mined };
}

describe("sendBundles nonces", () => {
  it("a local key sends 5, 6, 7... even when every read after a receipt is stale, and waits for the count to catch up", async () => {
    const r = rig("local");
    await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle(1), bundle(2), bundle(3)], abi as never);
    expect(r.sent).toEqual([5, 6, 7]);
    expect(r.mined()).toBe(8);
  });

  it("a wallet that manages its own nonces (json-rpc) is left alone: no nonce is passed", async () => {
    const r = rig("json-rpc");
    await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle(1), bundle(2)], abi as never);
    expect(r.sent).toEqual([undefined, undefined]);
  });

  it("no bundles, no reads and no sends", async () => {
    const r = rig("local");
    expect(await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [], abi as never)).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("a stalled send is replaced at the SAME nonce with doubled fees, and whichever attempt mines settles it", async () => {
    const saved = { ...feeBumpPolicy };
    feeBumpPolicy.stallMs = 50;
    try {
      const sends: Array<{ nonce?: number; tip?: bigint; cap?: bigint }> = [];
      const minedHashes = new Set<string>();
      const publicClient = {
        async simulateContract(a: { account: unknown }) {
          return { request: { account: a.account, address: TARGET, abi, functionName: "multicall", args: [[]] } };
        },
        async getTransactionCount() {
          return 9;
        },
        async getTransaction({ hash }: { hash: string }) {
          const i = Number(BigInt(hash)) - 1;
          return { maxPriorityFeePerGas: sends[i]!.tip ?? 1_000_000n, maxFeePerGas: sends[i]!.cap ?? 13_000_000n };
        },
        async getTransactionReceipt({ hash }: { hash: string }) {
          if (!minedHashes.has(hash)) throw new Error("TransactionReceiptNotFoundError");
          return { status: "success" };
        },
      } as unknown as PublicClient;
      const walletClient = {
        account: { type: "local", address: "0x00000000000000000000000000000000000000ee" },
        async writeContract(req: { nonce?: number; maxPriorityFeePerGas?: bigint; maxFeePerGas?: bigint }) {
          sends.push({ nonce: req.nonce, tip: req.maxPriorityFeePerGas, cap: req.maxFeePerGas });
          const hash = `0x${sends.length.toString(16).padStart(64, "0")}`;
          if (sends.length === 3) minedHashes.add(hash); // the second raise is what the sequencer takes
          return hash as Hex;
        },
      } as unknown as WalletClient;
      const hashes = await sendBundles({ publicClient, walletClient }, [bundle(1)], abi as never);
      expect(sends.map((s) => s.nonce)).toEqual([9, 9, 9]);
      expect(sends.map((s) => s.tip)).toEqual([undefined, 2_000_000n, 4_000_000n]);
      expect(sends.map((s) => s.cap)).toEqual([undefined, 26_000_000n, 52_000_000n]);
      expect(hashes).toEqual([`0x${(3).toString(16).padStart(64, "0")}`]);
    } finally {
      Object.assign(feeBumpPolicy, saved);
    }
  });

  it("if the ORIGINAL mines while a replacement is refused (nonce spent), that original is the answer", async () => {
    const saved = { ...feeBumpPolicy };
    feeBumpPolicy.stallMs = 50;
    try {
      let n = 0;
      let firstMined = false;
      const first = `0x${(1).toString(16).padStart(64, "0")}`;
      const publicClient = {
        async simulateContract(a: { account: unknown }) {
          return { request: { account: a.account, address: TARGET, abi, functionName: "multicall", args: [[]] } };
        },
        async getTransactionCount() {
          return 3;
        },
        async getTransaction() {
          return { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n };
        },
        async getTransactionReceipt({ hash }: { hash: string }) {
          if (hash === first && firstMined) return { status: "success" };
          throw new Error("TransactionReceiptNotFoundError");
        },
      } as unknown as PublicClient;
      const walletClient = {
        account: { type: "local", address: "0x00000000000000000000000000000000000000ee" },
        async writeContract() {
          n++;
          if (n === 1) return first as Hex;
          firstMined = true;
          throw Object.assign(new Error("nonce too low"), { details: "nonce too low" });
        },
      } as unknown as WalletClient;
      expect(await sendBundles({ publicClient, walletClient }, [bundle(1)], abi as never)).toEqual([first]);
    } finally {
      Object.assign(feeBumpPolicy, saved);
    }
  });

  it("a failed (reverted) mined attempt is an error, never success", async () => {
    const saved = { ...feeBumpPolicy };
    feeBumpPolicy.stallMs = 50;
    try {
      const r = rig("local");
      (r.publicClient as unknown as { getTransactionReceipt: () => Promise<unknown> }).getTransactionReceipt = async () => ({ status: "reverted" });
      await expect(sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle(1)], abi as never)).rejects.toThrow();
    } finally {
      Object.assign(feeBumpPolicy, saved);
    }
  });
});
