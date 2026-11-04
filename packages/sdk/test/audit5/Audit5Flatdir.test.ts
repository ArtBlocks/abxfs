import { afterAll, beforeAll, expect, it } from "vitest";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { uploadContent } from "../../src/draft.js";
import { directoryEntryCount, getDirectoryEntriesPage, lookupEntry } from "../../src/read.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => { await autoRegisterNodeCodecs(); h = await startAnvilWithAbxfs({ deployCompanion: true }); }, 120_000);
afterAll(async () => h?.stop());
const enc = new TextEncoder();
const mk = (n: number, dir = "assets") => Array.from({ length: n }, (_, i) => ({ path: `${dir}/img${i}.txt`, bytes: enc.encode(`flat ${n} ${i} ${Math.random()}`), mimeType: "text/plain" }));
const nonce = () => h.publicClient.getTransactionCount({ address: h.account.address });
const clients = () => ({ publicClient: h.publicClient, walletClient: h.walletClient as never });

// Content layer v1 refused a flat directory past ~265 entries (one createDirectory per transaction, 2^24 gas). In v2 a
// directory is a tree of entry nodes, so a large flat directory is just more nodes, and planning is free of writes.
it("a flat directory of 1000 files plans as several entry leaves under a branch, with no transaction sent", async () => {
  const before = await nonce();
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const { plan } = await c.planNewProject(mk(1000), { opts: {} });
  const assets = plan.dirsToCreate.find((d) => d.path === "assets")!;
  expect(assets.entries.length).toBe(1000);
  const leaves = plan.entryNodesToCreate.filter((n) => n.level === 0);
  expect(leaves.length).toBeGreaterThan(1);
  expect(plan.entryNodesToCreate.some((n) => n.level === 1)).toBe(true);
  expect(await nonce()).toBe(before);
}, 300_000);

it("a 1000-entry flat directory executes, pages back in order, and a lookup finds one entry", async () => {
  const fs = mk(1000, "big");
  const r = await uploadContent(clients(), h.addresses, fs, {});
  expect(r.txHashes.length).toBeGreaterThan(0);
  const dir = r.plan.dirsToCreate.find((d) => d.path === "big")!;
  expect(await directoryEntryCount(h.publicClient, h.addresses, dir.cid)).toBe(1000);
  const page = await getDirectoryEntriesPage(h.publicClient, h.addresses, dir.cid, 0, 100);
  expect(page.length).toBe(100);
  expect(page.map((e) => e.name)).toEqual(dir.entries.slice(0, 100).map((e) => e.name));
  const hit = await lookupEntry(h.publicClient, h.addresses, dir.cid, "img777.txt");
  expect(hit.isDirectory).toBe(false);
  expect(hit.cid).toBe(dir.entries.find((e) => e.name === "img777.txt")!.cid);
  // Resume: running the same upload again finds everything and writes nothing.
  const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
  const again = await c.planNewProject(fs, { opts: {} });
  expect(again.plan.chunksToWrite.length + again.plan.chunkNodesToCreate.length + again.plan.filesToCreate.length).toBe(0);
  expect(again.plan.entryNodesToCreate.length + again.plan.dirsToCreate.length).toBe(0);
}, 900_000);

it("a 100-entry directory of 255-byte names (two leaves at the byte limit) executes", async () => {
  const fs = Array.from({ length: 100 }, (_, i) => ({
    path: `long/${String(i).padStart(4, "0")}${"n".repeat(251)}`,
    bytes: enc.encode(`ln ${i} ${Math.random()}`),
    mimeType: "text/plain",
  }));
  const r = await uploadContent(clients(), h.addresses, fs, {});
  const dir = r.plan.dirsToCreate.find((d) => d.path === "long")!;
  expect(dir.entries.length).toBe(100);
  expect(r.plan.entryNodesToCreate.filter((n) => n.level === 0).length).toBeGreaterThan(1);
  expect(await directoryEntryCount(h.publicClient, h.addresses, dir.cid)).toBe(100);
}, 600_000);
