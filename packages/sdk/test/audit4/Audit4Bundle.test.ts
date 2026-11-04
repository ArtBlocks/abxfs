/**
 * Audit 4 (MED-2), inverted: the per-chunk gas model predicted ~46k for a tiny chunk that really costs ~127k,
 * so 260 tiny chunks were packed into ONE bundle (est. 12M, actual 33M), past the node's simulation ceiling, and
 * reverted `DeploymentFailed` before a transaction existed. The model must stay an upper envelope of what a
 * `ChunkStore.write` really costs (a record, two backend calls and the write-time read-back).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeFunctionData, toHex } from "viem";

import { chunkStoreAbi } from "../../src/abi.js";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { uploadContent } from "../../src/draft.js";
import { estimateContentWrite, ESTIMATE_GAS_CAP, MAX_BUNDLE_CALLS, packBundles, resolveMaxBundleGas } from "../../src/gas.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => {
  await autoRegisterNodeCodecs();
  h = await startAnvilWithAbxfs({ deployCompanion: true });
}, 120_000);
afterAll(async () => h?.stop());

const enc = new TextEncoder();
const mc = { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ type: "bytes[]" }] } as const;

it("a tiny chunk's estimate is no longer 2.8x too low", () => {
  expect(estimateContentWrite(15)).toBeGreaterThanOrEqual(127_000);
  expect(estimateContentWrite(24_575)).toBeGreaterThanOrEqual(5_480_000); // measured 5.47M before the write-time read-back
  expect(estimateContentWrite(24_575)).toBeLessThan(7_000_000); // and not wildly high either
});

it("no content bundle plans more calls than MAX_BUNDLE_CALLS or more gas than the estimate ceiling", async () => {
  const fs = Array.from({ length: 300 }, (_, i) => ({ path: `d${i % 60}/f${i}.txt`, bytes: enc.encode(`f ${i} ${Math.random()}`), mimeType: "text/plain" }));
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const { plan } = await c.planNewProject(fs, { opts: {} });
  const ceiling = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
  expect(plan.bundles.length).toBeGreaterThan(3);
  for (const b of plan.bundles) {
    expect(b.calls, b.kind).toBeLessThanOrEqual(MAX_BUNDLE_CALLS);
    expect(Number(b.estGas), b.kind).toBeLessThanOrEqual(ceiling);
  }
  // 300 tiny chunks no longer fit one bundle
  expect(plan.bundles.filter((b) => b.kind === "content").length).toBeGreaterThanOrEqual(3);
});

it("every planned content bundle really simulates under the node's ceiling, and the estimate covers the measured gas", async () => {
  const fs = Array.from({ length: 260 }, (_, i) => ({ path: `f${i}.txt`, bytes: enc.encode(`tiny ${i} ${Math.random()}`), mimeType: "text/plain" }));
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const { plan } = await c.planNewProject(fs, { opts: {} });
  const ceiling = resolveMaxBundleGas({ bundleGasBudget: 12_000_000 });
  const calls = plan.chunksToWrite.map((x) => ({
    target: h.addresses.chunkStore,
    data: encodeFunctionData({ abi: chunkStoreAbi, functionName: "write", args: [x.backend, toHex(x.input), x.dataHash, x.size] }),
    estimatedGas: estimateContentWrite(x.input.length, { dataLength: x.size }),
  }));
  for (const b of packBundles(calls, { maxBundleGas: ceiling })) {
    const actual = Number(
      await h.publicClient.estimateContractGas({ address: h.addresses.chunkStore, abi: [...(chunkStoreAbi as never as readonly object[]), mc] as never, functionName: "multicall", args: [b.calls.map((x) => x.data)], account: h.account } as never),
    );
    expect(actual).toBeLessThan(ESTIMATE_GAS_CAP);
    expect(b.estimatedGas).toBeGreaterThanOrEqual(actual * 0.97);
  }
});

it("end to end: 300 tiny files publish their content with no DeploymentFailed", async () => {
  const fs = Array.from({ length: 300 }, (_, i) => ({ path: `d${i % 60}/f${i}.txt`, bytes: enc.encode(`e2e ${i} ${Math.random()}`), mimeType: "text/plain" }));
  const { plan, applied, txHashes } = await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, fs, {});
  expect(txHashes.length).toBe(plan.bundles.length);
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const again = await c.planNewProject(fs, { opts: {} });
  expect(again.applied.newRootCid).toBe(applied.newRootCid);
  expect(again.plan.chunksToWrite.length + again.plan.filesToCreate.length + again.plan.dirsToCreate.length).toBe(0); // all of it landed
}, 300_000);
