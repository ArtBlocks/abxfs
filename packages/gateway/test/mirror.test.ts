/**
 * The mirror's loop, against a scripted ledger. The pin itself is replaced, so what is under test is
 * the part that has to be right: where the cursor is, when it moves, and what a crash or a failure
 * costs. One bad root must not stop the mirror behind it forever; a crash must replay an entry, never
 * skip one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AbxfsCid } from "@abxfs/sdk";

import { denylistFilter } from "../src/filters.js";
import { fileCursor, memoryCursor, runMirror, runMirrorGenerations } from "../src/mirror.js";
import { rootSubject } from "../src/subjects.js";
import type { GatewayChain } from "../src/types.js";

const ORG = "0x00000000000000000000000000000000000000a1" as const;
const cid = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as AbxfsCid;
const FACTORY = "0x00000000000000000000000000000000000000c0";
const HOOK = "0x00000000000000000000000000000000000000c1";
const LENS = "0x00000000000000000000000000000000000000c2";

/** A chain whose ledger is `cids`: entry i is token i publishing cids[i]. */
function chainWith(cids: AbxfsCid[], onRead?: () => void): GatewayChain {
  return {
    id: 84532,
    contracts: { orgFactory: FACTORY, projectHook: HOOK, lens: LENS } as never,
    client: {
      async readContract({ functionName, args }: { functionName: string; args: readonly unknown[] }) {
        onRead?.();
        if (functionName === "globalPublishCount") return BigInt(cids.length);
        if (functionName === "publishRange") {
          const [start, count] = args as [bigint, bigint];
          return cids.slice(Number(start), Number(start + count)).map((c, k) => ({
            org: ORG,
            record: {
              cid: c,
              publisher: ORG,
              publishedAt: 1,
              version: 1,
              tokenId: BigInt(Number(start) + k),
            },
          }));
        }
        throw new Error(`unexpected ${functionName}`);
      },
    } as never,
  };
}

const noProvider = {} as never;
const fast = { backoffMs: () => 0, pollMs: 1 };

