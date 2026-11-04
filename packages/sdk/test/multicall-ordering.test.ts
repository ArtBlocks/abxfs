/**
 * `sendBundles` must give a caller a place to wait between dependent bundles.
 *
 * The draft publish path ships chunks, then files referencing them, then directories referencing
 * those. Each stage is its own transaction, and `sendBundles` SIMULATES a bundle before sending it
 * — so a bundle whose dependencies have not reached the simulating replica reverts before any
 * transaction exists. That is what a web upload of one image hit: `ChunkMissing` from a
 * `FileStore.multicall`, for a chunk already on chain.
 */
import { describe, expect, it, vi } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";

import { sendBundles, type Bundle } from "../src/multicall.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as const;

function bundle(n: number): Bundle {
  return {
    target: TARGET,
    estimatedGas: 100_000,
    calls: Array.from({ length: n }, (_, i) => ({
      target: TARGET,
      data: `0x${String(i).padStart(8, "0")}` as Hex,
      estimatedGas: 50_000,
      label: `call ${i}`,
    })),
  } as unknown as Bundle;
}

function fakeClients(log: string[]) {
  const publicClient = {
    simulateContract: async () => {
      log.push("simulate");
      return { request: {} };
    },
    waitForTransactionReceipt: async () => {
      log.push("receipt");
      return { status: "success" };
    },
  } as unknown as PublicClient;

  const walletClient = {
    account: { address: "0x0000000000000000000000000000000000000001" },
    writeContract: async () => {
      log.push("send");
      return "0xhash" as Hex;
    },
  } as unknown as WalletClient;

  return { publicClient, walletClient };
}

describe("sendBundles", () => {
  /**
   * The ordering that matters: the wait has to happen BEFORE the simulation, not before the send.
   * Simulating is where a missing dependency surfaces, so waiting after it would be too late.
   */
  it("awaits beforeEachBundle ahead of simulating", async () => {
    const log: string[] = [];
    const clients = fakeClients(log);

    await sendBundles(clients, [bundle(1), bundle(1)], [] as never, {
      beforeEachBundle: async () => {
        log.push("wait");
      },
    });

    expect(log).toEqual([
      "wait", "simulate", "send", "receipt",
      "wait", "simulate", "send", "receipt",
    ]);
  });

  it("runs without the hook", async () => {
    const log: string[] = [];
    const hashes = await sendBundles(fakeClients(log), [bundle(2)], [] as never);
    expect(hashes).toHaveLength(1);
    expect(log).toEqual(["simulate", "send", "receipt"]);
  });

  /**
   * The hook is per bundle, and the caller counts CALLS to know how far it has got — a bundle
   * carries many, so a bundle index is not an index into the work list. Getting that wrong waits
   * for the wrong prefix and lets the race through anyway.
   */
  it("reports each bundle's call count so a caller can track progress", async () => {
    const log: string[] = [];
    const sizes: number[] = [];

    await sendBundles(fakeClients(log), [bundle(3), bundle(2), bundle(4)], [] as never, {
      onBundleSent: (b) => sizes.push(b.calls.length),
    });

    expect(sizes).toEqual([3, 2, 4]);
    // Nine calls across three bundles: a caller indexing by bundle would have waited for 2.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(9);
  });

  it("awaits the receipt before the next bundle's wait runs", async () => {
    const log: string[] = [];
    const clients = fakeClients(log);
    const hook = vi.fn(async () => {
      log.push("wait");
    });

    await sendBundles(clients, [bundle(1), bundle(1)], [] as never, {
      beforeEachBundle: hook,
    });

    // The second wait must come after the first receipt, or it would be confirming nothing.
    expect(log.indexOf("receipt")).toBeLessThan(log.lastIndexOf("wait"));
    expect(hook).toHaveBeenCalledTimes(2);
  });
});
