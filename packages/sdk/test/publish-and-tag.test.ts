/**
 * Publish-and-tag (audit H3). One implementation, `publishRootAndTag`, serves the SDK draft path and
 * the CLI's `upload` and `update`. These tests pin the rule it exists for: a tag is written only
 * against a version whose recorded CID, read back, is the root just published, and a count that
 * cannot be read aborts BEFORE anything is sent.
 *
 * The earlier version of this file asserted the weaknesses (a stale count tagged the previous
 * version, an unreadable count defaulted to 0). It is replaced by the safe behaviour.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";

import { iProjectHookAbi } from "../src/abi-hook.js";
import { publishRootAndTag, resolvePublishedVersion } from "../src/publish.js";
import type { AbxfsCid } from "../src/index.js";

const HOOK = "0x00000000000000000000000000000000000000b2" as const;
const COLLECTION = "0x00000000000000000000000000000000000000c1" as const;
const ME = "0x00000000000000000000000000000000000a11ce" as const;
const OLD = ("0x" + "bb".repeat(32)) as AbxfsCid;
const NEW = ("0x" + "aa".repeat(32)) as AbxfsCid;
const FAST = { attempts: 3, delayMs: 0 };

function publishedLog(version: bigint, cid: AbxfsCid, tokenId = 5n) {
  const topics = encodeEventTopics({
    abi: iProjectHookAbi,
    eventName: "ProjectVersionPublished",
    args: { token: COLLECTION, tokenId, cid },
  });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "address" }], [version, 1, ME]);
  return { address: HOOK, topics, data, blockNumber: 1n, logIndex: 0, transactionIndex: 0, blockHash: "0x00", transactionHash: "0x00", removed: false };
}

interface World {
  /** versions as the TRUE chain holds them */
  chain: AbxfsCid[];
  /** reads return a stale chain (one publish behind) for this many calls after the publish */
  lagReads?: number;
  /** count reads throw */
  countThrows?: boolean;
  publishStatus?: "success" | "reverted";
  tagStatus?: "success" | "reverted";
  /** include the ProjectVersionPublished event in the publish receipt */
  withEvent?: boolean;
  /** what the event claims (default: true version) */
  eventVersion?: bigint;
  /** the publish never shows up in reads (permanent lag) */
  neverVisible?: boolean;
}

function world(w: World) {
  const sent: { fn: string; args: unknown[] }[] = [];
  let published = false;
  let readsSincePublish = 0;
  const view = (): AbxfsCid[] => {
    if (!published) return w.chain.slice(0, w.chain.length - 1);
    readsSincePublish++;
    if (w.neverVisible || readsSincePublish <= (w.lagReads ?? 0)) return w.chain.slice(0, w.chain.length - 1);
    return w.chain;
  };
  const publicClient = {
    async readContract(a: { functionName: string; args: unknown[] }) {
      if (a.functionName === "versionCount") {
        if (w.countThrows) throw new Error("rpc down");
        return BigInt(view().length);
      }
      if (a.functionName === "versionAt") {
        const v = Number(a.args[2]);
        const c = view()[v - 1];
        if (!c) throw new Error("InvalidVersion");
        return { cid: c, publishedAt: 0, publisher: ME };
      }
      throw new Error("unexpected " + a.functionName);
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      if (hash === "0xpublish") {
        const logs =
          w.withEvent === false
            ? []
            : [publishedLog(w.eventVersion ?? BigInt(w.chain.length), w.chain[w.chain.length - 1]!)];
        return { status: w.publishStatus ?? "success", logs };
      }
      return { status: w.tagStatus ?? "success", logs: [] };
    },
  };
  const walletClient = {
    account: { address: ME },
    chain: undefined,
    async writeContract(r: { functionName: string; args: unknown[] }) {
      sent.push({ fn: r.functionName, args: r.args });
      if (r.functionName === "configureTokenParam") {
        published = true;
        return "0xpublish";
      }
      return "0xtag";
    },
  };
  return { clients: { publicClient: publicClient as never, walletClient: walletClient as never }, sent };
}

const project = { collection: COLLECTION, hook: HOOK };

