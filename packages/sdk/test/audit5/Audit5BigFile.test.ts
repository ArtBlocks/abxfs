import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";
let h: AnvilHarness;
beforeAll(async () => { await autoRegisterNodeCodecs(); h = await startAnvilWithAbxfs({ deployCompanion: true }); }, 120_000);
afterAll(async () => h?.stop());

// Content layer v1 refused a 25 MB file (one createFile could not hold ~1000 chunk hashes). A file is now a tree of
// chunk nodes, so size is not a limit: the plan simply has more nodes. Planning sends no transaction.
it("a 25 MB file plans as a two-level chunk-node tree and nothing is refused or written", async () => {
  const fs = [{ path: "big.bin", bytes: new Uint8Array(randomBytes(25 * 1024 * 1024)), mimeType: "application/octet-stream" }];
  const before = await h.publicClient.getTransactionCount({ address: h.account.address });
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const { applied, plan } = await c.planNewProject(fs, { opts: {} });
  const chunks = applied.files[0]!.chunkIds!.length;
  expect(chunks).toBeGreaterThan(1000); // more than v1 could hold in one createFile
  // Content-defined leaves (32..512 records) under level-1 branches, one createFile, one write per (new) chunk.
  const leaves = plan.chunkNodesToCreate.filter((n) => n.level === 0);
  const branches = plan.chunkNodesToCreate.filter((n) => n.level >= 1);
  expect(leaves.length).toBeGreaterThanOrEqual(Math.ceil(chunks / 512));
  expect(leaves.reduce((n, l) => n + l.count, 0)).toBe(chunks);
  expect(branches.length).toBeGreaterThanOrEqual(1);
  expect(plan.filesToCreate.length).toBe(1);
  expect(plan.chunksToWrite.length).toBe(chunks);
  // Every transaction stays under the per-transaction budget.
  for (const b of plan.bundles) expect(Number(b.estGas)).toBeLessThanOrEqual(16_777_216 * 0.75);
  expect(await h.publicClient.getTransactionCount({ address: h.account.address })).toBe(before);
}, 300_000);
