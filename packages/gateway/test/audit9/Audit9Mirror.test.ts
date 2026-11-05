/**
 * AUDIT 9, L5: `assessRoot` bounded DISTINCT nodes but not ENTRIES READ. Directories that differ in one name share
 * almost every node on chain, so they are cheap to write, and each was read in full even when every entry in it was
 * already `seen`: 300 siblings of 15,000 entries holding ONE distinct file cost 4.5 million entries (45,000 calls) to
 * assess, and were accepted. Every entry read is now charged to a per-root budget.
 *
 * And the `--poll-seconds` UX finding: a value that is not a positive number became `NaN` ms, a tight loop.
 */
import { describe, expect, it, vi } from "vitest";

/**
 * `k` sibling directories of `e` entries each, all naming one file: 4.5 million entries, as in the audit. Each
 * directory stays under IPFS's sharding threshold (6,000 short names: a link estimate of about 245,000 bytes), so the
 * entry budget, not the sharding refusal, is what stops the walk.
 */
const counters = vi.hoisted(() => ({ dirReads: 0, entriesRead: 0, k: 750, e: 6_000 }));
const FILE = `0x31${"00".repeat(31)}`;
const ROOT = `0x32${"ff".repeat(31)}`;
const dirCid = (i: number) => `0x32${i.toString(16).padStart(62, "0")}`;

vi.mock("@artblocks/abxfs-sdk", async (orig) => {
  const real = await orig<typeof import("@artblocks/abxfs-sdk")>();
  return {
    ...real,
    fileChunkCount: async () => 1,
    // Honours `maxEntries` as the real one does: the count is known first, so an over-cap directory is one read.
    readDirectory: async (_c: unknown, _a: unknown, cid: string, opts: { maxEntries?: number } = {}) => {
      counters.dirReads++;
      const total = cid === ROOT ? counters.k : counters.e;
      if (opts.maxEntries !== undefined && total > opts.maxEntries) throw new real.LimitExceededError("nodes", opts.maxEntries, `directory ${cid}`);
      counters.entriesRead += total;
      if (cid === ROOT) return { cid, entries: Array.from({ length: counters.k }, (_, i) => ({ name: `d${i}`, cid: dirCid(i), isDirectory: true })) };
      return { cid, entries: Array.from({ length: counters.e }, (_, j) => ({ name: `f${j}`, cid: FILE, isDirectory: false })) };
    },
  };
});

import { ProjectKind } from "@artblocks/abxfs-sdk";

import { DEFAULT_MAX_ENTRIES_PER_ROOT, RootTooLargeError, assessRoot, memoryCursor, parsePollSeconds, runMirror } from "../../src/mirror.js";

describe("L5: one root's assessment is bounded by entries READ", () => {
  it("the audit's shape (4.5 million entries, one distinct file) is refused within the budget", async () => {
    counters.dirReads = 0;
    counters.entriesRead = 0;
    await expect(assessRoot({ id: 84532, contracts: {}, client: {} } as never, ROOT as never, ProjectKind.Directory)).rejects.toBeInstanceOf(RootTooLargeError);
    expect(counters.entriesRead).toBeLessThanOrEqual(DEFAULT_MAX_ENTRIES_PER_ROOT);
    expect(counters.dirReads).toBeLessThan(20);
  });

  it("the budget is a limit like the others, and says what it is", async () => {
    counters.entriesRead = 0;
    const err = await assessRoot({ id: 84532, contracts: {}, client: {} } as never, ROOT as never, ProjectKind.Directory, { maxEntriesPerRoot: 40_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RootTooLargeError);
    expect((err as Error).message).toMatch(/more than 40000 directory entries/);
    expect(counters.entriesRead).toBeLessThanOrEqual(40_000);
  });

  it("a root within every cap is still assessed in full", async () => {
    Object.assign(counters, { entriesRead: 0, k: 20, e: 1_000 });
    const out = await assessRoot({ id: 84532, contracts: {}, client: {} } as never, ROOT as never, ProjectKind.Directory);
    expect(out.files).toBe(1);
    expect(counters.entriesRead).toBe(20 + 20 * 1_000);
    Object.assign(counters, { k: 750, e: 6_000 });
  });
});

describe("UX: --poll-seconds", () => {
  it("accepts a positive number of seconds", () => {
    expect(parsePollSeconds("15")).toBe(15);
    expect(parsePollSeconds("0.5")).toBe(0.5);
    expect(parsePollSeconds("86400")).toBe(86_400);
  });

  it("refuses what used to become a NaN or zero wait", () => {
    for (const raw of [undefined, "", " ", "abc", "0", "-1", "NaN", "Infinity", "86401", "1e9"]) {
      expect(() => parsePollSeconds(raw), String(raw)).toThrow(/--poll-seconds must be a positive number/);
    }
  });

  it("runMirror refuses a wait that is not a positive number before reading the ledger", async () => {
    for (const pollMs of [Number.NaN, 0, -5]) {
      await expect(
        runMirror({ chain: { id: 1, contracts: {}, client: {} } as never, provider: {} as never, cursor: memoryCursor(), pollMs }),
        String(pollMs),
      ).rejects.toThrow(/pollMs must be a positive number/);
    }
  });
});
