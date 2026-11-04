/**
 * Round-2 audit: adversarial fakes against publishRootAndTag and the receipt handling of the
 * fire-and-forget client wrappers.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";

import { iProjectHookAbi } from "../../src/abi-hook.js";
import { publishRootAndTag } from "../../src/publish.js";
import { AbxfsClient } from "../../src/abxfs.js";
import type { AbxfsCid, ContractAddresses } from "../../src/index.js";

const HOOK = "0x00000000000000000000000000000000000000b2" as const;
const OTHERHOOK = "0x00000000000000000000000000000000000000b3" as const;
const COLLECTION = "0x00000000000000000000000000000000000000c1" as const;
const ME = "0x00000000000000000000000000000000000a11ce" as const;
const cid = (b: string) => ("0x" + b.repeat(32)) as AbxfsCid;
const X = cid("aa"), Y = cid("bb"), Z = cid("cc");
const FAST = { attempts: 3, delayMs: 0 };
const project = { collection: COLLECTION, hook: HOOK };

function log(version: bigint, c: AbxfsCid, o: { hook?: Hex; tokenId?: bigint; token?: Hex } = {}) {
  const topics = encodeEventTopics({
    abi: iProjectHookAbi,
    eventName: "ProjectVersionPublished",
    args: { token: o.token ?? COLLECTION, tokenId: o.tokenId ?? 5n, cid: c },
  });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "address" }], [version, 1, ME]);
  return { address: o.hook ?? HOOK, topics, data, blockNumber: 1n, logIndex: 0, transactionIndex: 0, blockHash: "0x00", transactionHash: "0x00", removed: false };
}

/** `before`: history before publish; `after`: history once visible. Reads are served by `serve()`. */
function mk(o: {
  before: AbxfsCid[];
  after: AbxfsCid[];
  logs: unknown[];
  /** history served to reads, indexed by call number since start; default: before until published, then after */
  serve?: (published: boolean, n: number) => AbxfsCid[];
  receiptStatus?: string;
}) {
  const sent: { fn: string; args: unknown[] }[] = [];
  let published = false;
  let n = 0;
  const view = () => (o.serve ? o.serve(published, n++) : published ? o.after : o.before);
  const publicClient = {
    async readContract(a: { functionName: string; args: unknown[] }) {
      if (a.functionName === "versionCount") return BigInt(view().length);
      if (a.functionName === "versionAt") {
        const c = view()[Number(a.args[2]) - 1];
        if (!c) throw new Error("InvalidVersion");
        return { cid: c, publishedAt: 0, publisher: ME };
      }
      throw new Error("unexpected " + a.functionName);
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return hash === ("0xpublish" as Hex) ? { status: o.receiptStatus ?? "success", logs: o.logs } : { status: "success", logs: [] };
    },
  };
  const walletClient = {
    account: { address: ME },
    async writeContract(r: { functionName: string; args: unknown[] }) {
      sent.push({ fn: r.functionName, args: r.args });
      if (r.functionName === "configureTokenParam") { published = true; return "0xpublish"; }
      return "0xtag";
    },
  };
  return { clients: { publicClient: publicClient as never, walletClient: walletClient as never }, sent };
}

