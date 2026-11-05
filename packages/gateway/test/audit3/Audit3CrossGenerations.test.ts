/**
 * Audit 3, cross-generation (gateway side): resolve and mirror the first time a factory is superseded.
 * Tests marked FINDING assert today's weakness; invert them when the fix lands.
 */
import { describe, expect, it } from "vitest";
import { revertError } from "../helpers.js";
import type { AbxfsCid } from "@artblocks/abxfs-sdk";

import { __resetResolveCaches, resolveRoot } from "../../src/resolve.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorPathFor, fileCursor, memoryCursor, runMirror, runMirrorGenerations } from "../../src/mirror.js";
import { GatewayError } from "../../src/errors.js";
import type { GatewayChain } from "../../src/types.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hk = (n: number) => `0x${n.toString(16).padStart(2, "0")}${"00".repeat(19)}` as `0x${string}`; // distinct first 8 hex, like real addresses
const G3 = { orgFactory: a(0x31), projectHook: hk(0x32), lens: a(0x35) };
const G2 = { orgFactory: a(0x21), projectHook: hk(0x22), lens: a(0x25) };
const G1 = { orgFactory: a(0x11), projectHook: hk(0x12), lens: a(0x15) };
const ORG1 = a(0x901), ORG3 = a(0x903), STRANGER = a(0x999), ORGA = a(0xa1);
const cid = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;

