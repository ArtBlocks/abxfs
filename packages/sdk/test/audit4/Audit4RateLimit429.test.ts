/**
 * Audit 4 (item 8), inverted: a fixed-window proxy (600 CALLS/60s, batch cost = length, 429 + Retry-After: 60,
 * a 429 still counts) in front of anvil, driven by a browser-style viem transport (batch 50/16ms).
 *
 * Before the fix a 500-file plan alone cost 1,102 reads and the publish failed after paying for content.
 * Now planning + the content stages of 60..500 files fit one window with no 429 at all. (What a client does when
 * a 429 does arrive, for projects too big for one window, is that client's to test.)
 */
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";

// The measurements are appended here for comparison across runs; the directory may not exist on a fresh machine.
mkdirSync("/tmp/a4", { recursive: true });
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, pad, toFunctionSelector } from "viem";
import { foundry } from "viem/chains";

import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { PublishedPartialError } from "../../src/publish.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

let h: AnvilHarness;
let srv: Server;
let port = 0;
const stats = { requests: 0, calls: 0, r429: 0, ok: 0 };
let win: { count: number; resetAt: number } | null = null;
const DUMMY = "0x00000000000000000000000000000000000d00d1";

type Req = { id: number | string; method: string; params?: [{ to?: string; data?: string }] };
function stub(r: Req, owner: string): unknown | undefined {
  if (r.method !== "eth_call" || r.params?.[0]?.to?.toLowerCase() !== DUMMY) return undefined;
  if (r.params[0].data?.startsWith("0x6352211e")) return pad(owner as `0x${string}`, { size: 32 });
  // The stand-in hook is bound to the address book's stores, as a real hook is.
  if (r.params[0].data?.startsWith(toFunctionSelector("fileStore()"))) return pad(h.addresses.fileStore, { size: 32 });
  if (r.params[0].data?.startsWith(toFunctionSelector("directoryStore()"))) return pad(h.addresses.directoryStore, { size: 32 });
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bool" }, { type: "bool" }], [pad("0x00", { size: 32 }), false, false]);
}

beforeAll(async () => {
  await autoRegisterNodeCodecs();
  h = await startAnvilWithAbxfs({ deployCompanion: true });
  srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const parsed = JSON.parse(Buffer.concat(chunks).toString()) as Req | Req[];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    stats.requests++;
    stats.calls += list.length;
    const now = Date.now();
    if (!win || win.resetAt <= now) win = { count: list.length, resetAt: now + 60_000 };
    else win.count += list.length;
    if (win.count > 600) {
      stats.r429++;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limited" } }));
      return;
    }
    stats.ok++;
    const answers = new Map<number | string, unknown>();
    const forward: Req[] = [];
    for (const r of list) {
      const s = stub(r, h.account.address);
      if (s !== undefined) answers.set(r.id, { jsonrpc: "2.0", id: r.id, result: s });
      else forward.push(r);
    }
    if (forward.length > 0) {
      const up = await fetch(h.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forward) });
      for (const a of (await up.json()) as Array<{ id: number | string }>) answers.set(a.id, a);
    }
    const out = list.map((r) => answers.get(r.id));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? out : out[0]));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;
}, 120_000);
afterAll(async () => {
  srv?.close();
  await h?.stop();
});

for (const n of (process.env.A4N ?? "60,120,250,500").split(",").map(Number)) {
  it(`${n}-file plan + publish content through a 600/min proxy with a batching transport: no 429`, async () => {
    win = null;
    for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
    const pc = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${port}`, { batch: { batchSize: 50, wait: 16 }, retryCount: 3, retryDelay: 250 }) });
    const wc = createWalletClient({ chain: foundry, account: h.account, transport: http(h.rpcUrl) });
    const enc = new TextEncoder();
    const fs = Array.from({ length: n }, (_, i) => ({ path: `d${i % Math.max(1, n / 5)}/f${i}.txt`, bytes: enc.encode(`f ${i} ${Math.random()}`.padEnd(300, "z")), mimeType: "text/plain" }));
    const c = new AbxfsClient({ publicClient: pc, walletClient: wc, addresses: { ...h.addresses, projectHook: DUMMY as `0x${string}` } }).forOrg(DUMMY as `0x${string}`);
    const t0 = Date.now();
    const phases: string[] = [];
    const { applied, plan } = await c.planNewProject(fs, { opts: {} });
    phases.push(`planned at ${stats.calls} calls`);
    let outcome = "content stages completed";
    try {
      await c.publishNewProject({ tokenId: 1n, name: "x", files: fs, applied, opts: { plan, onPhase: (p) => phases.push(`${p}@${stats.calls}`) } });
    } catch (e) {
      if (e instanceof PublishedPartialError) {
        expect(e.phase).toBe("readback-version");
        expect(e.root).toBe(applied.newRootCid);
        expect(e.published).toBe(true);
        expect(e.retryPublish).toBe(false);
        outcome = "confirmed publication; readback-version";
      } else outcome = String((e as Error).message).replace(/\s+/g, " ").slice(0, 160);
    }
    appendFileSync("/tmp/a4/rl-after.txt", JSON.stringify({ n, outcome, seconds: (Date.now() - t0) / 1000, phases, ...stats }) + "\n");
    expect(stats.r429).toBe(0);
    expect(stats.calls).toBeLessThan(600);
    expect(outcome).toMatch(/^confirmed publication; readback-version$|could not confirm which version|version count|publish blind|completed/); // got past every content stage
  }, 900_000);
}
