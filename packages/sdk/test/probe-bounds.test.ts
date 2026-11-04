/**
 * Audit round 2 (HIGH): the browser transport batches concurrent reads into ONE JSON-RPC request and an
 * RPC proxy may cap a batch, so an unbounded burst of existence probes failed as a whole. Every
 * probe fan-out is now sliced; this pins that no more than PROBE_SLICE reads are ever in flight.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { applyDraftToBase, planPublish } from "../src/draft.js";
import { mapInSlices } from "../src/util.js";
import { PROBE_BATCH } from "../src/multicall.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";
import type { DraftOp } from "../src/index.js";

describe("mapInSlices", () => {
  it("preserves order and never has more than `size` in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapInSlices(
      Array.from({ length: 205 }, (_, i) => i),
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return n * 2;
      },
      50,
    );
    expect(out).toEqual(Array.from({ length: 205 }, (_, i) => i * 2));
    expect(peak).toBe(50);
  });
  it("handles empty input", async () => {
    expect(await mapInSlices([], async () => 1)).toEqual([]);
  });
});

describe("planning a publish of 500 new items issues bounded concurrent reads", () => {
  let harness: AnvilHarness;
  beforeAll(async () => {
    await autoRegisterNodeCodecs();
    harness = await startAnvilWithAbxfs({ deployCompanion: true });
  }, 120_000);
  afterAll(async () => {
    await harness?.stop();
  });

  it("plan probes ride a handful of batched multicalls, never one read each", async () => {
    const enc = new TextEncoder();
    const { AbxfsClient } = await import("../src/abxfs.js");
    const client = new AbxfsClient({ publicClient: harness.publicClient, walletClient: harness.walletClient, addresses: harness.addresses });
    const root = await client.upload([{ path: "a.txt", bytes: enc.encode("a"), mimeType: "text/plain" }]);

    const ops: DraftOp[] = Array.from({ length: 500 }, (_, i) => ({
      kind: "add" as const,
      // 100 directories of 5 files: new files, new chunks AND new directories to probe.
      path: `d${i % 100}/f${i}.txt`,
      bytes: enc.encode(`unique file number ${i} ${"x".repeat(i % 7)}`),
      mimeType: "text/plain",
    }));
    const applied = await applyDraftToBase(harness.publicClient, harness.addresses, root.rootCid, ops);

    // Audit 4: probes are batched into multicalls of PROBE_BATCH, so the number of eth_calls (not of
    // in-flight single reads) is what is bounded. Count every read-shaped entry point.
    let reads = 0;
    let maxInner = 0;
    const counting = new Proxy(harness.publicClient, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== "readContract" && prop !== "simulateContract") return v;
        return async (...args: unknown[]) => {
          reads++;
          const a = args[0] as { functionName?: string; args?: unknown[][] };
          if (a.functionName === "multicall") maxInner = Math.max(maxInner, (a.args?.[0] as unknown[]).length);
          return (v as (...x: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as PublicClient;

    const plan = await planPublish(counting, harness.addresses, applied);
    expect(plan.filesToCreate.length).toBeGreaterThanOrEqual(500);
    expect(plan.dirsToCreate.length).toBeGreaterThanOrEqual(100);
    // 500 files, 100+ dirs, then their 500+ chunk nodes and entry nodes, then 500+ chunks: a handful of batched
    // multicalls (about 4 per 500 items per round) instead of 2,000+ single reads.
    expect(reads).toBeLessThanOrEqual(20);
    expect(maxInner).toBeLessThanOrEqual(PROBE_BATCH);
    expect(maxInner).toBeGreaterThan(1);
  }, 240_000);
});
