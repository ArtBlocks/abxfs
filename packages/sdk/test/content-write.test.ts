/**
 * The ABX FS write path against a real local anvil: the staged executor, resume after a partial failure, the
 * refusals that happen before any write, and node-level progress. The pure packing is in `nodes.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";

import { AbxfsClient } from "../src/abxfs.js";
import { autoRegisterNodeCodecs } from "../src/compression.js";
import { applyNewProject, planPublish, uploadContent, type TxPlan } from "../src/draft.js";
import { directoryEntryCount, readDirectory, readFile, walkDirectory } from "../src/read.js";
import { cidKind } from "../src/kind.js";
import { ProjectKind, type FileDescriptor } from "../src/types.js";
import type { PublishProgress } from "../src/content-write.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "./helpers/anvil.js";

let h: AnvilHarness;
beforeAll(async () => {
  await autoRegisterNodeCodecs();
  h = await startAnvilWithAbxfs({ deployCompanion: true });
}, 120_000);
afterAll(async () => h?.stop());

const enc = new TextEncoder();
const nonce = () => h.publicClient.getTransactionCount({ address: h.account.address });
const clients = (wallet = h.walletClient) => ({ publicClient: h.publicClient, walletClient: wallet as never });

/** Fresh random content each call, so tests never dedupe against one another. */
function tree(): FileDescriptor[] {
  const salt = randomBytes(8).toString("hex");
  const out: FileDescriptor[] = [];
  for (const dir of ["", "a/", "b/", "a/deep/"]) {
    for (let i = 0; i < 3; i++) out.push({ path: `${dir}f${i}.txt`, bytes: enc.encode(`${salt} ${dir} ${i}`), mimeType: "text/plain" });
  }
  // One multi-chunk file (about 70 KB of incompressible bytes = 3+ chunks) so there are chunk nodes with real hashes.
  out.push({ path: "big.bin", bytes: new Uint8Array(randomBytes(70_000)), mimeType: "application/octet-stream" });
  return out;
}

/** A wallet that drops (throws) the (n+1)th `writeContract`, as a dropped connection or a rejected prompt would. */
function dropsAfter(n: number) {
  let sent = 0;
  return new Proxy(h.walletClient, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop !== "writeContract") return v;
      return async (...args: unknown[]) => {
        if (sent >= n) throw new Error("simulated dropped transaction");
        sent++;
        return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  }) as typeof h.walletClient;
}

