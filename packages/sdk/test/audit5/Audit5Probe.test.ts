import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, decodeFunctionData, type PublicClient } from "viem";
import { autoRegisterNodeCodecs } from "../../src/compression.js";
import { AbxfsClient } from "../../src/abxfs.js";
import { uploadContent } from "../../src/draft.js";
import { probeExistence } from "../../src/multicall.js";
import { assertCanPublish } from "../../src/project.js";
import { chunkStoreAbi } from "../../src/abi.js";
import { startAnvilWithAbxfs, type AnvilHarness } from "../helpers/anvil.js";

const A = "0x00000000000000000000000000000000000000a1" as const;
const T = (n: number) => Array.from({ length: n }, (_, i) => ({ address: A, abi: chunkStoreAbi as never, fn: "exists", arg: ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}` }));
const yes = encodeAbiParameters([{ type: "bool" }], [true]);

describe("probeExistence against hostile/buggy clients", () => {
  it("wrong-length result array degrades to per-read answers (never misaligned)", async () => {
    const c = { simulateContract: async () => ({ result: [yes] }), readContract: async () => false } as unknown as PublicClient;
    expect(await probeExistence(c, T(5))).toEqual([false, false, false, false, false]);
  });
  it("garbage return data degrades to per-read", async () => {
    const c = { simulateContract: async () => ({ result: ["0x", "0x1234"] }), readContract: async () => false } as unknown as PublicClient;
    expect(await probeExistence(c, T(2))).toEqual([false, false]);
  });
  it("non-0/1 bool word is not read as true", async () => {
    const bad = ("0x" + "00".repeat(31) + "02") as `0x${string}`;
    const c = { simulateContract: async () => ({ result: [bad] }), readContract: async () => false } as unknown as PublicClient;
    expect(await probeExistence(c, T(1))).toEqual([false]);
  });
  it("a 429 on the batch is rethrown, not fanned out", async () => {
    let reads = 0;
    const c = { simulateContract: async () => { throw Object.assign(new Error("HTTP 429 too many requests"), { status: 429 }); }, readContract: async () => { reads++; return true; } } as unknown as PublicClient;
    await expect(probeExistence(c, T(10))).rejects.toThrow();
    expect(reads).toBe(0);
  });
  it("a store revert inside the batch retries in slices: a 150-probe batch never has more than 20 reads in flight", async () => {
    let reads = 0, inflight = 0, peak = 0;
    const c = { simulateContract: async () => { throw new Error("execution reverted"); }, readContract: async () => { reads++; inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 1)); inflight--; return false; } } as unknown as PublicClient;
    await probeExistence(c, T(150));
    expect(reads).toBe(150);
    expect(peak).toBeLessThanOrEqual(20);
  });
});

describe("assertCanPublish", () => {
  const OWN = "0x00000000000000000000000000000000000a11ce" as const;
  const proj = { collection: A, hook: "0x00000000000000000000000000000000000000b2" } as never;
  it("multicall missing -> two reads: owner ok head ok; owner mismatch refused", async () => {
    const mk = (owner: string, head: string) => ({ multicall: async () => { throw new Error("no multicall3"); }, readContract: async (a: any) => (a.functionName === "ownerOf" ? owner : head) }) as unknown as PublicClient;
    const zero = "0x" + "00".repeat(32);
    await expect(assertCanPublish(mk(OWN, zero), proj, 1n, OWN, { expectedHead: null })).resolves.toBeTruthy();
    await expect(assertCanPublish(mk("0x000000000000000000000000000000000000dEaD", zero), proj, 1n, OWN)).rejects.toThrow(/does not own/);
  });
  it("hostile client that says the signer is owner is simply trusted (publishVersion is the real gate)", async () => {
    const c = { multicall: async () => [{ status: "success", result: OWN }, { status: "success", result: "0x" + "00".repeat(32) }] } as unknown as PublicClient;
    await expect(assertCanPublish(c, proj, 1n, OWN)).resolves.toBeTruthy();
  });
  it("head mismatch / unset head handled", async () => {
    const c = (head: string) => ({ multicall: async () => [{ status: "success", result: OWN }, { status: "success", result: [head, false, head !== "0x" + "00".repeat(32)] }] }) as unknown as PublicClient;
    await expect(assertCanPublish(c("0x" + "11".repeat(32)), proj, 1n, OWN, { expectedHead: null })).rejects.toThrow(/already has content/);
    await expect(assertCanPublish(c("0x" + "00".repeat(32)), proj, 1n, OWN, { expectedHead: ("0x" + "11".repeat(32)) as never })).rejects.toThrow(/changed/);
    await expect(assertCanPublish(c("0x" + "00".repeat(32)), proj, 1n, undefined)).rejects.toThrow(/no account/);
  });
  it("a FAILED tokenParam read throws, it does not read as an unset head", async () => {
    const c = { multicall: async () => [{ status: "success", result: OWN }, { status: "failure", error: new Error("boom") }] } as unknown as PublicClient;
    await expect(assertCanPublish(c, proj, 1n, OWN, { expectedHead: null })).rejects.toThrow(/could not read project/);
    const c2 = { multicall: async () => { throw new Error("no multicall3"); }, readContract: async (a: any) => { if (a.functionName === "ownerOf") return OWN; throw new Error("rpc exploded"); } } as unknown as PublicClient;
    await expect(assertCanPublish(c2, proj, 1n, OWN, { expectedHead: null })).rejects.toThrow(/rpc exploded/);
  });
  it("a transport error (429) is rethrown, never reported as 'does not exist'", async () => {
    const e429 = Object.assign(new Error("HTTP 429 too many requests"), { status: 429 });
    const viaMulti = { multicall: async () => { throw e429; } } as unknown as PublicClient;
    await expect(assertCanPublish(viaMulti, proj, 1n, OWN, { settleMs: 0 })).rejects.toThrow(/429/);
    const viaRead = { multicall: async () => { throw new Error("no multicall3"); }, readContract: async () => { throw e429; } } as unknown as PublicClient;
    await expect(assertCanPublish(viaRead, proj, 1n, OWN, { settleMs: 0 })).rejects.toThrow(/429/);
  });
  it("a freshly minted token lagging on the replica is waited for (bounded), then found", async () => {
    let calls = 0;
    const c = { multicall: async () => { calls++; return calls < 3 ? [{ status: "failure", error: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) }, { status: "failure", error: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) }] : [{ status: "success", result: OWN }, { status: "success", result: ["0x" + "00".repeat(32), false, false] }]; } } as unknown as PublicClient;
    await expect(assertCanPublish(c, proj, 1n, OWN, { expectedHead: null })).resolves.toBeTruthy();
    expect(calls).toBe(3);
  });
  it("a token that never appears fails after the bounded wait", async () => {
    const c = { multicall: async () => [{ status: "failure", error: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) }, { status: "failure", error: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) }] } as unknown as PublicClient;
    await expect(assertCanPublish(c, proj, 1n, OWN, { settleMs: 50 })).rejects.toThrow(/does not exist/);
  });
});

describe("hostile 'everything exists' RPC on anvil", () => {
  let h: AnvilHarness;
  beforeAll(async () => { await autoRegisterNodeCodecs(); h = await startAnvilWithAbxfs({ deployCompanion: true }); }, 120_000);
  afterAll(async () => h?.stop());
  it("writes nothing, spends nothing, and the real chain still lacks the content (a later publish veto would fire at simulation)", async () => {
    const liar = new Proxy(h.publicClient, {
      get(t, p, r) {
        if (p === "simulateContract") return async (a: any) => {
          if (a.functionName === "multicall") return { result: a.args[0].map(() => yes) };
          return (t as any).simulateContract(a);
        };
        if (p === "readContract") return async (a: any) => (["exists", "fileExists", "directoryExists"].includes(a.functionName) ? true : (t as any).readContract(a));
        return Reflect.get(t, p, r);
      },
    }) as unknown as PublicClient;
    const fs = [{ path: "a.txt", bytes: new TextEncoder().encode("liar " + Math.random()), mimeType: "text/plain" }];
    const r = await uploadContent({ publicClient: liar, walletClient: h.walletClient as never }, h.addresses, fs, {});
    expect(r.txHashes.length).toBe(0);
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const real = await c.planNewProject(fs, { opts: {} });
    expect(real.plan.chunksToWrite.length).toBeGreaterThan(0);
  }, 120_000);
  it("stale plan from before another tab wrote the same content: executes, dedups, no failure", async () => {
    const fs = Array.from({ length: 5 }, (_, i) => ({ path: `s${i}.txt`, bytes: new TextEncoder().encode("stale " + i + Math.random()), mimeType: "text/plain" }));
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const stale = await c.planNewProject(fs, { opts: {} });
    await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, fs, {}); // other tab
    const r = await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, fs, { applied: stale.applied, plan: stale.plan });
    console.log("stale-plan second write txs:", r.txHashes.length);
    const after = await c.planNewProject(fs, { opts: {} });
    expect(after.plan.chunksToWrite.length + after.plan.filesToCreate.length + after.plan.dirsToCreate.length).toBe(0);
  }, 120_000);
  it("plan/applied mismatch (plan for set A with applied of set B): root never confirmed, so no publish tx could follow", async () => {
    const mk = (tag: string) => [{ path: "x.txt", bytes: new TextEncoder().encode(tag + Math.random()), mimeType: "text/plain" }];
    const c = new AbxfsClient({ publicClient: h.publicClient, walletClient: h.walletClient, addresses: h.addresses });
    const A_ = await c.planNewProject(mk("A"), { opts: {} });
    const B_ = await c.planNewProject(mk("B"), { opts: {} });
    const t0 = Date.now();
    await uploadContent({ publicClient: h.publicClient, walletClient: h.walletClient as never }, h.addresses, [], { applied: B_.applied, plan: A_.plan } as never).catch(() => {});
    const root = await h.publicClient.readContract({ address: h.addresses.directoryStore, abi: (await import("../../src/abi.js")).directoryStoreAbi, functionName: "directoryExists", args: [B_.applied.newRootCid] });
    console.log("B root exists after mismatched plan:", root, "ms", Date.now() - t0);
    expect(root).toBe(false);
  }, 120_000);
});