describe("resolveRoot across generations", () => {
  function chain(over: { dead?: string[] } = {}) {
    const calls: { address: string; fn: string }[] = [];
    const created: Record<string, string[]> = { [G3.orgFactory]: [ORG3], [G1.orgFactory]: [ORG1] };
    const c: GatewayChain = {
      id: 8453,
      contracts: { ...G3, previousGenerations: [G2, G1] } as never,
      client: {
        async readContract({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) {
          calls.push({ address, fn: functionName });
          if (over.dead?.includes(address)) throw revertError();
          if (functionName === "isOrg") return (created[address] ?? []).includes(String(args![0]));
          throw revertError(); // anything else: the project does not exist
        },
        async multicall({ contracts }: { contracts: { address: string; functionName: string }[] }) {
          for (const k of contracts) calls.push({ address: k.address, fn: k.functionName });
          throw revertError();
        },
      } as never,
    };
    return { c, calls };
  }

  it("reads an old org's project through the OLD hook, never the current one", async () => {
    __resetResolveCaches();
    const { c, calls } = chain();
    await expect(resolveRoot(c, { kind: "latest", org: ORG1, tokenId: 0n }, "")).rejects.toBeInstanceOf(GatewayError);
    const afterLookup = calls.filter((x) => x.fn !== "isOrg");
    expect(afterLookup.length).toBeGreaterThan(0);
    const touched = new Set(afterLookup.map((x) => x.address));
    expect(touched.has(G1.projectHook)).toBe(true);
    for (const other of [G2.projectHook, G3.projectHook, G2.lens, G3.lens]) expect(touched.has(other)).toBe(false);
  });

  it("a stranger is a 404 'not an org' after asking EVERY generation, and nothing is read from its address", async () => {
    __resetResolveCaches();
    const { c, calls } = chain();
    await expect(resolveRoot(c, { kind: "latest", org: STRANGER, tokenId: 0n }, "")).rejects.toMatchObject({ status: 404 });
    expect(calls.filter((x) => x.fn === "isOrg").map((x) => x.address)).toEqual([G3.orgFactory, G2.orgFactory, G1.orgFactory]);
    expect(calls.some((x) => x.address === STRANGER)).toBe(false);
  });

  it("raw-CID requests never consult a factory (content is shared by every generation)", async () => {
    __resetResolveCaches();
    const { c, calls } = chain();
    await resolveRoot(c, { kind: "cid", rootCid: cid(7) }, "").catch(() => {});
    expect(calls.some((x) => x.fn === "isOrg")).toBe(false);
  });

  it("FIXED: an old org whose factory ERRORS (transport) is a retryable 503, not a negative-cacheable 'not an org'", async () => {
    // A transient RPC error on the one factory that would say true used to be flattened to 'not an org'.
    __resetResolveCaches();
    const { c, calls } = chain({ dead: [G1.orgFactory] });
    const transport = (): never => { throw Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError", status: 502 }); };
    (c.client as unknown as { readContract: unknown }).readContract = async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
      calls.push({ address, fn: functionName });
      if (address === G1.orgFactory) return transport();
      if (functionName === "isOrg") return false;
      throw revertError();
    };
    const err = (await resolveRoot(c, { kind: "latest", org: ORG1, tokenId: 0n }, "").catch((e: unknown) => e)) as GatewayError;
    expect(err.status).toBe(503);
    expect(err.negativeCacheable).toBe(false);
    // Nothing was remembered: the next request asks the factories again.
    const before = calls.length;
    await resolveRoot(c, { kind: "latest", org: ORG1, tokenId: 0n }, "").catch(() => {});
    expect(calls.length).toBeGreaterThan(before);
  });

  it("a factory that REVERTS (or has no code) is a definitive 'no'; a later generation's 'yes' still wins over an earlier error", async () => {
    __resetResolveCaches();
    const { c } = chain();
    const real = (c.client as unknown as { readContract: (a: never) => Promise<unknown> }).readContract;
    (c.client as unknown as { readContract: unknown }).readContract = async (a: { address: string; functionName: string; args?: unknown[] }) => {
      if (a.address === G3.orgFactory) throw Object.assign(new Error("HTTP request failed."), { name: "TimeoutError" });
      return real(a as never);
    };
    // G3 errors, G1 says ORG1 is its org: found, no 503.
    const err = (await resolveRoot(c, { kind: "latest", org: ORG1, tokenId: 0n }, "").catch((e: unknown) => e)) as GatewayError;
    expect(err.status).toBe(404); // the project then does not exist: past the org check
    expect(err.message).toContain("does not exist");
  });
});

describe("mirror across a supersession", () => {
  /** A ledger-per-hook chain: a hook/lens pair answers with its own list of roots. */
  function ledgers(byHook: Record<string, AbxfsCid[]>, contracts: Record<string, unknown>): GatewayChain {
    // Every lens belongs to the hook of its own generation (G1/G2/G3 share the numbering a+0x20 / a+0x10 in this file).
    const lensToHook: Record<string, string> = { [G3.lens]: G3.projectHook, [G2.lens]: G2.projectHook, [G1.lens]: G1.projectHook };
    const owner = (addr: string) => lensToHook[addr] ?? addr;
    return {
      id: 84532,
      contracts: contracts as never,
      client: {
        async readContract({ address, functionName, args }: { address: string; functionName: string; args: readonly unknown[] }) {
          const l = byHook[owner(address)] ?? [];
          if (functionName === "globalPublishCount") return BigInt(l.length);
          if (functionName === "publishRange") {
            const [start, count] = args as [bigint, bigint];
            return l.slice(Number(start), Number(start + count)).map((c, k) => ({
              org: ORGA,
              record: { cid: c, publisher: ORGA, publishedAt: 1, version: 1, tokenId: BigInt(Number(start) + k) },
            }));
          }
          throw new Error(`unexpected ${functionName}`);
        },
      } as never,
    };
  }

  /** What `bin/mirror.ts` does: one file per generation, keyed by hook, never by position. */
  function filesFor(base: string, files: Map<string, ReturnType<typeof memoryCursor>>) {
    return (g: { projectHook: string }) => {
      const p = cursorPathFor(base, g);
      if (!files.has(p)) files.set(p, memoryCursor());
      return files.get(p)!;
    };
  }

  it("FIXED: a new current factory + an old generation: the new one does NOT inherit the old cursor, so nothing is skipped", async () => {
    const files = new Map<string, ReturnType<typeof memoryCursor>>();
    const cursorFor = filesFor("m.json", files);

    // Run 1: only G2 exists.
    const pinned1: string[] = [];
    await runMirrorGenerations({
      chain: ledgers({ [G2.projectHook]: [cid(1), cid(2)] }, { ...G2 }),
      provider: {} as never, once: true, pinRoot: async (c) => void pinned1.push(c), cursorFor,
    });
    expect(pinned1.sort()).toEqual([cid(1), cid(2)].sort());
    expect(await files.get(cursorPathFor("m.json", G2))!.load()).toBe(2);
    expect(files.has("m.json")).toBe(false); // no bare, position-keyed file

    // Supersession: G3 ships with 3 publishes already; G2 moves to previousGenerations and has nothing new.
    const pinned2: string[] = [];
    const stats = await runMirrorGenerations({
      chain: ledgers({ [G3.projectHook]: [cid(10), cid(11), cid(12)], [G2.projectHook]: [cid(1), cid(2)] }, { ...G3, previousGenerations: [G2] }),
      provider: {} as never, once: true, pinRoot: async (c) => void pinned2.push(c), cursorFor,
    });
    expect(stats.failures).toEqual([]);
    expect(pinned2.sort()).toEqual([cid(10), cid(11), cid(12)].sort()); // G3 from ITS zero; G2 not redone
    expect(await files.get(cursorPathFor("m.json", G3))!.load()).toBe(3);
    expect(await files.get(cursorPathFor("m.json", G2))!.load()).toBe(2);
  });

  it("FIXED: a current ledger shorter than a stale cursor fails THAT generation only, loudly; the others carry on", async () => {
    const c3 = memoryCursor(); await c3.save(2); // wrong: G3's ledger is empty
    const lines: string[] = [];
    const pinned: string[] = [];
    const stats = await runMirrorGenerations({
      chain: ledgers({ [G3.projectHook]: [], [G2.projectHook]: [cid(1)] }, { ...G3, previousGenerations: [G2] }),
      provider: {} as never, once: true, pinRoot: async (c) => void pinned.push(c), log: (l) => lines.push(l),
      cursorFor: (g) => (g.projectHook === G3.projectHook ? c3 : memoryCursor()),
    });
    expect(pinned).toEqual([cid(1)]); // G2 was not torn down
    expect(stats.failures).toHaveLength(1);
    expect(stats.failures[0]).toMatchObject({ projectHook: G3.projectHook });
    expect(stats.failures[0]!.error).toMatch(/cursor is at 2 but the ledger has 0/);
    expect(lines.some((l) => /GENERATION FAILED/.test(l) && l.includes(G3.projectHook))).toBe(true);
    expect(stats.generations.find((g) => g.projectHook === G2.projectHook)!.stats).toMatchObject({ pinned: 1 });
  });

  it("FIXED: a generation without a `lens` is refused up front, naming it (never silently skipped)", async () => {
    const pinned: string[] = [];
    const noLens = { orgFactory: G2.orgFactory, projectHook: G2.projectHook }; // no lens
    await expect(
      runMirrorGenerations({
        chain: ledgers({ [G3.projectHook]: [cid(10)], [G2.projectHook]: [cid(1), cid(2)] }, { ...G3, previousGenerations: [noLens] }),
        provider: {} as never, once: true, pinRoot: async (c) => void pinned.push(c), cursorFor: () => memoryCursor(),
      }),
    ).rejects.toThrow(new RegExp(`no lens.*${G2.projectHook}|${G2.projectHook}.*no lens`, "s"));
    expect(pinned).toEqual([]); // nothing started
  });

  it("one generation THROWING (RPC) does not stop the others, and is reported", async () => {
    const base = ledgers({ [G3.projectHook]: [cid(1)], [G2.projectHook]: [cid(2)] }, { ...G3, previousGenerations: [G2] });
    const read = (base.client as unknown as { readContract: (a: { address: string }) => Promise<unknown> }).readContract;
    (base.client as unknown as { readContract: unknown }).readContract = async (a: { address: string; functionName: string }) => {
      if (a.address === G2.projectHook) throw new Error("HTTP request failed");
      return read(a as never);
    };
    const pinned: string[] = [];
    const stats = await runMirrorGenerations({ chain: base, provider: {} as never, once: true, pinRoot: async (c) => void pinned.push(c), cursorFor: () => memoryCursor() });
    expect(pinned).toEqual([cid(1)]);
    expect(stats.failures.map((f) => f.projectHook)).toEqual([G2.projectHook]);
  });

  it("three generations: one cursor each, every ledger pinned once, root shared across generations is pinned once per run per ledger", async () => {
    const cursors = new Map<string, ReturnType<typeof memoryCursor>>();
    const pinned: string[] = [];
    const chain = ledgers(
      { [G3.projectHook]: [cid(1)], [G2.projectHook]: [cid(2)], [G1.projectHook]: [cid(3), cid(1)] },
      { ...G3, previousGenerations: [G2, G1] },
    );
    await runMirrorGenerations({
      chain, provider: {} as never, once: true, pinRoot: async (c) => void pinned.push(c),
      cursorFor: (g) => { const c = memoryCursor(); cursors.set(g.projectHook, c); return c; },
    });
    expect([...cursors.keys()].sort()).toEqual([G1.projectHook, G2.projectHook, G3.projectHook].sort());
    expect(await cursors.get(G1.projectHook)!.load()).toBe(2);
    expect(new Set(pinned)).toEqual(new Set([cid(1), cid(2), cid(3)]));
  });

  it("an explicit generation follows that ledger only; the cursor guard is per ledger", async () => {
    const cursor = memoryCursor(); await cursor.save(5);
    await expect(
      runMirror({ chain: ledgers({ [G1.projectHook]: [cid(1)] }, { ...G3, previousGenerations: [G1] }), generation: G1, provider: {} as never, cursor, once: true, pinRoot: async () => {} }),
    ).rejects.toThrow(/cursor is at 5 but the ledger has 1/);
  });
});

describe("cursor files are keyed by hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "abxfs-cursor-"));
  const base = (n: string) => join(dir, `${n}.json`);

  it("cursorPathFor names the file by the hook's first 8 hex digits, regardless of position", () => {
    expect(cursorPathFor("/x/m.json", G3)).toBe(`/x/m.${G3.projectHook.slice(2, 10)}.json`);
    expect(cursorPathFor("/x/m", G3)).toBe(`/x/m.${G3.projectHook.slice(2, 10)}.json`);
  });

  it("a file records its hook and refuses to be read as another generation's", async () => {
    const p = base("rec");
    await fileCursor(p, { hook: G3.projectHook }).save(4, 9);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ next: 4, hook: G3.projectHook, ledger: 9 });
    expect(await fileCursor(p, { hook: G3.projectHook }).load()).toBe(4);
    await expect(fileCursor(p, { hook: G2.projectHook }).load()).rejects.toThrow(/belongs to hook/);
  });
});