describe("staged executor", () => {
  it("writes chunks, chunk nodes, files, entry nodes and directories in dependency order, with node-level progress", async () => {
    const files = tree();
    const events: PublishProgress[] = [];
    const phases: string[] = [];
    const r = await uploadContent(clients(), h.addresses, files, {
      onProgress: (e) => events.push(e),
      onPhase: (p) => phases.push(p),
      maxBundleGas: 1, // every call its own transaction, so every stage boundary is exercised
    });
    expect(r.txHashes.length).toBe(events.length);
    // Stages arrive in order: chunks, then chunk-nodes, files, then per wave entry-nodes and directories.
    const order = events.map((e) => e.stage);
    const first = (s: string) => order.indexOf(s as never);
    expect(first("chunks")).toBeLessThan(first("chunk-nodes"));
    expect(first("chunk-nodes")).toBeLessThan(first("files"));
    expect(first("files")).toBeLessThan(first("entry-nodes"));
    expect(first("entry-nodes")).toBeLessThan(first("directories"));
    // Directories are written in waves of height: a/deep (0) before a (1) before the root (2).
    const dirWaves = events.filter((e) => e.stage === "directories").map((e) => e.wave);
    expect([...dirWaves]).toEqual([...dirWaves].sort((a, b) => a! - b!));
    expect(Math.max(...(dirWaves as number[]))).toBe(2);
    // Counters are consistent: the last event has done == total.
    const last = events[events.length - 1]!;
    expect(last.txsDone).toBe(last.txsTotal);
    expect(last.txsTotal).toBe(events.length);
    expect(last.kindCallsDone).toBe(last.kindCallsTotal);
    expect(new Set(phases)).toEqual(new Set(["writing-chunks", "creating-files", "creating-directories"]));
    // The planned bundles are exactly what ran.
    expect(r.plan.bundles.length).toBe(events.length);
    // And it reads back through the stores.
    expect(await cidKind(h.publicClient, h.addresses, r.applied.newRootCid)).toBe(ProjectKind.Directory);
    const dir = await readDirectory(h.publicClient, h.addresses, r.applied.newRootCid);
    expect(dir.entries.map((e) => e.name)).toEqual(["a", "b", "big.bin", "f0.txt", "f1.txt", "f2.txt"]);
    const big = files.find((f) => f.path === "big.bin")!;
    const read = await readFile(h.publicClient, h.addresses, dir.entries.find((e) => e.name === "big.bin")!.cid);
    expect(Buffer.from(read.bytes).equals(Buffer.from(big.bytes))).toBe(true);
    expect((await walkDirectory(h.publicClient, h.addresses, r.applied.newRootCid)).length).toBe(files.length);
  }, 300_000);

  it("batches small nodes into shared transactions under the default budget", async () => {
    const files = tree();
    const bundled = await uploadContent(clients(), h.addresses, files, {});
    const single = bundled.plan.bundles.length;
    // 13 files and 4 directories would be ~40 transactions one call at a time; batching makes it a handful.
    expect(single).toBeLessThan(14);
    expect(bundled.plan.bundles.every((b) => Number(b.estGas) <= 16_777_216 * 0.75)).toBe(true);
  }, 300_000);

  for (const dropAt of [1, 3, 6, 11]) {
    it(`resumes after the wallet drops at transaction ${dropAt}: the second run writes only what is left`, async () => {
      const files = tree();
      // How many transactions a clean one-call-per-tx run of THIS content needs (planning sends nothing).
      const total = (await planPublish(h.publicClient, h.addresses, await applyNewProject(h.publicClient, h.addresses, files), { maxBundleGas: 1 })).bundles.length;
      expect(dropAt).toBeLessThan(total);

      await expect(uploadContent(clients(dropsAfter(dropAt)), h.addresses, files, { maxBundleGas: 1 })).rejects.toThrow(/simulated dropped/);
      // Re-plan (as a retry does): what is left is exactly what is missing.
      const applied = await applyNewProject(h.publicClient, h.addresses, files);
      const left = await planPublish(h.publicClient, h.addresses, applied, { maxBundleGas: 1 });
      expect(left.bundles.length).toBe(total - dropAt);

      const second = await uploadContent(clients(), h.addresses, files, { maxBundleGas: 1, applied });
      expect(second.txHashes.length).toBe(total - dropAt);
      expect(await cidKind(h.publicClient, h.addresses, applied.newRootCid)).toBe(ProjectKind.Directory);
      expect(await directoryEntryCount(h.publicClient, h.addresses, applied.newRootCid)).toBe(6);

      // A third run finds everything and sends nothing.
      const before = await nonce();
      const third = await uploadContent(clients(), h.addresses, files, { maxBundleGas: 1 });
      expect(third.txHashes).toEqual([]);
      expect(await nonce()).toBe(before);
    }, 600_000);
  }

  it("a plan handed in with a node above the single-call ceiling is refused before ANY transaction", async () => {
    const files = tree();
    const applied = await applyNewProject(h.publicClient, h.addresses, files);
    const plan = await planPublish(h.publicClient, h.addresses, applied);
    const poisoned: TxPlan = {
      ...plan,
      entryNodesToCreate: plan.entryNodesToCreate.map((n, i) => (i === 0 ? { ...n, estimatedGas: 30_000_000 } : n)),
    };
    const before = await nonce();
    await expect(uploadContent(clients(), h.addresses, files, { applied, plan: poisoned })).rejects.toThrow(/more than one transaction can use/);
    expect(await nonce()).toBe(before);
  }, 120_000);

  it("planning against an address book with no stores refuses, naming what is missing", async () => {
    const files = tree();
    const applied = await applyNewProject(h.publicClient, h.addresses, files);
    const noStores = { ...h.addresses, fileStore: undefined, directoryStore: undefined } as never;
    await expect(planPublish(h.publicClient, noStores, applied)).rejects.toThrow(/no ABX FS content stores/);
  }, 60_000);

  it("a plan that is already complete costs only reads: no chunk, node, file or directory is rewritten", async () => {
    const files = tree();
    await uploadContent(clients(), h.addresses, files, {});
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const { plan } = await c.planNewProject(files);
    expect(plan.chunksToWrite.length + plan.chunkNodesToCreate.length + plan.filesToCreate.length).toBe(0);
    expect(plan.entryNodesToCreate.length + plan.dirsToCreate.length).toBe(0);
    expect(plan.bundles).toEqual([]);
  }, 300_000);

  it("a changed file rewrites only its own nodes: unchanged chunk-node leaves are not written again", async () => {
    const files = tree();
    const r1 = await uploadContent(clients(), h.addresses, files, {});
    expect(r1.plan.filesToCreate.length).toBe(files.length);
    const edited = files.map((f) => (f.path === "f1.txt" ? { ...f, bytes: enc.encode("edited " + randomBytes(4).toString("hex")) } : f));
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const { plan } = await c.planNewProject(edited);
    expect(plan.filesToCreate.length).toBe(1);
    expect(plan.chunksToWrite.length).toBe(1);
    expect(plan.chunkNodesToCreate.length).toBe(1);
    // The root directory changed, and so did every directory above f1.txt (here just the root).
    expect(plan.dirsToCreate.length).toBe(1);
  }, 300_000);
});

