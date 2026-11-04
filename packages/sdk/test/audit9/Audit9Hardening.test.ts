/**
 * The smaller findings of the SDK audit, each with the case that failed before the fix:
 *
 *   - S-L1: `readDirectory` had no default entry cap; a hostile `entryCount` of 1e11 built a page list until Node ran
 *     out of memory.
 *   - S-I4: the draft executors ignored `blockGasLimit` when packing, while `planPublish` honoured it.
 *   - S-I5: a path given twice was planned and written twice, and the directory kept whichever came last.
 *   - K-I2: the u48 byte totals of chunk nodes were not bounded, so the SDK computed a CID for a file `FileStore`
 *     refuses.
 *   - K-I4: `FileStore` passes `ChunkStore` errors on, and they decoded as raw selectors.
 *   - A8: hook errors on a publish came out raw, and a wallet rejection read as a failure.
 *   - sendBundles: a bundle the node refused for gas failed outright; it is now halved and retried, bounded.
 */
import {
  BaseError,
  UserRejectedRequestError,
  decodeErrorResult,
  encodeErrorResult,
  toFunctionSelector,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { chunkStoreAbi, fileStoreAbi } from "../../src/abi.js";
import { iProjectHookAbi } from "../../src/abi-hook.js";
import { DEFAULT_MAX_ENTRIES, readDirectory } from "../../src/read.js";
import { LimitExceededError } from "../../src/limits.js";
import { executorPacking, applyNewProject } from "../../src/draft.js";
import { resolveBundleLimits } from "../../src/gas.js";
import { LEGACY_GAS_SCHEDULE } from "../../src/gas-schedule.js";
import { assertUniqueUploadPaths, planUploadOffline } from "../../src/plan.js";
import { uploadFiles } from "../../src/upload.js";
import { MAX_NODE_BYTES_TOTAL, packChunkTree } from "../../src/nodes.js";
import { fileStoreCallAbi } from "../../src/stores.js";
import { collectionWriteAbi, publishVersion } from "../../src/project.js";
import { isUserRejection } from "../../src/receipts.js";
import { MAX_BUNDLE_SPLIT_DEPTH, isGasRefusal, sendBundles } from "../../src/multicall.js";
import type { Bundle } from "../../src/gas.js";
import type { AbxfsCid, ContractAddresses } from "../../src/types.js";

const ADDRS = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  fileStore: "0x00000000000000000000000000000000000000f1",
  directoryStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
} as ContractAddresses;
const BACKENDS = { raw: ADDRS.sstore2Backend, fastLz: ADDRS.fastLzBackend };
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;

describe("S-L1: a directory's claimed size is checked before any page is planned", () => {
  it("a hostile entryCount of 1e11 is refused from the count alone, with the default cap", async () => {
    const calls: string[] = [];
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        calls.push(functionName);
        if (functionName === "entryCount") return 100_000_000_000n;
        throw new Error("no page may be read");
      },
    } as unknown as PublicClient;
    const err = await readDirectory(client, ADDRS, id(1)).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(calls).toEqual(["entryCount"]);
    expect(DEFAULT_MAX_ENTRIES).toBe(100_000);
  });

  it("a caller can still raise the cap explicitly", async () => {
    const client = {
      async readContract({ functionName, args }: { functionName: string; args: [AbxfsCid, bigint, bigint] }) {
        if (functionName === "entryCount") return 3n;
        return ["a", "b", "c"].slice(Number(args[1]), Number(args[2])).map((name) => ({ name, cid: id(2), isDirectory: false }));
      },
    } as unknown as PublicClient;
    expect((await readDirectory(client, ADDRS, id(1), { maxEntries: 3 })).entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
    await expect(readDirectory(client, ADDRS, id(1), { maxEntries: 2 })).rejects.toBeInstanceOf(LimitExceededError);
  });
});

