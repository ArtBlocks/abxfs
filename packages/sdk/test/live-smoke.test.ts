/**
 * LIVE smoke test for the ABX FS content layer on Base Sepolia. Skipped unless ABXFS_RPC_URL_84532 and ABXFS_PRIVATE_KEY
 * are set (it spends testnet ETH and takes a long time); the addresses come from the canonical registry, so it also
 * needs a deployment there. Run once, from this package, with the environment loaded in a subshell so the key never
 * reaches a terminal:
 *
 *   ( set -a; . ../../.env; set +a; npx vitest run test/live-smoke.test.ts --reporter=verbose )
 *
 * It publishes, through the SAME executor the CLI and web use (`uploadContent` / `uploadSingleFile`):
 *   1. a flat directory of 1,000 entries (each a unique one-chunk file), then reads it back, pages it and looks one up;
 *   2. a ~30 MB file (`ABXFS_SMOKE_FILE_MB`, default 30), then reads it back byte for byte;
 * and for each prints transaction counts per stage and gas used against the node gas model's estimate.
 *
 * Cost control: the file is `ABXFS_SMOKE_UNIQUE_MB` (default 8) MB of random bytes repeated up to the requested size.
 * Content-defined chunking re-synchronises inside a repeat, so the repeats are the same chunks: they still make a 30 MB
 * file with a ~1,700-reference chunk-node tree but only the unique chunks are paid for.
 * Set ABXFS_SMOKE_UNIQUE_MB equal to ABXFS_SMOKE_FILE_MB for an all-unique file (about 220 gas per byte).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/** Widened to `Chain`: viem's OP-stack formatters on `baseSepolia` make its client types unassignable to the SDK's `PublicClient`. */
const chain: Chain = baseSepolia;

import { autoRegisterNodeCodecs } from "../src/compression.js";
import { requireCanonicalAddresses } from "../src/canonical.js";
import { applyNewProject, planPublish, uploadContent } from "../src/draft.js";
import { uploadSingleFile } from "../src/upload.js";
import type { PublishProgress, StageId } from "../src/content-write.js";
import { directoryEntryCount, getDirectoryEntriesPage, lookupEntry, readDirectory, readFile, walkDirectory } from "../src/read.js";
import { cidKind } from "../src/kind.js";
import { ProjectKind } from "../src/types.js";

const RPC = process.env.ABXFS_RPC_URL_84532;
const KEY = process.env.ABXFS_PRIVATE_KEY;
const live = Boolean(RPC && KEY);

const FILE_MB = Number(process.env.ABXFS_SMOKE_FILE_MB ?? 30);
/** Where to record the roots this run published (for the gateway's live test), when set. */
const OUT = process.env.ABXFS_SMOKE_OUT;
function recordRoot(kind: string, root: string, size?: number): void {
  if (!OUT) return;
  const prev = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(OUT, JSON.stringify({ ...prev, [kind]: root, ...(size !== undefined ? { [`${kind}Size`]: size } : {}) }, null, 2));
}
const UNIQUE_MB = Math.min(FILE_MB, Number(process.env.ABXFS_SMOKE_UNIQUE_MB ?? 8));

interface Row {
  stage: StageId;
  txs: number;
  calls: number;
  estimated: number;
  used: bigint;
}

async function report(
  label: string,
  publicClient: ReturnType<typeof createPublicClient>,
  events: PublishProgress[],
): Promise<{ txs: number; gas: bigint; rows: Row[] }> {
  const rows = new Map<StageId, Row>();
  const receipts: Array<{ stage: StageId; calls: number; estimated: number; hash: Hex }> = events.map((e) => ({
    stage: e.stage,
    calls: e.calls,
    estimated: e.estimatedGas,
    hash: e.txHash,
  }));
  for (let i = 0; i < receipts.length; i += 20) {
    const slice = receipts.slice(i, i + 20);
    const got = await Promise.all(slice.map((r) => publicClient.getTransactionReceipt({ hash: r.hash })));
    slice.forEach((r, j) => {
      const row = rows.get(r.stage) ?? { stage: r.stage, txs: 0, calls: 0, estimated: 0, used: 0n };
      row.txs++;
      row.calls += r.calls;
      row.estimated += r.estimated;
      row.used += got[j]!.gasUsed;
      rows.set(r.stage, row);
    });
  }
  let txs = 0;
  let gas = 0n;
  const out = [...rows.values()];
  for (const r of out) {
    txs += r.txs;
    gas += r.used;
  }
  console.log(
    `\n[smoke] ${label}: ${txs} content transactions, ${gas.toLocaleString("en-US")} gas used\n` +
      out
        .map(
          (r) =>
            `[smoke]   ${r.stage.padEnd(11)} ${String(r.txs).padStart(4)} txs ${String(r.calls).padStart(5)} calls  ` +
            `used ${r.used.toLocaleString("en-US").padStart(15)}  estimated ${r.estimated.toLocaleString("en-US").padStart(15)}  ` +
            `(estimate/used ${(r.estimated / Number(r.used)).toFixed(2)})`,
        )
        .join("\n"),
  );
  return { txs, gas, rows: out };
}

