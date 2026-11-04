import { describe, expect, it } from "vitest";
import { estimatePublishCalls, RPC_PROXY_CALLS_PER_MINUTE } from "../../src/call-budget.js";
import { estimateContentWrite, estimateFileCreate, estimateDirectoryEntries, packBundles, resolveMaxBundleGas } from "../../src/gas.js";

const T = "0x0000000000000000000000000000000000000001" as const;
const T2 = "0x0000000000000000000000000000000000000002" as const;
const T3 = "0x0000000000000000000000000000000000000003" as const;
const mk = (n: number, target: `0x${string}`, gas: number) => Array.from({ length: n }, () => ({ target, data: "0x" as const, estimatedGas: gas }));

describe("Audit5 call volume of a 5000 tiny-file publish (1 chunk per file, ~1000 dirs of 5)", () => {
  it("prints the estimate vs the proxy limit", () => {
    const max = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
    const chunks = packBundles(mk(5000, T, estimateContentWrite(40)), { maxBundleGas: max });
    const files = packBundles(mk(5000, T2, estimateFileCreate(1)), { maxBundleGas: max });
    const dirs = packBundles(mk(1001, T3, estimateDirectoryEntries(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: false })))), { maxBundleGas: max });
    const bundles = [...chunks, ...files, ...dirs].map((b) => ({ kind: "x", calls: b.calls.length, estGas: BigInt(b.estimatedGas) }));
    const est = estimatePublishCalls(
      { chunksToWrite: new Array(5000), filesToCreate: new Array(5000), dirsToCreate: new Array(1001), bundles: bundles as never, setTag: false, setName: true } as never,
      { chunks: 5000, files: 5000, dirs: 1001 },
    );
    console.log("bundles", chunks.length, files.length, dirs.length, "estimate", JSON.stringify(est), "limit", RPC_PROXY_CALLS_PER_MINUTE);
    expect(est.minutesAtFullBudget).toBeGreaterThan(1);
  });
});