describe("file-kind roots", () => {
  it("uploadFile registers a file root that reads back and probes as a file", async () => {
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const bytes = new Uint8Array(randomBytes(60_000));
    const r = await c.uploadFile({ path: "one.bin", bytes, mimeType: "application/octet-stream" });
    expect(r.rootKind).toBe("file");
    expect(await cidKind(h.publicClient as PublicClient, h.addresses, r.rootCid)).toBe(ProjectKind.File);
    const read = await readFile(h.publicClient, h.addresses, r.rootCid);
    expect(Buffer.from(read.bytes).equals(Buffer.from(bytes))).toBe(true);
  }, 300_000);

  it("dryRun computes the same CID without sending a transaction", async () => {
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const bytes = new Uint8Array(randomBytes(30_000));
    const before = await nonce();
    const dry = await c.uploadFile({ path: "x.bin", bytes, mimeType: "application/octet-stream" }, { dryRun: true });
    expect(dry.txHashes).toEqual([]);
    expect(await nonce()).toBe(before);
    const real = await c.uploadFile({ path: "x.bin", bytes, mimeType: "application/octet-stream" });
    expect(real.rootCid).toBe(dry.rootCid);
  }, 300_000);

  it("a dry run needs no wallet: a read-only client computes the same roots", async () => {
    const reader = new AbxfsClient({ publicClient: h.publicClient, addresses: h.addresses });
    const file = { path: "y.bin", bytes: new Uint8Array(randomBytes(20_000)), mimeType: "application/octet-stream" };
    const files = tree();
    const [dryFile, dryTree] = [await reader.uploadFile(file, { dryRun: true }), await reader.upload(files, { dryRun: true })];
    expect([dryFile.txHashes, dryTree.txHashes]).toEqual([[], []]);
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    expect((await c.uploadFile(file, { dryRun: true })).rootCid).toBe(dryFile.rootCid);
    expect((await c.upload(files, { dryRun: true })).rootCid).toBe(dryTree.rootCid);
    expect(() => reader.uploadFile(file)).toThrow(/no walletClient/); // a real upload still needs one
  }, 300_000);
});
