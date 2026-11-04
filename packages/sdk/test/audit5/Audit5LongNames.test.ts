import { afterAll, beforeAll, expect, it } from "vitest";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { uploadContent } from "../../src/draft.js";
import { directoryStoreAbi } from "../../src/abi.js";
import { nodeBlobHex } from "../../src/nodes.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";
let h: AnvilHarness;
beforeAll(async () => { await autoRegisterNodeCodecs(); h = await startAnvilWithAbxfs({ deployCompanion: true }); }, 120_000);
afterAll(async () => h?.stop());
const enc = new TextEncoder();
const mk = (n: number, len: number) => Array.from({ length: n }, (_, i) => ({ path: `${String(i).padStart(4, "0")}${"x".repeat(len - 4)}`, bytes: enc.encode(`ln ${len} ${i} ${Math.random()}`), mimeType: "text/plain" }));

// The cost of an entry node is linear in name BYTES (no cliff at 32 as in v1). The model must never
// be below what a node really costs on chain (a bundle packed to it would revert at simulation), nor absurdly above.
for (const [n, len] of [[60, 10], [60, 250], [30, 40], [30, 100], [300, 9]] as const) {
  it(`node estimate >= actual for ${n} entries with ${len}-byte names`, async () => {
    const fs = mk(n, len);
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const { plan, applied } = await c.planNewProject(fs, { opts: {} });
    // Content first (files, but no entry nodes or directories) so the entries' children exist.
    await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, fs, {
      applied,
      plan: { ...plan, entryNodesToCreate: [], dirsToCreate: [] },
    });
    for (const node of plan.entryNodesToCreate.filter((x) => x.level === 0)) {
      const actual = Number(
        await h.publicClient.estimateContractGas({
          address: h.addresses.directoryStore,
          abi: directoryStoreAbi as never,
          functionName: "putEntryNode",
          args: [nodeBlobHex(node)],
          account: h.account,
        } as never),
      );
      expect(node.estimatedGas, `estimate for a ${node.count}-entry leaf`).toBeGreaterThanOrEqual(actual);
      expect(node.estimatedGas).toBeLessThan(actual * 1.6); // not absurdly pessimistic either
    }
  }, 300_000);
}
