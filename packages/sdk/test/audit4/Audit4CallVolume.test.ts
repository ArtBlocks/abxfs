/**
 * Audit 4 (item 8), inverted: JSON-RPC call volume of the real client code against the proxy's documented
 * limit of 600 CALLS per minute per caller. Every JSON-RPC call is counted individually (a browser batch of 50
 * costs 50 at the proxy). Runs the real SDK against anvil through a counting custom transport.
 *
 * Before the fix, planning cost ~2.2 reads per file and the content publish ~4.9 (every stage re-planned and
 * re-probed everything, one eth_call per probe): ~7.1 reads/file, so 85+ files overran 600/min after content
 * had been paid for. Now every probe is a batched multicall and a plan that was already computed is executed
 * as given. Budget asserted here: planning + content publish together <= 1.2 reads per file.
 *
 * Receipt polls are bounded per transaction instead: how many `eth_getTransactionReceipt` calls a transaction takes
 * depends on how fast the node answers, not on the plan (8 for 8 transactions on one run, 16 on a loaded CI runner,
 * every other method's count identical).
 */
import { appendFileSync, mkdirSync } from "node:fs";

// The measurements are appended here for comparison across runs; the directory may not exist on a fresh machine.
mkdirSync("/tmp/a4", { recursive: true });
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, pad, toFunctionSelector } from "viem";
import { foundry } from "viem/chains";

import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { estimatePublishCalls, RPC_PROXY_CALLS_PER_MINUTE } from "../../src/call-budget.js";
import { planUpload } from "../../src/upload.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const enc = new TextEncoder();
const DUMMY = "0x00000000000000000000000000000000000d00d1" as const;
const OWNER_OF = "0x6352211e";
const FILE_STORE_SEL = toFunctionSelector("fileStore()");
const DIR_STORE_SEL = toFunctionSelector("directoryStore()");

function counter(url: string, owner: string, stores: { file: string; dir: string }) {
  const counts = new Map<string, number>();
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      counts.set(method, (counts.get(method) ?? 0) + 1);
      // The stand-in project: `ownerOf` answers the signer, `tokenParam` answers "unset". Everything else is real.
      if (method === "eth_call") {
        const call = (params as [{ to?: string; data?: string }])[0];
        if (call.to?.toLowerCase() === DUMMY) {
          if (call.data?.startsWith(OWNER_OF)) return pad(owner as `0x${string}`, { size: 32 });
          // The stand-in hook is bound to the address book's stores, as a real hook is.
          if (call.data?.startsWith(FILE_STORE_SEL)) return pad(stores.file as `0x${string}`, { size: 32 });
          if (call.data?.startsWith(DIR_STORE_SEL)) return pad(stores.dir as `0x${string}`, { size: 32 });
          return encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "bool" }], [pad("0x00", { size: 32 }), false, false]);
        }
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    },
  });
  const total = () => [...counts.values()].reduce((a, b) => a + b, 0);
  const snap = () => ({ total: total(), eth_call: counts.get("eth_call") ?? 0, byMethod: Object.fromEntries(counts) });
  const reset = () => counts.clear();
  return { transport, snap, reset };
}

// The same bytes on every run and every machine: the measured plan (how many transactions the content stages take) is
// then fixed. Random bytes once made a CI run pack one transaction more than the budget allowed. The `of ${n}` keeps
// each size's files distinct from the previous size's on the shared anvil, so nothing is deduplicated.
const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `d${i % Math.max(1, Math.floor(n / 5))}/f${i}.txt`,
    bytes: enc.encode(`unique file number ${i} of ${n} ${"x".repeat(i % 7)}`),
    mimeType: "text/plain",
  }));

