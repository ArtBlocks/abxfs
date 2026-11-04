/**
 * S-M2: a FastLZ chunk is inflated on every `ChunkStore.read`, and reading 64 of them in one `eth_call` cost 65-108M
 * for real text: past the 50M geth and reth simulate by default. Reads are now sized from the chunks' records, and a
 * call that still fails is halved, keeping what was read. The chain here caps every `eth_call` at 50M (anvil caps a
 * call at the block gas limit).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { encodeFunctionData, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chunkStoreAbi } from "../../src/abi.js";
import { uploadFiles } from "../../src/upload.js";
import { MAX_CHUNKS_PER_CALL, READ_CALL_GAS_BUDGET, planChunkReadSlices, readFile } from "../../src/read.js";
import { LEGACY_GAS_SCHEDULE } from "../../src/gas-schedule.js";
import type { AbxfsCid } from "../../src/types.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const CALL_CAP = 50_000_000;
const multicall = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "", type: "bytes[]" }] }] as const;

let h: AnvilHarness;
beforeAll(async () => {
  h = await startAnvilWithAbxfs({ anvilArgs: ["--gas-limit", String(CALL_CAP)] });
}, 120_000);
afterAll(async () => h?.stop());

/** About 1.5 MB of real JavaScript: every chunk goes to the FastLZ backend. */
function realJs(): Uint8Array {
  const path = createRequire(import.meta.url).resolve("typescript/lib/typescript.js");
  return new Uint8Array(readFileSync(path)).slice(0, 1_500_000);
}

/** What one multicall of `ChunkStore.read` over `ids` costs, or null when the node refuses it at its cap. */
async function sliceGas(ids: readonly AbxfsCid[]): Promise<number | null> {
  const calls = ids.map((id) => encodeFunctionData({ abi: chunkStoreAbi, functionName: "read", args: [id] }));
  const data = encodeFunctionData({ abi: multicall, functionName: "multicall", args: [calls as Hex[]] });
  return h.publicClient.estimateGas({ to: h.addresses.chunkStore, data }).then(Number, () => null);
}

describe("readFile of 1.5 MB of FastLZ text under a 50M eth_call cap", () => {
  it("reads every byte, in slices that each fit the budget the reader planned them under", async () => {
    const bytes = realJs();
    const up = await uploadFiles({ publicClient: h.publicClient, walletClient: h.walletClient }, h.addresses, [{ path: "typescript.js", bytes, mimeType: "application/javascript" }], {
      gasSchedule: LEGACY_GAS_SCHEDULE,
    });
    const file = up.files[0]!;
    expect(file.chunkIds.length).toBeGreaterThan(MAX_CHUNKS_PER_CALL / 2);

    // What the old reader asked for: 64 chunks in one call. The node refuses it.
    expect(await sliceGas(file.chunkIds.slice(0, MAX_CHUNKS_PER_CALL))).toBeNull();

    const back = await readFile(h.publicClient, h.addresses, file.cid);
    expect(back.bytes).toEqual(bytes);

    // Each slice the reader plans from the records costs no more than its budget, measured.
    const records = await Promise.all(
      file.chunkIds.map(async (id) => {
        const r = (await h.publicClient.readContract({ address: h.addresses.chunkStore, abi: chunkStoreAbi, functionName: "recordOf", args: [id] })) as unknown as readonly [`0x${string}`, number];
        return { backend: r[0], size: Number(r[1]) };
      }),
    );
    const slices = planChunkReadSlices(records, h.addresses);
    expect(slices.length).toBeGreaterThan(1);
    for (const [s, e] of slices) {
      const gas = await sliceGas(file.chunkIds.slice(s, e));
      expect(gas).not.toBeNull();
      expect(gas!).toBeLessThanOrEqual(READ_CALL_GAS_BUDGET);
    }
  }, 900_000);

  it("a node that simulates less than the budget still reads: a refused call is halved, and what was read is kept", async () => {
    const bytes = realJs().slice(0, 400_000);
    const up = await uploadFiles({ publicClient: h.publicClient, walletClient: h.walletClient }, h.addresses, [{ path: "part.js", bytes, mimeType: "application/javascript" }], {
      gasSchedule: LEGACY_GAS_SCHEDULE,
    });
    // A client whose node caps every call at 4M: every planned slice is refused once and halved until it fits.
    const reads: number[] = [];
    const capped = new Proxy(h.publicClient, {
      get(target, prop, receiver) {
        if (prop === "simulateContract") {
          return async (args: Parameters<typeof target.simulateContract>[0]) => {
            reads.push((args.args as readonly [readonly Hex[]])[0].length);
            return target.simulateContract({ ...args, gas: 4_000_000n });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const back = await readFile(capped, h.addresses, up.files[0]!.cid);
    expect(back.bytes).toEqual(bytes);
    // Some call was refused and split; no chunk was read twice beyond the halving.
    expect(Math.min(...reads)).toBeLessThan(Math.max(...reads));
  }, 600_000);
});