describe("S-I4: the executors pack under the same limits planPublish plans with", () => {
  it("a known block gas limit and safety factor bound every bundle, and reach the plan", () => {
    const opts = { blockGasLimit: 10_000_000, bundleGasSafetyFactor: 0.5, maxBundleGas: 12_000_000 };
    const p = executorPacking(opts, LEGACY_GAS_SCHEDULE);
    expect(p.limits.maxBundleGas).toBe(5_000_000);
    expect(p.limits).toEqual(resolveBundleLimits({ schedule: LEGACY_GAS_SCHEDULE, bundleGasBudget: 12_000_000, blockGasLimit: 10_000_000, safetyFactor: 0.5 }));
    expect(p.planOptions).toMatchObject({ blockGasLimit: 10_000_000n, safetyFactor: 0.5, maxBundleGas: 12_000_000, gasSchedule: LEGACY_GAS_SCHEDULE });
    expect(p.fit).toMatchObject({ blockGasLimit: 10_000_000, safetyFactor: 0.5 });
    // Without one, the per-transaction cap alone.
    expect(executorPacking({}, LEGACY_GAS_SCHEDULE).limits.maxBundleGas).toBe(resolveBundleLimits({ bundleGasBudget: 12_000_000 }).maxBundleGas);
  });
});

describe("S-I5: a path given twice is refused before anything is planned or written", () => {
  const files = [
    { path: "a.txt", bytes: new TextEncoder().encode("first"), mimeType: "text/plain" },
    { path: "a.txt", bytes: new TextEncoder().encode("second"), mimeType: "text/plain" },
  ];
  it("offline, in the draft pipeline, and in uploadFiles, with no write", async () => {
    expect(() => assertUniqueUploadPaths(["x", "y", "x"])).toThrow(/"x" is in this upload twice/);
    await expect(planUploadOffline(files, { backends: BACKENDS })).rejects.toThrow(/twice/);
    await expect(applyNewProject({} as PublicClient, ADDRS, files)).rejects.toThrow(/twice/);
    const writeContract = vi.fn();
    await expect(uploadFiles({ publicClient: {} as PublicClient, walletClient: { writeContract } as unknown as WalletClient }, ADDRS, files)).rejects.toThrow(/twice/);
    expect(writeContract).not.toHaveBeenCalled();
  });
});

describe("K-I2: chunk-node byte totals are bounded as FileStore bounds them", () => {
  it("a leaf whose total passes 2^48 - 1 is refused", () => {
    expect(() => packChunkTree([id(1), id(2)], [MAX_NODE_BYTES_TOTAL, 1])).toThrow(/FileStore refuses it/);
    expect(() => packChunkTree([id(1), id(2)], [MAX_NODE_BYTES_TOTAL - 1, 1])).not.toThrow();
  });
  it("a branch whose running total passes 2^48 - 1 is refused, though every leaf fits", () => {
    const n = 1_100;
    const ids = Array.from({ length: n }, (_, i) => id(i + 1));
    // 2^38 a chunk: a leaf of at most 512 is at most 2^47, but 1,100 of them pass 2^48.
    expect(() => packChunkTree(ids, ids.map(() => 2 ** 38))).toThrow(/FileStore refuses it/);
    expect(() => packChunkTree(ids, ids.map(() => 2 ** 37))).not.toThrow();
  });
});

describe("K-I4: ChunkStore errors a FileStore call passes on are decoded", () => {
  it("the call ABI holds them; the mirror does not", () => {
    for (const name of ["ChunkNotFound", "RetrieveFailed", "DataMismatch"]) {
      expect(fileStoreAbi.some((e) => e.type === "error" && e.name === name)).toBe(false);
      expect(fileStoreCallAbi.some((e) => e.type === "error" && e.name === name)).toBe(true);
    }
    const data = encodeErrorResult({ abi: chunkStoreAbi, errorName: "ChunkNotFound", args: [id(9)] });
    expect(decodeErrorResult({ abi: fileStoreCallAbi, data }).errorName).toBe("ChunkNotFound");
  });
});