describe("runMirror", () => {
  it("pins each distinct root once, in order, and ends caught up", async () => {
    const pinned: AbxfsCid[] = [];
    const cursor = memoryCursor();
    const stats = await runMirror({
      chain: chainWith([cid(1), cid(2), cid(1), cid(3)]),
      provider: noProvider,
      cursor,
      once: true,
      pageSize: 2,
      pinRoot: async (c) => void pinned.push(c),
      ...fast,
    });
    // cid(1) is published twice (two projects, or two versions): one pin.
    expect(pinned).toEqual([cid(1), cid(2), cid(3)]);
    expect(stats).toEqual({ pinned: 3, skipped: 1, next: 4 });
    expect(await cursor.load()).toBe(4);
  });

  it("resumes from the cursor and does not repeat what it already handled", async () => {
    const pinned: AbxfsCid[] = [];
    const cursor = memoryCursor(2);
    await runMirror({
      chain: chainWith([cid(1), cid(2), cid(3), cid(4)]),
      provider: noProvider,
      cursor,
      once: true,
      pinRoot: async (c) => void pinned.push(c),
      ...fast,
    });
    expect(pinned).toEqual([cid(3), cid(4)]);
  });

  it("does nothing when already caught up", async () => {
    const pinned: AbxfsCid[] = [];
    const stats = await runMirror({
      chain: chainWith([cid(1)]),
      provider: noProvider,
      cursor: memoryCursor(1),
      once: true,
      pinRoot: async (c) => void pinned.push(c),
      ...fast,
    });
    expect(pinned).toEqual([]);
    expect(stats.next).toBe(1);
  });

  it("applies the filter to the project, its org and the root, and moves past what it refuses", async () => {
    const pinned: AbxfsCid[] = [];
    const stats = await runMirror({
      chain: chainWith([cid(1), cid(2), cid(3)]),
      provider: noProvider,
      cursor: memoryCursor(),
      filter: denylistFilter([rootSubject(cid(2))]),
      once: true,
      pinRoot: async (c) => void pinned.push(c),
      ...fast,
    });
    expect(pinned).toEqual([cid(1), cid(3)]);
    expect(stats).toEqual({ pinned: 2, skipped: 1, next: 3 });
  });

  it("retries a failing root, then succeeds", async () => {
    let calls = 0;
    const stats = await runMirror({
      chain: chainWith([cid(1)]),
      provider: noProvider,
      cursor: memoryCursor(),
      once: true,
      maxAttempts: 5,
      pinRoot: async () => {
        if (++calls < 3) throw new Error("provider hiccup");
      },
      ...fast,
    });
    expect(calls).toBe(3);
    expect(stats.pinned).toBe(1);
  });

  /** One unpinnable root must not stop everything published after it. */
  it("gives up on a root after maxAttempts, logs it, and carries on", async () => {
    const lines: string[] = [];
    const pinned: AbxfsCid[] = [];
    const stats = await runMirror({
      chain: chainWith([cid(1), cid(2), cid(3)]),
      provider: noProvider,
      cursor: memoryCursor(),
      once: true,
      maxAttempts: 3,
      log: (l) => lines.push(l),
      pinRoot: async (c) => {
        if (c === cid(2)) throw new Error("cannot pin this one");
        pinned.push(c);
      },
      ...fast,
    });
    expect(pinned).toEqual([cid(1), cid(3)]);
    expect(stats).toEqual({ pinned: 2, skipped: 1, next: 3 });
    expect(lines.some((l) => l.includes("GAVE UP") && l.includes("cannot pin this one"))).toBe(true);
  });

  /** A cursor from another deployment would silently miss everything until the ledger caught up. */
  it("refuses a cursor that is ahead of the ledger", async () => {
    await expect(
      runMirror({ chain: chainWith([cid(1)]), provider: noProvider, cursor: memoryCursor(5), once: true, ...fast }),
    ).rejects.toThrow(/wrong cursor file/);
  });

  it("says so when the chain has no org layer", async () => {
    const chain = { id: 8453, contracts: {} as never, client: {} as never };
    await expect(runMirror({ chain, provider: noProvider, cursor: memoryCursor(), once: true })).rejects.toThrow(
      /no org layer/,
    );
  });

  /** A crash replays at most one entry and never skips one: the cursor moves after the work. */
  it("saves the cursor only after an entry is handled", async () => {
    const cursor = memoryCursor();
    const seen: number[] = [];
    await expect(
      runMirror({
        chain: chainWith([cid(1), cid(2)]),
        provider: noProvider,
        cursor,
        once: true,
        maxAttempts: 1,
        pinRoot: async (c) => {
          seen.push(await cursor.load());
          if (c === cid(2)) throw new Error("x");
        },
        ...fast,
      }),
    ).resolves.toBeDefined();
    expect(seen).toEqual([0, 1]); // the cursor had not moved past an entry while it was being pinned
  });

  it("stops promptly when aborted while waiting for more", async () => {
    const controller = new AbortController();
    const done = runMirror({
      chain: chainWith([cid(1)]),
      provider: noProvider,
      cursor: memoryCursor(1),
      signal: controller.signal,
      pollMs: 60_000,
      pinRoot: async () => {},
    });
    setTimeout(() => controller.abort(), 20);
    await expect(done).resolves.toMatchObject({ next: 1 });
  });
});

