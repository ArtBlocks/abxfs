/**
 * `sendBundles` must give a caller a place to wait between dependent bundles.
 *
 * The draft publish path ships chunks, then files referencing them, then directories referencing
 * those. Each stage is its own transaction, and `sendBundles` SIMULATES a bundle before sending it
 * — so a bundle whose dependencies have not reached the simulating replica reverts before any
 * transaction exists. That is what a web upload of one image hit: `ChunkMissing` from a
 * `FileStore.multicall`, for a chunk already on chain.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex, PublicClient, WalletClient } from "viem";

import { sendBundles, type Bundle } from "../src/multicall.js";
import { pinnedReadPolicy } from "../src/snapshot.js";
const savedReadPolicy = { ...pinnedReadPolicy };
afterEach(() => { Object.assign(pinnedReadPolicy, savedReadPolicy); });

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


describe("confirmed-block content simulation", () => {
  it("carries successful receipt blocks into later bundles and strips the read block before each send", async () => {
    const clients = fakeClients([]);
    const blocks: Array<bigint | undefined> = [];
    const estimateBlocks: Array<bigint | undefined> = [];
    clients.publicClient.estimateContractGas = vi.fn(async (args: { blockNumber?: bigint }) => {
      estimateBlocks.push(args.blockNumber); return 123456n;
    }) as never;
    let receiptBlock = 12n;
    clients.publicClient.simulateContract = vi.fn(async (args: { blockNumber?: bigint }) => {
      blocks.push(args.blockNumber);
      return { request: { blockNumber: args.blockNumber } };
    }) as never;
    clients.publicClient.waitForTransactionReceipt = vi.fn(async () => ({ status: "success", blockNumber: receiptBlock++ })) as never;
    const write = vi.fn(async (args: object) => {
      expect(args).not.toHaveProperty("blockNumber"); expect(args).toHaveProperty("gas", 123456n); return "0x01";
    });
    clients.walletClient.writeContract = write as never;
    const confirmed: bigint[] = [];
    await sendBundles(clients, [bundle(1), bundle(1)], [] as never, { simulationBlockNumber: 10n, onBundleConfirmed: (block) => confirmed.push(block) });
    expect(blocks).toEqual([10n, 12n]); expect(estimateBlocks).toEqual([10n, 12n]); expect(confirmed).toEqual([12n, 13n]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("waits a bounded number of readonly attempts for an unavailable confirmed block", async () => {
    Object.assign(pinnedReadPolicy, { attempts: 3, delayMs: 0 });
    const clients = fakeClients([]);
    const simulate = vi.fn(async () => { throw Object.assign(new Error("header not found"), { code: -32000 }); });
    const write = vi.fn();
    clients.publicClient.simulateContract = simulate as never;
    clients.walletClient.writeContract = write as never;
    await expect(sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n })).rejects.toThrow(/header not found/);
    expect(simulate).toHaveBeenCalledTimes(3); expect(write).not.toHaveBeenCalled();
  });

  it("retries only the readonly simulation before one successful broadcast when a replica catches up", async () => {
    Object.assign(pinnedReadPolicy, { attempts: 3, delayMs: 0 });
    const clients = fakeClients([]);
    const simulate = vi.fn().mockRejectedValueOnce(Object.assign(new Error("header not found"), { code: -32000 }))
      .mockResolvedValue({ request: { blockNumber: 10n } });
    const write = vi.fn(async () => "0x01");
    clients.publicClient.simulateContract = simulate as never;
    clients.walletClient.writeContract = write as never;
    await sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n });
    expect(simulate).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(1);
  });

  it("bounds estimate retries at the same block and sends only once after the block becomes available", async () => {
    Object.assign(pinnedReadPolicy, { attempts: 3, delayMs: 0 });
    const clients = fakeClients([]);
    const estimate = vi.fn().mockRejectedValueOnce(Object.assign(new Error("header not found"), { code: -32000 })).mockResolvedValue(54321n);
    const write = vi.fn(async (args: object) => { expect(args).toHaveProperty("gas", 54321n); return "0x01"; });
    clients.publicClient.estimateContractGas = estimate as never;
    clients.walletClient.writeContract = write as never;
    await sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n });
    expect(estimate).toHaveBeenCalledTimes(2);
    for (const call of estimate.mock.calls) expect(call[0]).toHaveProperty("blockNumber", 10n);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not retry a real reverted gas estimate or broadcast it", async () => {
    const clients = fakeClients([]);
    const error = Object.assign(new Error("execution reverted: CidNotFound"), { code: 3 });
    const estimate = vi.fn().mockRejectedValue(error); const write = vi.fn();
    clients.publicClient.estimateContractGas = estimate as never; clients.walletClient.writeContract = write as never;
    await expect(sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n })).rejects.toBe(error);
    expect(estimate).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("execution reverted: CidNotFound"), { code: 3 }),
    Object.assign(new Error("request timed out"), { code: -32603 }),
  ])("throws real reverts or transport failures without retry or broadcast: %s", async (error) => {
    const clients = fakeClients([]);
    const simulate = vi.fn().mockRejectedValue(error); const write = vi.fn();
    clients.publicClient.simulateContract = simulate as never; clients.walletClient.writeContract = write as never;
    await expect(sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n })).rejects.toBe(error);
    expect(simulate).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  });

  it("never retries a broadcast whose receipt reverted, or propagates its block as confirmed", async () => {
    const clients = fakeClients([]);
    const simulate = vi.fn(async () => ({ request: {} })); const write = vi.fn(async () => "0x01"); const confirmed = vi.fn();
    clients.publicClient.simulateContract = simulate as never; clients.walletClient.writeContract = write as never;
    clients.publicClient.waitForTransactionReceipt = vi.fn(async () => ({ status: "reverted", blockNumber: 12n })) as never;
    await expect(sendBundles(clients, [bundle(1)], [] as never, { simulationBlockNumber: 10n, onBundleConfirmed: confirmed })).rejects.toThrow(/reverted on chain/);
    expect(simulate).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1); expect(confirmed).not.toHaveBeenCalled();
  });
});