describe("A8: honest errors", () => {
  it("publishVersion decodes the hook's errors (RootNotFound, RootKindLocked, SameRoot)", async () => {
    for (const name of ["RootNotFound", "RootKindLocked", "SameRoot"]) {
      const item = iProjectHookAbi.find((e) => e.type === "error" && e.name === name)!;
      const selector = toFunctionSelector(item as never);
      expect(collectionWriteAbi.some((e) => e.type === "error" && e.name === name), name).toBe(true);
      expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
    }
    const writeContract = vi.fn(async () => "0x" as Hex);
    const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract } as unknown as WalletClient;
    await publishVersion(wallet, { collection: "0x00000000000000000000000000000000000000a1", hook: "0x00000000000000000000000000000000000000a2" }, 1n, id(1));
    const abi = (writeContract.mock.calls[0] as unknown as [{ abi: readonly { type: string; name?: string }[] }])[0].abi;
    expect(abi.some((e) => e.type === "error" && e.name === "SameRoot")).toBe(true);
  });

  it("a wallet rejection is recognised by type or EIP-1193 code, wherever it sits in the cause chain, never by message", () => {
    expect(isUserRejection(new BaseError("wrapped", { cause: new UserRejectedRequestError(new Error("no")) }))).toBe(true);
    expect(isUserRejection({ message: "x", cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error("user rejected the request"))).toBe(false);
    expect(isUserRejection(new Error("execution reverted"))).toBe(false);
  });
});

describe("sendBundles: a bundle the node refuses for gas is halved and retried, bounded", () => {
  const T = "0x00000000000000000000000000000000000000aa" as const;
  const abi = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "r", type: "bytes[]" }] }] as const;
  const bundleOf = (n: number): Bundle => ({
    target: T,
    calls: Array.from({ length: n }, (_, i) => ({ target: T, data: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hex, estimatedGas: 1_000_000 })),
    estimatedGas: n * 1_005_000 + 5_000,
  });
  const outOfGas = () => new BaseError("out of gas", { cause: Object.assign(new Error("execution reverted"), { data: "0x" }) });

  function rig(fail: (calls: number) => Error | null) {
    const sent: string[][] = [];
    const publicClient = {
      async simulateContract(a: { args: [Hex[]]; account: unknown }) {
        const e = fail(a.args[0].length);
        if (e) throw e;
        return { request: { args: a.args } };
      },
      async getTransactionCount() {
        return 0;
      },
      async getTransactionReceipt() {
        return { status: "success" };
      },
      async waitForTransactionReceipt() {
        return { status: "success" };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { type: "json-rpc", address: "0x00000000000000000000000000000000000000ee" },
      async writeContract(req: { args: [Hex[]] }) {
        sent.push(req.args[0]);
        return `0x${String(sent.length).padStart(64, "0")}` as Hex;
      },
    } as unknown as WalletClient;
    return { publicClient, walletClient, sent };
  }

  it("a refused bundle of 8 goes as halves, in order, every call once", async () => {
    const r = rig((n) => (n > 2 ? outOfGas() : null));
    const reported: number[] = [];
    await sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundleOf(8)], abi as never, {
      onBundleSent: (b) => reported.push(b.calls.length),
    });
    expect(r.sent.map((s) => s.length)).toEqual([2, 2, 2, 2]);
    expect(r.sent.flat()).toEqual(bundleOf(8).calls.map((c) => c.data));
    expect(reported).toEqual([2, 2, 2, 2]);
  });

  it("splitting is bounded, and a decoded revert or a person's refusal is never split", async () => {
    const stuck = rig(() => outOfGas());
    await expect(sendBundles({ publicClient: stuck.publicClient, walletClient: stuck.walletClient }, [bundleOf(64)], abi as never)).rejects.toThrow(/out of gas/);
    expect(stuck.sent).toHaveLength(0);
    expect(MAX_BUNDLE_SPLIT_DEPTH).toBe(3);

    const reverted = new BaseError("reverted", { cause: Object.assign(new Error("NodeMissing"), { data: "0x30786386" + "00".repeat(32) }) });
    expect(isGasRefusal(reverted)).toBe(false);
    let simulations = 0;
    const r = rig(() => (simulations++, reverted));
    await expect(sendBundles({ publicClient: r.publicClient, walletClient: r.walletClient }, [bundleOf(8)], abi as never)).rejects.toBe(reverted);
    expect(simulations).toBe(1);
    expect(isGasRefusal(new BaseError("no", { cause: new UserRejectedRequestError(new Error("no")) }))).toBe(false);
    expect(isGasRefusal(outOfGas())).toBe(true);
  });
});