describe("fileCursor", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("starts at zero with no file, and round-trips", async () => {
    dir = mkdtempSync(join(tmpdir(), "abxfs-cur-"));
    const c = fileCursor(join(dir, "nested", "cursor.json"));
    expect(await c.load()).toBe(0);
    await c.save(7);
    expect(await c.load()).toBe(7);
    expect(JSON.parse(readFileSync(join(dir, "nested", "cursor.json"), "utf8"))).toEqual({ next: 7 });
  });

  /** A damaged file must be an error, not a zero: zero silently re-mirrors the whole ledger. */
  it("refuses a corrupt file rather than reading it as zero", async () => {
    dir = mkdtempSync(join(tmpdir(), "abxfs-cur-"));
    const p = join(dir, "cursor.json");
    writeFileSync(p, "{not json");
    await expect(fileCursor(p).load()).rejects.toThrow();
  });

  it("treats a nonsense value as zero but a missing file as a fresh start", async () => {
    dir = mkdtempSync(join(tmpdir(), "abxfs-cur-"));
    const p = join(dir, "cursor.json");
    writeFileSync(p, JSON.stringify({ next: -3 }));
    expect(await fileCursor(p).load()).toBe(0);
  });
});

describe("runMirrorGenerations", () => {
  const OLD_HOOK = "0x00000000000000000000000000000000000000d1";
  const OLD_LENS = "0x00000000000000000000000000000000000000d2";

  /** Two ledgers, told apart by which lens is asked: the current factory's and an earlier one's. */
  function twoGenerations(current: AbxfsCid[], old: AbxfsCid[]): GatewayChain {
    const base = chainWith(current);
    return {
      ...base,
      contracts: {
        orgFactory: FACTORY,
        projectHook: HOOK,
        lens: LENS,
        previousGenerations: [{ orgFactory: "0x00000000000000000000000000000000000000d0", projectHook: OLD_HOOK, lens: OLD_LENS }],
      } as never,
      client: {
        async readContract(call: { address: string; functionName: string; args: readonly unknown[] }) {
          const ledger = call.address === OLD_HOOK || call.address === OLD_LENS ? old : current;
          return (chainWith(ledger).client as never as { readContract: (c: unknown) => Promise<unknown> }).readContract(call);
        },
      } as never,
    };
  }

  it("keeps pinning what an earlier factory's orgs publish, with a cursor per generation", async () => {
    const pinned: string[] = [];
    const cursors = new Map<string, ReturnType<typeof memoryCursor>>();
    const stats = await runMirrorGenerations({
      chain: twoGenerations([cid(1), cid(2)], [cid(3)]),
      provider: {} as never,
      once: true,
      pinRoot: async (c) => void pinned.push(c),
      cursorFor: (g) => {
        const c = memoryCursor();
        cursors.set(g.projectHook, c);
        return c;
      },
    });
    expect(pinned.sort()).toEqual([cid(1), cid(2), cid(3)].sort());
    expect(stats.pinned).toBe(3);
    expect(await cursors.get(HOOK)!.load()).toBe(2);
    expect(await cursors.get(OLD_HOOK)!.load()).toBe(1);
  });

  // Delta round 6, I-1: the bin's `--api-key` warning rides `onStart`, so it must follow every refusal and precede any read.
  it("calls onStart once, after its checks and before any generation reads; never when it refuses", async () => {
    const order: string[] = [];
    const chain = twoGenerations([cid(1)], [cid(2)]);
    const client = chain.client as never as { readContract: (c: unknown) => Promise<unknown> };
    const read = client.readContract;
    client.readContract = async (c) => {
      order.push("read");
      return read(c);
    };
    const stats = await runMirrorGenerations({
      chain,
      provider: {} as never,
      once: true,
      pinRoot: async () => {},
      cursorFor: () => memoryCursor(),
      onStart: () => void order.push("start"),
    });
    expect(stats.pinned).toBe(2);
    expect(order[0]).toBe("start");
    expect(order.filter((x) => x === "start")).toHaveLength(1);

    // No org layer (a chain whose factory is not deployed yet), and a generation with no lens: refused, never started.
    for (const contracts of [{}, { orgFactory: FACTORY, projectHook: HOOK }]) {
      let started = 0;
      await expect(
        runMirrorGenerations({ chain: { ...chain, contracts: contracts as never }, provider: {} as never, once: true, cursorFor: () => memoryCursor(), onStart: () => void started++ }),
      ).rejects.toThrow(/no org layer|no lens/);
      expect(started).toBe(0);
    }
  });
});
