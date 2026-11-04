/**
 * The publish plan must predict what publishing actually does.
 *
 * It did not. The planner modelled a flat 60,000 gas per chunk write and packed against 80% of the
 * block gas limit; the executor used real per-call estimates (35,000 + 250/byte — a 24 KB chunk is
 * ~6.18M) and packed against the `eth_estimateGas` ceiling. Thirteen chunks therefore reported
 * "780,000 gas, 1 transaction" for roughly 80M of work needing several transactions.
 *
 * The fix is structural rather than a corrected constant: the planner and the executor now build
 * the same calls and run the same packer, so agreement is by construction. These tests pin that,
 * because two code paths computing the same number is exactly what drifts.
 */
import { describe, expect, it } from "vitest";

import {
  ESTIMATE_GAS_CAP,
  estimateContentWrite,
  packBundles,
  resolveMaxBundleGas,
  type BundleableCall,
} from "../src/gas.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as const;
const MAX_CHUNK = 24_575;

function chunkCalls(count: number, bytesEach = MAX_CHUNK): BundleableCall[] {
  return Array.from({ length: count }, (_, i) => ({
    target: TARGET,
    data: `0x${i.toString(16).padStart(8, "0")}` as `0x${string}`,
    estimatedGas: estimateContentWrite(bytesEach),
    label: `ChunkStore.write[${i}]`,
  }));
}

describe("bundle packing reflects real cost", () => {
  /**
   * The exact case from the bug report: 13 chunks reported as one transaction. A max-size chunk
   * write costs ~6.18M, so 13 of them cannot share a bundle under any sane ceiling.
   */
  it("does not claim 13 max-size chunks fit in one transaction", () => {
    const maxBundleGas = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
    const bundles = packBundles(chunkCalls(13), { maxBundleGas });

    expect(bundles.length).toBeGreaterThan(1);
    for (const b of bundles) expect(b.estimatedGas).toBeLessThanOrEqual(maxBundleGas);
  });

  it("reports total gas within range of reality, not 100x under", () => {
    const bundles = packBundles(chunkCalls(13), {
      maxBundleGas: resolveMaxBundleGas({ bundleGasBudget: 12_000_000 }),
    });
    const total = bundles.reduce((n, b) => n + b.estimatedGas, 0);

    // The old model said 13 × 60,000 = 780,000. A max-size chunk alone costs more than that.
    expect(total).toBeGreaterThan(13 * estimateContentWrite(MAX_CHUNK) * 0.9);
    expect(total).toBeGreaterThan(50_000_000);
  });

  /** Every bundle must be simulatable, or it reverts before a transaction exists. */
  it("keeps every bundle under the eth_estimateGas ceiling", () => {
    const maxBundleGas = resolveMaxBundleGas({ bundleGasBudget: 24_000_000 });
    for (const count of [1, 2, 5, 13, 40]) {
      for (const b of packBundles(chunkCalls(count), { maxBundleGas })) {
        expect(b.estimatedGas).toBeLessThan(ESTIMATE_GAS_CAP);
      }
    }
  });

  /**
   * Chunks are content-defined, so they differ in size and therefore in cost. A model using one
   * representative figure for all of them is wrong in whichever direction the sizes skew.
   */
  it("prices chunks individually rather than using one figure for all", () => {
    const mixed: BundleableCall[] = [
      ...chunkCalls(1, MAX_CHUNK),
      ...chunkCalls(1, 512),
      ...chunkCalls(1, MAX_CHUNK),
    ];
    const big = estimateContentWrite(MAX_CHUNK);
    const small = estimateContentWrite(512);
    expect(big).toBeGreaterThan(small * 10);

    const total = packBundles(mixed, { maxBundleGas: ESTIMATE_GAS_CAP }).reduce(
      (n, b) => n + b.estimatedGas,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(big * 2 + small);
  });

  it("accounts for multicall overhead, not just the inner calls", () => {
    const calls = chunkCalls(3, 1_000);
    const [bundle] = packBundles(calls, { maxBundleGas: ESTIMATE_GAS_CAP });
    const inner = calls.reduce((n, c) => n + c.estimatedGas, 0);

    // Wrapping costs something; a plan that ignored it would under-report every bundle.
    expect(bundle!.estimatedGas).toBeGreaterThan(inner);
  });

  it("never emits an empty bundle", () => {
    expect(packBundles([], { maxBundleGas: 12_000_000 })).toEqual([]);
    for (const b of packBundles(chunkCalls(7), { maxBundleGas: 12_000_000 })) {
      expect(b.calls.length).toBeGreaterThan(0);
    }
  });

  /**
   * A single call larger than the ceiling still has to go somewhere. It gets its own bundle and
   * will fail loudly on simulation rather than being silently dropped from the plan.
   */
  it("gives an oversized call its own bundle rather than dropping it", () => {
    const huge: BundleableCall[] = [
      { target: TARGET, data: "0x00", estimatedGas: 50_000_000, label: "huge" },
      ...chunkCalls(1, 1_000),
    ];
    const bundles = packBundles(huge, { maxBundleGas: 12_000_000 });
    expect(bundles.length).toBe(2);
    expect(bundles[0]!.calls.length).toBe(1);
  });
});
