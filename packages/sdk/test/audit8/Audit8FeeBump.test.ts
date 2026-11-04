/**
 * Audit 8: fee-bumped replacement of stalled explicit-nonce sends (`sendWithFeeBumps` in `src/multicall.ts`).
 *
 * B1 FINDING: once a transaction is in flight, ANY replacement error that is not a "nonce spent" message (a transport
 * failure, the CLI's own ABXFS_MAX_FEE_GWEI guard refusing the doubled fee) is thrown straight out, abandoning the
 * hash that is still pending and will mine. The caller sees a plain error, not a TransactionTimeoutError carrying the
 * hash ("may still confirm, do not resend").
 *
 * B2 FINDING: `onBundleSent` fires once per ATTEMPT, so one bundle that needed a raise is reported as two sent
 * bundles: `content-write.ts` counts `txsDone` / `stageCallsDone` twice (progress past 100%) and returns the replaced,
 * never-mined hash in `txHashes`.
 *
 * B3 holds: never mined -> exactly 1 + maxBumps sends, all at one nonce, then TransactionTimeoutError (bounded).
 */
import { describe, expect, it } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";

import { feeBumpPolicy, sendBundles } from "../../src/multicall.js";
import { TransactionTimeoutError } from "../../src/receipts.js";
import type { Bundle } from "../../src/gas.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as const;
const bundle: Bundle = { target: TARGET, calls: [{ target: TARGET, data: "0x01", estimatedGas: 1 }], estimatedGas: 1 };
const abi = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "r", type: "bytes[]" }] }] as const;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

let rigs = 0;
function rig(onSend: (attempt: number, mined: Set<string>) => Hex) {
  // A fresh address per rig: `sendBundles` keeps a per-process nonce floor per chain and address.
  const address = `0x${(0xa8000 + ++rigs).toString(16).padStart(40, "0")}`;
  const mined = new Set<string>();
  const sends: Array<{ nonce?: number; tip?: bigint }> = [];
  const fees = new Map<string, { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint }>();
  const publicClient = {
    chain: { id: 31337 },
    async simulateContract(a: { account: unknown }) {
      return { request: { account: a.account, address: TARGET, abi, functionName: "multicall", args: [[]] } };
    },
    async getTransactionCount() {
      return 4 + (mined.size > 0 ? 1 : 0);
    },
    async getTransaction({ hash }: { hash: string }) {
      const f = fees.get(hash);
      if (!f) throw new Error("TransactionNotFoundError");
      return f;
    },
    async getTransactionReceipt({ hash }: { hash: string }) {
      if (!mined.has(hash)) throw new Error("TransactionReceiptNotFoundError");
      return { status: "success" };
    },
  } as unknown as PublicClient;
  const walletClient = {
    account: { type: "local", address },
    async writeContract(req: { nonce?: number; maxPriorityFeePerGas?: bigint; maxFeePerGas?: bigint }) {
      sends.push({ nonce: req.nonce, tip: req.maxPriorityFeePerGas });
      const hash = onSend(sends.length, mined);
      fees.set(hash, { maxPriorityFeePerGas: req.maxPriorityFeePerGas ?? 1_000_000n, maxFeePerGas: req.maxFeePerGas ?? 3_000_000n });
      return hash;
    },
  } as unknown as WalletClient;
  return { publicClient, walletClient, mined, sends };
}

async function withFastPolicy<T>(f: () => Promise<T>): Promise<T> {
  const saved = { ...feeBumpPolicy };
  feeBumpPolicy.stallMs = 40;
  try {
    return await f();
  } finally {
    Object.assign(feeBumpPolicy, saved);
  }
}

describe("audit8 fee bumping", () => {
  it("B1 FIXED: a transport error on the replacement never abandons the pending original: it is watched until it mines", async () => {
    await withFastPolicy(async () => {
      let pendingOriginal: Hex | undefined;
      const r = rig((attempt) => {
        if (attempt === 1) return (pendingOriginal = h(1)); // accepted, stalls
        // The replacement: the RPC drops the connection (or the CLI's fee ceiling refuses the doubled fee).
        throw Object.assign(new Error("HTTP request failed. Status: 503"), { details: "no backend is currently healthy" });
      });
      // The original mines a moment after the replacement fails.
      setTimeout(() => r.mined.add(pendingOriginal!), 120);
      const hashes = await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle], abi as never);
      expect(hashes).toEqual([pendingOriginal]);
      expect(r.sends.map((s) => s.nonce).every((n) => n === 4)).toBe(true);
    });
  });

  it("B1b FIXED: the CLI fee ceiling refusing every raise ends in a TransactionTimeoutError naming the in-flight hash", async () => {
    await withFastPolicy(async () => {
      const r = rig((attempt) => {
        if (attempt === 1) return h(1);
        throw new Error("refusing to send: the transaction's maxFeePerGas is 240 gwei, above the 200 gwei ceiling (ABXFS_MAX_FEE_GWEI).");
      });
      const err = await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle], abi as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionTimeoutError);
      expect((err as TransactionTimeoutError).hash).toBe(h(1));
    });
  });

  it("B2 FIXED: one bundle with one raise is reported to onBundleSent once, with the hash that mined", async () => {
    await withFastPolicy(async () => {
      const r = rig((attempt, mined) => {
        const hash = h(attempt);
        if (attempt === 2) mined.add(hash); // the raise mines
        return hash;
      });
      const reported: Hex[] = [];
      const hashes = await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle], abi as never, {
        onBundleSent: (_b, _i, tx) => reported.push(tx),
      });
      expect(hashes).toEqual([h(2)]); // sendBundles itself is right
      expect(reported).toEqual([h(2)]);
    });
  });

  it("B3 bounded: never mined -> 1 + maxBumps sends at one nonce with strictly rising tips, then TransactionTimeoutError", async () => {
    await withFastPolicy(async () => {
      const r = rig((attempt) => h(attempt));
      const err = await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundle], abi as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransactionTimeoutError);
      expect(r.sends.length).toBe(1 + feeBumpPolicy.maxBumps);
      expect(new Set(r.sends.map((s) => s.nonce))).toEqual(new Set([4]));
      const tips = r.sends.slice(1).map((s) => s.tip!);
      for (let i = 1; i < tips.length; i++) expect(tips[i]! > tips[i - 1]!).toBe(true);
    });
  });
});