describe("publishRootAndTag", () => {
  it("tags the version named by the receipt's own event once a settled read confirms its CID", async () => {
    const w = world({ chain: [OLD, OLD.replace("bb", "cc") as AbxfsCid, NEW] });
    const out = await publishRootAndTag(w.clients, project, 5n, NEW, { tag: "release", settleOpts: FAST });
    expect(out.versionNumber).toBe(3n);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam", "setTag"]);
    expect(w.sent[1]!.args).toEqual([COLLECTION, 5n, "release", 3n]);
  });

  it("waits out a lagging replica instead of tagging the previous version (the original bug)", async () => {
    const w = world({ chain: [OLD, NEW], lagReads: 2 });
    const out = await publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST });
    expect(out.versionNumber).toBe(2n);
    expect(w.sent[1]!.args[3]).toBe(2n);
  });

  it("without an event in the receipt, finds the new CID by polling the history", async () => {
    const w = world({ chain: [OLD, NEW], withEvent: false, lagReads: 1 });
    const out = await publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST });
    expect(out.versionNumber).toBe(2n);
  });

  it("a receipt event naming the WRONG version is not trusted: nothing is tagged", async () => {
    const w = world({ chain: [OLD, NEW], eventVersion: 1n });
    await expect(
      publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST }),
    ).rejects.toThrow(/not newer|could not confirm/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]);
  });

  it("never tags when the new CID never becomes visible, and says so", async () => {
    const w = world({ chain: [OLD, NEW], neverVisible: true });
    await expect(
      publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST }),
    ).rejects.toThrow(/Nothing was tagged/);
    expect(w.sent.some((s) => s.fn === "setTag")).toBe(false);
  });

  it("aborts BEFORE publishing when the pre-publish count cannot be read (no default of 0)", async () => {
    const w = world({ chain: [OLD, NEW], countThrows: true });
    await expect(
      publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST }),
    ).rejects.toThrow(/refusing to publish blind/);
    expect(w.sent).toHaveLength(0);
  });

  it("a reverted publish throws and sends no tag", async () => {
    const w = world({ chain: [OLD, NEW], publishStatus: "reverted" });
    await expect(
      publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST }),
    ).rejects.toThrow(/reverted/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]);
  });

  it("a reverted setTag throws", async () => {
    const w = world({ chain: [OLD, NEW], tagStatus: "reverted" });
    await expect(
      publishRootAndTag(w.clients, project, 5n, NEW, { tag: "t", settleOpts: FAST }),
    ).rejects.toThrow(/setTag reverted/);
  });

  it("without a tag it publishes and proves the version, and sends nothing else", async () => {
    const w = world({ chain: [NEW] });
    const out = await publishRootAndTag(w.clients, project, 5n, NEW, { settleOpts: FAST });
    expect(out.versionNumber).toBe(1n);
    expect(out.tagTxHash).toBeUndefined();
    expect(w.sent).toHaveLength(1);
  });
});

describe("resolvePublishedVersion", () => {
  const base = { countBefore: 1n, rootCid: NEW, settleOpts: FAST };

  it("throws, rather than returning an unverified count, when no version carries the root", async () => {
    await expect(
      resolvePublishedVersion({ ...base, readCount: async () => 2n, readCid: async () => OLD }),
    ).rejects.toThrow(/could not confirm/);
  });

  it("throws when versionAt keeps failing (lagging replica)", async () => {
    await expect(
      resolvePublishedVersion({
        ...base,
        readCount: async () => 2n,
        readCid: async () => {
          throw new Error("replica lag");
        },
      }),
    ).rejects.toThrow(/could not confirm/);
  });

  it("a stale-low pre-publish count cannot make an old head look like the new version", async () => {
    // true pre-publish count was 3 but was read as 2; the replica still shows 3 versions after.
    await expect(
      resolvePublishedVersion({
        countBefore: 2n,
        rootCid: NEW,
        settleOpts: FAST,
        readCount: async () => 3n,
        readCid: async (n) => (n === 4n ? NEW : OLD),
      }),
    ).rejects.toThrow(/could not confirm/);
  });

  it("picks the newest version carrying the root", async () => {
    const v = await resolvePublishedVersion({
      ...base,
      countBefore: 0n,
      readCount: async () => 3n,
      readCid: async (n) => (n === 1n || n === 3n ? NEW : OLD),
    });
    expect(v).toBe(3n);
  });

  it("waits out a stale count", async () => {
    let calls = 0;
    const v = await resolvePublishedVersion({
      ...base,
      readCount: async () => (calls++ < 2 ? 1n : 2n),
      readCid: async () => NEW,
    });
    expect(v).toBe(2n);
  });
});
