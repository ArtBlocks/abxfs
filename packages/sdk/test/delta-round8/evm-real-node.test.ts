/**
 * Delta audit round 8: on a real node, a chunk on an EVM-readable backend that the node refuses because it simulates
 * less gas than one chunk's read is the node's error (`RetrieveFailed`), not `ChunkUnavailableError` ("cannot be read
 * on chain ... The backend says: EVM-readable"). Round 7's fix was tested with mock clients only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildContentStages, runContentStages } from "../../src/content-write.js";
import { planFile } from "../../src/plan.js";
import { ChunkUnavailableError, readChunkSlices, readFile } from "../../src/read.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

/** DNA-like text: FastLZ shrinks it, so its chunks go to the FastLZ backend, which inflates on every read. */
function dna(bytes: number): Uint8Array {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  return Uint8Array.from({ length: bytes }, (_, i) => ((i + 1) % 61 === 0 ? 0x0a : "ACGT".charCodeAt(Math.floor(rnd() * 4))));
}

describe("a node that simulates less than one chunk's read", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    h = await startAnvilWithAbxfs();
  }, 300_000);
  afterAll(async () => h?.stop());

  it("refuses a chunk on an EVM-readable backend with its own error, not ChunkUnavailableError", async () => {
    const data = dna(120_000);
    const f = await planFile({ backends: { raw: h.addresses.sstore2Backend!, fastLz: h.addresses.fastLzBackend! }, bytes: data, mimeType: "text/plain" });
    await runContentStages(
      { publicClient: h.publicClient as never, walletClient: h.walletClient as never },
      h.addresses,
      buildContentStages(h.addresses, {
        chunksToWrite: f.chunks,
        chunkNodesToCreate: f.tree.nodes,
        filesToCreate: [{ cid: f.cid, chunkIds: f.chunkIds, mimeType: f.mimeType, codec: f.codec, outputHash: f.outputHash, root: f.tree.root as never }],
        entryNodesToCreate: [],
        dirsToCreate: [],
      }),
      12_000_000,
      [],
    );
    const whole = await readFile(h.publicClient as never, h.addresses, f.cid);
    expect(Buffer.from(whole.bytes).equals(Buffer.from(data))).toBe(true);

    // Cap the block, and with it every eth_call, at 200,000 gas: far below one FastLZ chunk's read.
    await h.publicClient.request({ method: "evm_setBlockGasLimit" as never, params: ["0x30d40"] as never });
    await h.publicClient.request({ method: "evm_mine" as never, params: [] as never });
    const err = await readChunkSlices(h.publicClient as never, h.addresses, f.cid, f.chunkIds.slice(0, 1), 1e9).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/RetrieveFailed/);
  }, 300_000);
});
