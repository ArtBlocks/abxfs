import { describe, expect, it } from "vitest";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import type { AbxfsCid } from "../../src/types.js";
import { planUploadOffline } from "../../src/plan.js";
import { packEntryTree, packChunkTree } from "../../src/nodes.js";
import { estimateEntryLeaf, estimateChunkLeaf, estimateBranch, NODE_GAS } from "../../src/node-gas.js";
import { packBundles, resolveMaxBundleGas, resolveSingleCallCeiling, ESTIMATE_GAS_CAP } from "../../src/gas.js";

const BACKENDS = { raw: "0x00000000000000000000000000000000000000b1" } as const;
const enc = new TextEncoder();
const h = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as AbxfsCid;

describe("audit7 write", () => {
  // v1 and v2 refused a zero-length file; ABX FS has the empty file (root zero), so it plans like any other.
  it("zero-length file plans as the empty file", async () => {
    await autoRegisterNodeCodecs();
    const p = await planUploadOffline([{ path: "empty.txt", bytes: new Uint8Array(0), mimeType: "text/plain" }], { backends: BACKENDS });
    expect(p.files[0]!.chunkIds).toEqual([]);
    expect(p.files[0]!.tree.nodes).toEqual([]);
  });
  it("same content under 500 names plans with one file CID", async () => {
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `d/f${i}.txt`, bytes: enc.encode("same"), mimeType: "text/plain" }));
    const p = await planUploadOffline(files, { backends: BACKENDS });
    expect(new Set(p.files.map((f) => f.cid)).size).toBe(1);
  });
  it("worst-case node estimates vs planned bundle ceiling", () => {
    const e255 = Array.from({ length: 200 }, (_, i) => ({ name: String(i).padStart(3, "0").padEnd(255, "x"), cid: h(i + 1), isDirectory: true }));
    const t = packEntryTree(e255);
    const max = Math.max(...t.nodes.map((n) => n.estimatedGas));
    const maxBundle = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
    const single = resolveSingleCallCeiling();
    console.log("255B-name leaf est", estimateEntryLeaf(84, 84 * 255), "max node est", max, "bundle ceiling", maxBundle, "single", single, "cap", ESTIMATE_GAS_CAP);
    console.log("750 leaf", estimateChunkLeaf(750), "branch128", estimateBranch(128));
    // a node > maxBundleGas rides alone: allowed up to single ceiling
    const b = packBundles(t.nodes.map((n) => ({ target: "0x00000000000000000000000000000000000000aa", data: "0x", estimatedGas: n.estimatedGas })), { maxBundleGas: maxBundle });
    for (const x of b) if (x.calls.length > 1) expect(x.estimatedGas).toBeLessThanOrEqual(maxBundle);
    expect(max).toBeLessThan(single);
  });
  it("751 chunks whose every hash is a boundary candidate pack into minimum-size leaves under one branch", () => {
    // These hashes have a zero top word, so every chunk past the 32-record minimum ends a leaf.
    const t = packChunkTree(Array.from({ length: 751 }, (_, i) => h(i + 1)), Array.from({ length: 751 }, () => 100));
    expect(t.rootLevel).toBe(1);
    expect(t.nodes.filter((n) => n.level === 0).map((n) => n.count)).toEqual([...Array(23).fill(32), 15]);
  });
});