describe.skipIf(!live)("live: the ABX FS content layer on Base Sepolia", () => {
  const account = live ? privateKeyToAccount((KEY!.startsWith("0x") ? KEY! : `0x${KEY!}`) as Hex, { nonceManager }) : undefined; // nonceManager, as the CLI does: a load-balanced RPC lags
  const publicClient = live ? createPublicClient({ chain, transport: http(RPC!), pollingInterval: 1000 }) : undefined;
  const walletClient = live ? createWalletClient({ chain, transport: http(RPC!), account: account!, pollingInterval: 1000 }) : undefined;
  // Looked up lazily: a skipped suite's body still runs while collecting, and the registry refuses a chain with no
  // deployment.
  const addresses = live ? requireCanonicalAddresses(84532) : (undefined as never);

  it("publishes a 1,000-entry directory and reads it back", async () => {
    await autoRegisterNodeCodecs();
    const startBalance = await publicClient!.getBalance({ address: account!.address });
    const salt = randomBytes(8).toString("hex");
    const enc = new TextEncoder();
    const files = Array.from({ length: 1000 }, (_, i) => ({
      path: `img${String(i).padStart(4, "0")}.txt`,
      bytes: enc.encode(`smoke ${salt} entry ${i}`),
      mimeType: "text/plain",
    }));

    const applied = await applyNewProject(publicClient!, addresses, files);
    const plan = await planPublish(publicClient!, addresses, applied);
    console.log(
      `[smoke] directory plan: ${plan.chunksToWrite.length} chunks, ${plan.chunkNodesToCreate.length} chunk nodes, ${plan.filesToCreate.length} files, ` +
        `${plan.entryNodesToCreate.length} entry nodes (${plan.entryNodesToCreate.filter((n) => n.level === 0).length} leaves), ${plan.dirsToCreate.length} directories, ` +
        `${plan.bundles.length} planned transactions`,
    );

    const events: PublishProgress[] = [];
    const t0 = Date.now();
    const r = await uploadContent({ publicClient: publicClient!, walletClient: walletClient! }, addresses, files, {
      applied,
      plan,
      onProgress: (e) => events.push(e),
    });
    const seconds = (Date.now() - t0) / 1000;
    expect(r.txHashes.length).toBe(plan.bundles.length);
    const stats = await report("1,000-entry directory", publicClient!, events);
    const endBalance = await publicClient!.getBalance({ address: account!.address });
    console.log(`[smoke] directory root ${applied.newRootCid}; ${seconds.toFixed(0)} s; spent ${(Number(startBalance - endBalance) / 1e18).toFixed(6)} ETH`);
    recordRoot("directory", applied.newRootCid!);
    expect(stats.txs).toBe(r.txHashes.length);

    // Read it back through the stores.
    expect(await cidKind(publicClient!, addresses, applied.newRootCid)).toBe(ProjectKind.Directory);
    expect(await directoryEntryCount(publicClient!, addresses, applied.newRootCid)).toBe(1000);
    const page = await getDirectoryEntriesPage(publicClient!, addresses, applied.newRootCid, 0, 100);
    expect(page.map((e) => e.name)).toEqual(files.slice(0, 100).map((f) => f.path));
    const all = await readDirectory(publicClient!, addresses, applied.newRootCid);
    expect(all.entries).toHaveLength(1000);
    expect(all.entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
    const hit = await lookupEntry(publicClient!, addresses, applied.newRootCid, "img0777.txt");
    expect(hit.cid).toBe(all.entries[777]!.cid);
    const one = await readFile(publicClient!, addresses, hit.cid);
    expect(new TextDecoder().decode(one.bytes)).toBe(`smoke ${salt} entry 777`);
    expect((await walkDirectory(publicClient!, addresses, applied.newRootCid)).length).toBe(1000);

    // Resume semantics: the same upload again finds everything and sends nothing.
    const again = await uploadContent({ publicClient: publicClient!, walletClient: walletClient! }, addresses, files, {});
    expect(again.txHashes).toEqual([]);
  }, 3_600_000);

  it(`publishes a ~${FILE_MB} MB file (${UNIQUE_MB} MB unique) and reads it back byte for byte`, async () => {
    await autoRegisterNodeCodecs();
    const startBalance = await publicClient!.getBalance({ address: account!.address });
    const block = randomBytes(UNIQUE_MB * 1024 * 1024);
    const bytes = new Uint8Array(FILE_MB * 1024 * 1024);
    for (let off = 0; off < bytes.length; off += block.length) bytes.set(block.subarray(0, Math.min(block.length, bytes.length - off)), off);

    const events: PublishProgress[] = [];
    const t0 = Date.now();
    const r = await uploadSingleFile(
      { publicClient: publicClient!, walletClient: walletClient! },
      addresses,
      { path: "smoke.bin", bytes, mimeType: "application/octet-stream" },
      { onProgress: (e) => events.push(e) },
    );
    const seconds = (Date.now() - t0) / 1000;
    const file = r.files[0]!;
    const chunkCount = file.chunkIds.length;
    recordRoot("file", r.rootCid, bytes.length);
    console.log(`[smoke] file ${r.rootCid}: ${bytes.length} bytes, ${chunkCount} chunk references, ${new Set(file.chunkIds).size} distinct chunks; ${seconds.toFixed(0)} s`);
    const stats = await report(`${FILE_MB} MB file`, publicClient!, events);
    const endBalance = await publicClient!.getBalance({ address: account!.address });
    console.log(`[smoke] file spent ${(Number(startBalance - endBalance) / 1e18).toFixed(6)} ETH over ${stats.txs} transactions`);

    expect(await cidKind(publicClient!, addresses, r.rootCid)).toBe(ProjectKind.File);
    const read = await readFile(publicClient!, addresses, r.rootCid);
    expect(read.chunkIds.length).toBe(chunkCount);
    expect(Buffer.from(read.bytes).equals(Buffer.from(bytes))).toBe(true);

    const again = await uploadSingleFile({ publicClient: publicClient!, walletClient: walletClient! }, addresses, { path: "smoke.bin", bytes, mimeType: "application/octet-stream" }, {});
    expect(again.txHashes).toEqual([]);
  }, 14_400_000);
});