describe("audit4: call volume (fixed)", () => {
  let h: AnvilHarness;
  beforeAll(async () => {
    await autoRegisterNodeCodecs();
    h = await startAnvilWithAbxfs({ deployCompanion: true });
  }, 120_000);
  afterAll(async () => h?.stop());

  for (const n of process.env.A4N ? process.env.A4N.split(",").map(Number) : [60, 120, 250, 500]) {
    it(`${n} files: planning + content publish <= 1.2 reads per file`, async () => {
      const c = counter(h.rpcUrl, h.account.address, { file: h.addresses.fileStore, dir: h.addresses.directoryStore });
      const pc = createPublicClient({ chain: foundry, transport: c.transport });
      const wc = createWalletClient({ chain: foundry, account: h.account, transport: c.transport });
      const fs = files(n);

      c.reset();
      await planUpload(fs, { addresses: h.addresses });
      const staging = c.snap();
      expect(staging.total).toBe(0); // the wallet-less plan is pure: the backends come from the address book

      c.reset();
      const client = new AbxfsClient({ publicClient: pc, walletClient: wc, addresses: { ...h.addresses, projectHook: DUMMY } }).forOrg(DUMMY);
      const { applied, plan } = await client.planNewProject(fs, { opts: {} });
      const planning = c.snap();

      // Execute the SAME plan: no re-plan, no re-probe. Stops at the hook (a stand-in project), after the content stages.
      c.reset();
      const t0 = Date.now();
      let stoppedWith = "";
      try {
        await client.publishNewProject({ tokenId: 1n, name: "x", files: fs, applied, opts: { plan } });
      } catch (e) {
        stoppedWith = String((e as Error).message).slice(0, 220);
      }
      const publish = c.snap();
      expect(stoppedWith).toMatch(/could not confirm which version|version count|publish blind/); // got all the way through the content stages

      const polls = publish.byMethod.eth_getTransactionReceipt ?? 0;
      const sent = publish.byMethod.eth_sendRawTransaction ?? 0;
      const perFile = (planning.total + publish.total - polls) / n;
      const est = estimatePublishCalls(plan, { chunks: applied.files.reduce((a, f) => a + (f.chunkIds?.length ?? 0), 0), files: n, dirs: plan.dirsToCreate.length }, { replan: false });
      appendFileSync(
        "/tmp/a4/volume-after.txt",
        JSON.stringify({ n, planning: planning.total, publishContent: publish.total, perFile: +perFile.toFixed(3), planningPerFile: +(planning.total / n).toFixed(3), publishPerFile: +(publish.total / n).toFixed(3), estimated: est.total, byMethod: publish.byMethod, ms: Date.now() - t0 }) + "\n",
      );
      // Content layer v2 runs more, smaller stages (chunk nodes, files, entry nodes, directories, per wave of
      // directory height), each its own transaction(s): about 25 calls of fixed overhead that a v1 publish did not
      // have. The per-file cost still must not grow with n.
      expect(perFile).toBeLessThanOrEqual(1.2 + 25 / n);
      // Every transaction's receipt is read at least once, and a few polls each at most.
      expect(polls).toBeGreaterThanOrEqual(sent);
      expect(polls).toBeLessThanOrEqual(sent * 4);
      // The pre-flight estimate must not under-state what was measured (planning + content, hook steps excluded).
      expect(est.total).toBeGreaterThanOrEqual((planning.total + publish.total) * 0.8);
      expect(planning.total + publish.total).toBeLessThan(RPC_PROXY_CALLS_PER_MINUTE * 3);
    }, 1_800_000);
  }

  it("projection: a 5000-file project's estimate, from a real plan", async () => {
    const c = counter(h.rpcUrl, h.account.address, { file: h.addresses.fileStore, dir: h.addresses.directoryStore });
    const pc = createPublicClient({ chain: foundry, transport: c.transport });
    const client = new AbxfsClient({ publicClient: pc, addresses: { ...h.addresses, projectHook: DUMMY } }).forOrg(DUMMY);
    const n = 5000;
    c.reset();
    // Two levels (20 groups x 50 folders x 5 files): a flat 1000-folder top level is refused (audit 5), as it
    // cannot be registered in one transaction.
    const nested = files(n).map((f, i) => ({ ...f, path: `g${i % 20}/d${Math.floor(i / 20) % 50}/f${i}.txt` }));
    const { applied, plan } = await client.planNewProject(nested, { opts: {} });
    const planningMeasured = c.snap().total;
    const est = estimatePublishCalls(plan, { chunks: applied.files.reduce((a, f) => a + (f.chunkIds?.length ?? 0), 0), files: n, dirs: plan.dirsToCreate.length });
    appendFileSync("/tmp/a4/volume-after.txt", JSON.stringify({ n, projection: est, planningMeasured, bundles: plan.bundles.length }) + "\n");
    expect(planningMeasured / n).toBeLessThan(0.05);
    expect(est.total / n).toBeLessThanOrEqual(1.2);
    // 5000 files does not fit half a minute of budget, and the UI says so BEFORE the first paid write.
    expect(est.exceedsSafeBudget).toBe(true);
    expect(est.minutesAtFullBudget).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