describe("Audit2 publishRootAndTag", () => {
  it("ignores events from another hook / another token / another tokenId", async () => {
    const w = mk({
      before: [X, Y], after: [X, Y, X],
      logs: [log(1n, X, { hook: OTHERHOOK }), log(1n, X, { tokenId: 6n }), log(1n, X, { token: OTHERHOOK })],
    });
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST });
    // falls back to history scan, newest first
    expect(out.versionNumber).toBe(3n);
    expect(w.sent[1]!.args[3]).toBe(3n);
  });

  it("duplicate events in one receipt: last matching one is used and is verified", async () => {
    const w = mk({ before: [Y], after: [Y, X], logs: [log(1n, X), log(2n, X)] });
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST });
    expect(out.versionNumber).toBe(2n);
  });

  it("an event naming an older identical-root version is REFUSED (the version must be newer than the count before the publish)", async () => {
    // history X(1) Y(2) X(3); a hostile receipt claims version 1. It used to tag v1 because the CID matched.
    const w = mk({ before: [X, Y], after: [X, Y, X], logs: [log(1n, X)] });
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).rejects.toThrow(/not newer/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]); // published, never tagged
  });

  it("an event at exactly countBefore is refused; countBefore + 1 is accepted", async () => {
    const bad = mk({ before: [X, Y], after: [X, Y, X], logs: [log(2n, X)] });
    await expect(publishRootAndTag(bad.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).rejects.toThrow(/not newer/);
    const ok = mk({ before: [X, Y], after: [X, Y, X], logs: [log(3n, X)] });
    expect((await publishRootAndTag(ok.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).versionNumber).toBe(3n);
  });

  it("ACCEPTED (low): no event + stale countBefore=0 + lagging post-publish replica: tags an OLD version with the same root", async () => {
    // Accepted: needs a receipt with no event AND a replica that is two publishes behind on BOTH reads. The
    // tag still points at bytes identical to what was published, so the label is not wrong about content.
    // True history X(1) Y(2); publish X again -> v3. countBefore read from a replica that saw nothing (0);
    // after the publish the replica shows [X, Y] (still lagging). Newest-first scan finds v1.
    const w = mk({
      before: [X, Y], after: [X, Y, X], logs: [],
      serve: (published, n) => (n === 0 ? [] : published && n > 4 ? [X, Y, X] : [X, Y]),
    });
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: { attempts: 3, delayMs: 0 } });
    expect(out.versionNumber).toBe(1n); // WRONG VERSION (same bytes); low severity, needs 2-publish lag + no event
  });

  it("cancel/replacement receipt (success, no logs, no new version): nothing is tagged", async () => {
    const w = mk({ before: [Y], after: [Y], logs: [] });
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).rejects.toThrow(/could not confirm/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]);
  });

  it("reverted publish: throws before any tag", async () => {
    const w = mk({ before: [Y], after: [Y, X], logs: [log(2n, X)], receiptStatus: "reverted" });
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).rejects.toThrow(/reverted/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]);
  });

  it("receipt.status undefined/odd strings are failures", async () => {
    for (const s of ["", "0x0", "SUCCESS"]) {
      const w = mk({ before: [Y], after: [Y, X], logs: [log(2n, X)], receiptStatus: s });
      await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST })).rejects.toThrow();
    }
  });

  it("two racing publishes from one account (other tab publishes Z between): each tags its own version", async () => {
    const w = mk({ before: [Y], after: [Y, X, Z], logs: [], serve: (p) => (p ? [Y, X, Z] : [Y]) });
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "t", settleOpts: FAST });
    expect(out.versionNumber).toBe(2n);
  });

  it("an invalid tag is refused BEFORE the publish is sent", async () => {
    const w = mk({ before: [Y], after: [Y, X], logs: [log(2n, X)] });
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "BAD TAG!!", settleOpts: FAST })).rejects.toThrow(/invalid tag/);
    expect(w.sent).toEqual([]); // nothing was sent, so nothing was paid for
  });
});

describe("Audit2 every AbxfsClient write waits for its receipt and throws when it reverted", () => {
  const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
  const addresses = { projectHook: HOOK, orgFactory: FACTORY, collection: COLLECTION, org: COLLECTION } as unknown as ContractAddresses;
  const OTHER = "0x00000000000000000000000000000000000b0b0b";

  function build(status: "success" | "reverted") {
    let receiptReads = 0;
    const publicClient = {
      async waitForTransactionReceipt() { receiptReads++; return { status, logs: [] }; },
      async readContract() { throw new Error("not needed"); },
    };
    const walletClient = { account: { address: ME }, chain: undefined, async writeContract() { return "0x" + "11".repeat(32); } };
    const c = new AbxfsClient({ publicClient: publicClient as never, walletClient: walletClient as never, addresses, org: COLLECTION });
    return { c, reads: () => receiptReads };
  }
  const writes: Record<string, (c: AbxfsClient) => Promise<unknown>> = {
    setTag: (c) => c.setTag(5n, "t", 1),
    removeTag: (c) => c.removeTag(5n, "t"),
    transferProject: (c) => c.transferProject(5n, OTHER as never),
    setProjectName: (c) => c.setProjectName(5n, "n"),
    setViewUrl: (c) => c.setViewUrl(5n, "https://example.com/x"),
    setPreferredGateway: (c) => c.setPreferredGateway(5n, "https://ipfs.example.com/ipfs/"),
    publishVersion: (c) => c.publishVersion(5n, X),
    transferAdmin: (c) => c.transferAdmin(OTHER as never),
    acceptAdmin: (c) => c.acceptAdmin(),
    setOpen: (c) => c.setOpen(true),
  };

  for (const [name, call] of Object.entries(writes)) {
    it(`${name}: throws when the mined transaction reverted`, async () => {
      const { c, reads } = build("reverted");
      await expect(call(c)).rejects.toThrow(/reverted on chain/);
      expect(reads()).toBe(1);
    });
    it(`${name}: resolves the hash only after a successful receipt`, async () => {
      const { c, reads } = build("success");
      await expect(call(c)).resolves.toBe("0x" + "11".repeat(32));
      expect(reads()).toBe(1);
    });
  }
});

describe("Audit2 resolvePublishedVersion scan bound", () => {
  it("hostile RPC with huge count and no event: the scan is capped per attempt", async () => {
    const { resolvePublishedVersion, MAX_FALLBACK_SCAN } = await import("../../src/publish.js");
    let reads = 0;
    await expect(
      resolvePublishedVersion({
        countBefore: 1n, rootCid: X, receiptVersion: undefined,
        readCount: async () => 200_000n,
        readCid: async () => { reads++; return Z; },
        settleOpts: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow();
    expect(reads).toBeLessThanOrEqual(MAX_FALLBACK_SCAN);
  });
});
