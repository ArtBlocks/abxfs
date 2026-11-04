/**
 * Tests for the gas-aware bundle packer used by the SDK to assemble `Multicallable.multicall(bytes[])` transactions.
 * The packer is a pure function over estimated gas costs — these tests exercise its first-fit grouping,
 * target-boundary splitting, and budget-resolution helper. The schedule-specific limits and the calibration against
 * measured gas are in `gas-schedule.test.ts`.
 */
import { createDirectoryGas, createFileGas, estimateBranch, estimateChunkLeaf, estimateEntryLeaf } from "../src/node-gas.js";
import { describe, expect, it } from "vitest";

import {
  ESTIMATE_GAS_CAP,
  GAS_ESTIMATES,
  estimateContentWrite,
  estimateDirectoryEntries,
  estimateFileCreate,
  estimateProjectOp,
  packBundles,
  resolveMaxBundleGas,
  type BundleableCall,
} from "../src/gas.js";
import type { Address, Hex } from "viem";

const STORE_A = "0x0000000000000000000000000000000000000A11" as Address;
const STORE_B = "0x0000000000000000000000000000000000000B22" as Address;

function call(target: Address, gas: number, label?: string): BundleableCall {
  return { target, data: "0x" as Hex, estimatedGas: gas, label };
}

describe("packBundles", () => {
  it("returns an empty list when given no calls", () => {
    expect(packBundles([], { maxBundleGas: 30_000_000 })).toEqual([]);
  });

  it("packs calls of the same target into one bundle when they fit", () => {
    const calls = [call(STORE_A, 100_000, "a1"), call(STORE_A, 100_000, "a2"), call(STORE_A, 100_000, "a3")];
    const bundles = packBundles(calls, { maxBundleGas: 30_000_000 });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.calls).toHaveLength(3);
    expect(bundles[0]!.target).toBe(STORE_A);
    // Estimate = base + 3 dispatches + 3 inner calls
    expect(bundles[0]!.estimatedGas).toBe(
      GAS_ESTIMATES.multicallBase + 3 * GAS_ESTIMATES.multicallInnerDispatch + 300_000,
    );
  });

  it("forces a new bundle when the next call would exceed maxBundleGas", () => {
    const calls = [call(STORE_A, 600_000), call(STORE_A, 600_000), call(STORE_A, 600_000)];
    // Budget that fits exactly two ~605k-est calls but not three.
    const bundles = packBundles(calls, { maxBundleGas: 1_300_000 });
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.calls).toHaveLength(2);
    expect(bundles[1]!.calls).toHaveLength(1);
  });

  it("splits at every target boundary even when budget would allow merging", () => {
    const calls = [call(STORE_A, 50_000), call(STORE_B, 50_000), call(STORE_A, 50_000)];
    const bundles = packBundles(calls, { maxBundleGas: 30_000_000 });
    // A | B | A — three bundles because multicall is per-store delegatecall-to-self.
    expect(bundles).toHaveLength(3);
    expect(bundles.map((b) => b.target)).toEqual([STORE_A, STORE_B, STORE_A]);
    for (const b of bundles) expect(b.calls).toHaveLength(1);
  });

  it("emits a single-call bundle even when the call's own estimate exceeds the budget", () => {
    const calls = [call(STORE_A, 50_000_000, "huge")];
    const bundles = packBundles(calls, { maxBundleGas: 30_000_000 });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.calls).toHaveLength(1);
    // Caller must surface an OOG-risk warning; the packer doesn't drop the op silently.
  });

  it("preserves call order within a target", () => {
    const calls = [
      call(STORE_A, 100_000, "1"),
      call(STORE_A, 100_000, "2"),
      call(STORE_A, 100_000, "3"),
      call(STORE_A, 100_000, "4"),
    ];
    const bundles = packBundles(calls, { maxBundleGas: 30_000_000 });
    expect(bundles[0]!.calls.map((c) => c.label)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("resolveMaxBundleGas", () => {
  /**
   * These two used to assert that a 24M budget came back as 24M. That encoded the bug: 24M is
   * above the 2^24 ceiling `eth_estimateGas` enforces, so bundles packed to it failed at
   * simulation. The ceiling now applies whether or not a block limit is supplied.
   */
  it("applies the simulate ceiling even with no block limit supplied", () => {
    const resolved = resolveMaxBundleGas({ bundleGasBudget: 24_000_000 });
    expect(resolved).toBeLessThan(ESTIMATE_GAS_CAP);
  });

  it("takes whichever of the block limit and the simulate ceiling is tighter", () => {
    // 30M block * 0.8 = 24M — still above the simulate ceiling, so the ceiling wins.
    const wide = resolveMaxBundleGas({
      bundleGasBudget: 30_000_000,
      blockGasLimit: 30_000_000n,
      safetyFactor: 0.8,
    });
    expect(wide).toBeLessThan(ESTIMATE_GAS_CAP);

    // 10M block * 0.8 = 8M — tighter than the ceiling, so the block limit wins.
    expect(
      resolveMaxBundleGas({
        bundleGasBudget: 30_000_000,
        blockGasLimit: 10_000_000n,
        safetyFactor: 0.8,
      }),
    ).toBe(8_000_000);
  });

  it("uses the user budget when it is below the safe block headroom", () => {
    expect(
      resolveMaxBundleGas({
        bundleGasBudget: 5_000_000,
        blockGasLimit: 30_000_000n,
        safetyFactor: 0.8,
      }),
    ).toBe(5_000_000);
  });
});

describe("estimators", () => {
  it("estimateContentWrite scales with chunk size", () => {
    const small = estimateContentWrite(100);
    const big = estimateContentWrite(10_000);
    expect(big).toBeGreaterThan(small);
  });

  it("estimateContentWrite of an existing chunk is the dedup check plus its calldata, and creates no state", () => {
    expect(estimateContentWrite(99_999, { dedup: true })).toBe(GAS_ESTIMATES.contentWriteDedup + 99_999 * GAS_ESTIMATES.contentWritePerByte);
  });

  it("estimateFileCreate is the whole file: every node plus createFile, growing with chunkCount", () => {
    const create = createFileGas();
    const createTotal = create.execution + create.state;
    // One leaf plus createFile for one chunk; the empty file has no node at all, only createFile.
    expect(estimateFileCreate(1)).toBe(estimateChunkLeaf(1) + createTotal);
    expect(estimateFileCreate(0)).toBe(createTotal);
    // 751 chunks, before the hashes exist: at the expected leaf size (160) that is 5 leaves, each paying a leaf's fixed
    // part, all 751 records, and one 5-child file branch over them.
    const perLeaf = estimateChunkLeaf(0);
    const perHash = estimateChunkLeaf(1) - perLeaf;
    expect(estimateFileCreate(751)).toBe(5 * perLeaf + 751 * perHash + estimateBranch(5, true) + createTotal);
    expect(estimateFileCreate(10_000)).toBeGreaterThan(estimateFileCreate(1_000));
  });

  it("estimateDirectoryEntries is name-length aware, and has no per-transaction cliff", () => {
    const names = (len: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `${String(i).padStart(len, "0")}`.slice(-len).padStart(len, "x"), isDirectory: false }));
    // Linear in name BYTES (no jump at 32 as in v1): a 255-byte name costs more than a 9-byte one.
    expect(estimateDirectoryEntries(names(255, 50))).toBeGreaterThan(estimateDirectoryEntries(names(9, 50)));
    // A directory far larger than v1 could hold is just more nodes.
    expect(estimateDirectoryEntries(names(9, 5_000))).toBeGreaterThan(estimateDirectoryEntries(names(9, 500)));
    const dir = createDirectoryGas();
    expect(estimateDirectoryEntries([{ name: "a", isDirectory: false }])).toBe(estimateEntryLeaf(1, 1) + dir.execution + dir.state);
  });

  it("estimateProjectOp returns a fixed value per op", () => {
    expect(estimateProjectOp("createProject")).toBe(GAS_ESTIMATES.projectCreate);
    expect(estimateProjectOp("publishVersion")).toBe(GAS_ESTIMATES.projectPublishVersion);
    expect(estimateProjectOp("setName")).toBe(GAS_ESTIMATES.projectSetName);
    expect(estimateProjectOp("setView")).toBe(GAS_ESTIMATES.projectSetView);
    expect(estimateProjectOp("setTag")).toBe(GAS_ESTIMATES.projectSetTag);
    expect(estimateProjectOp("removeTag")).toBe(GAS_ESTIMATES.projectRemoveTag);
  });

  it("the project-param estimates cover the fork measurements against real ABX (GasProfileFork.t.sol)", () => {
    // Delta audit L4, Base Sepolia fork: the longest name, view URL and tag, and a tag removal.
    expect(GAS_ESTIMATES.projectSetName).toBeGreaterThanOrEqual(258_000); // setName, 128 bytes
    expect(GAS_ESTIMATES.projectSetView).toBeGreaterThanOrEqual(426_000); // setView, 512 bytes
    expect(GAS_ESTIMATES.projectSetTag).toBeGreaterThanOrEqual(191_000); // setTag, 64 bytes
    expect(GAS_ESTIMATES.projectRemoveTag).toBeGreaterThanOrEqual(68_500); // removeTag, 64 bytes
  });
});

describe("the eth_estimateGas ceiling", () => {
  /**
   * The constraint that actually bounds bundle size, and the one the original budget missed.
   *
   * Both public Base Sepolia endpoints clamp `eth_estimateGas` at exactly 2^24 while the chain's
   * block gas limit is 1.2 billion — the two numbers are unrelated. A bundle needing more than the
   * cap does not estimate higher; the estimate FAILS, so the bundle reverts before a transaction
   * exists. A browser upload of one image hit this: five ~24 KB chunk writes in one multicall.
   */
  it("caps a bundle below the simulate ceiling even when the caller asks for more", () => {
    const resolved = resolveMaxBundleGas({ bundleGasBudget: 24_000_000 });
    expect(resolved).toBeLessThan(ESTIMATE_GAS_CAP);
    // And with real margin, not packed to the line — an op costing more than predicted must still fit.
    expect(resolved).toBeLessThanOrEqual(ESTIMATE_GAS_CAP * 0.8);
  });

  /**
   * A caller cannot opt out by passing a bigger number: the cap belongs to the node being asked,
   * not to the request.
   */
  it("is not escapable by raising the budget", () => {
    for (const budget of [24_000_000, 100_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(resolveMaxBundleGas({ bundleGasBudget: budget })).toBeLessThan(ESTIMATE_GAS_CAP);
    }
  });

  /** A budget already under the ceiling is respected as-is — the cap is a ceiling, not a target. */
  it("leaves a smaller budget alone", () => {
    expect(resolveMaxBundleGas({ bundleGasBudget: 1_000_000 })).toBe(1_000_000);
  });

  /**
   * A low block gas limit still wins when it is the tighter of the two. Both constraints apply;
   * neither replaces the other.
   */
  it("still honours a block gas limit tighter than the ceiling", () => {
    expect(resolveMaxBundleGas({ bundleGasBudget: 24_000_000, blockGasLimit: 5_000_000 })).toBe(
      4_000_000,
    );
  });

  /** A huge block limit must not lift the bundle above what a node will simulate. */
  it("ignores a block gas limit far above the ceiling", () => {
    const resolved = resolveMaxBundleGas({
      bundleGasBudget: 24_000_000,
      blockGasLimit: 1_200_000_000,
    });
    expect(resolved).toBeLessThan(ESTIMATE_GAS_CAP);
  });

  /**
   * Sizing sanity: a max-size chunk write measured 5,714,957 gas on Base Sepolia, so the default
   * budget must fit at least two per bundle — otherwise bundling buys nothing over one tx per chunk.
   */
  it("fits at least two max-size chunk writes per bundle", () => {
    const perMaxChunk = estimateContentWrite(24_575);
    const resolved = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
    expect(Math.floor(resolved / perMaxChunk)).toBeGreaterThanOrEqual(1);
    expect(resolved).toBeGreaterThan(perMaxChunk);
  });
});
