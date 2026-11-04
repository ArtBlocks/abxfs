/** Round-3: publishRootAndTag under concurrency / reorg with a mutable shared history. */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { iProjectHookAbi } from "../../src/abi-hook.js";
import { publishRootAndTag } from "../../src/publish.js";
import type { AbxfsCid } from "../../src/index.js";

const HOOK = "0x00000000000000000000000000000000000000b2" as const;
const COLLECTION = "0x00000000000000000000000000000000000000c1" as const;
const ME = "0x00000000000000000000000000000000000a11ce" as const;
const cid = (b: string) => ("0x" + b.repeat(32)) as AbxfsCid;
const X = cid("aa"), Y = cid("bb"), Z = cid("cc");
const FAST = { attempts: 3, delayMs: 0 };
const project = { collection: COLLECTION, hook: HOOK };

function evt(version: bigint, c: AbxfsCid) {
  return {
    address: HOOK,
    topics: encodeEventTopics({ abi: iProjectHookAbi, eventName: "ProjectVersionPublished", args: { token: COLLECTION, tokenId: 5n, cid: c } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }, { type: "address" }], [version, 1, ME]),
    blockNumber: 1n, logIndex: 0, transactionIndex: 0, blockHash: "0x00", transactionHash: "0x00", removed: false,
  };
}

/** A real mutable history. `onPublish` lets another device publish before/after ours lands. */
function chain(initial: AbxfsCid[], o: { staleCountBefore?: bigint; beforeOurs?: AbxfsCid[]; omitEvent?: boolean } = {}) {
  const hist = [...initial];
  const sent: { fn: string; args: unknown[] }[] = [];
  let reads = 0;
  const publicClient = {
    async readContract(a: { functionName: string; args: unknown[] }) {
      if (a.functionName === "versionCount") {
        reads++;
        if (reads === 1 && o.staleCountBefore !== undefined) return o.staleCountBefore;
        return BigInt(hist.length);
      }
      if (a.functionName === "versionAt") {
        const c = hist[Number(a.args[2]) - 1];
        if (!c) throw new Error("InvalidVersion");
        return { cid: c, publishedAt: 0, publisher: ME };
      }
      throw new Error("unexpected " + a.functionName);
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      return hash === ("0xpub" as Hex) ? { status: "success", logs: o.omitEvent ? [] : [evt(BigInt(ourVersion), ourCid)] } : { status: "success", logs: [] };
    },
  };
  let ourVersion = 0; let ourCid = X;
  const walletClient = {
    account: { address: ME },
    async writeContract(r: { functionName: string; args: unknown[] }) {
      sent.push({ fn: r.functionName, args: r.args });
      if (r.functionName === "configureTokenParam") {
        for (const c of o.beforeOurs ?? []) hist.push(c); // another device wins the race
        ourCid = (r.args as any)[2]?.[0]?.data ?? X;
        hist.push(CUR); ourVersion = hist.length; return "0xpub";
      }
      return "0xtag";
    },
  };
  let CUR: AbxfsCid = X;
  return { clients: { publicClient: publicClient as never, walletClient: walletClient as never }, hist, sent, setCur: (c: AbxfsCid) => { CUR = c; ourCid = c; } };
}

describe("Audit3 publishRootAndTag", () => {
  it("HAPPY: tags exactly the new version", async () => {
    const w = chain([Y]); w.setCur(X);
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "v1", settleOpts: FAST });
    expect(out.versionNumber).toBe(2n);
    expect(w.sent[1]!.args[3]).toBe(2n);
  });
  it("CONCURRENT: another device publishes between our countBefore read and our publish -> still tags OUR version", async () => {
    const w = chain([Y], { beforeOurs: [Z] }); w.setCur(X);
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "v1", settleOpts: FAST });
    expect(out.versionNumber).toBe(3n); // Y, Z, X
    expect(w.sent[1]!.args[3]).toBe(3n);
  });
  it("CONCURRENT, no event in receipt: fallback scan still finds ours", async () => {
    const w = chain([Y], { beforeOurs: [Z], omitEvent: true }); w.setCur(X);
    const out = await publishRootAndTag(w.clients, project, 5n, X, { tag: "v1", settleOpts: FAST });
    expect(out.versionNumber).toBe(3n);
  });
  it("REORG/AHEAD-REPLICA: countBefore read from a replica ahead of the chain -> publish PAID, then refused to tag (false negative)", async () => {
    // true history length 1; the count read came from an unsafe head that had 2 (later reorged out)
    const w = chain([Y], { staleCountBefore: 2n }); w.setCur(X);
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "v1", settleOpts: FAST })).rejects.toThrow(/not newer/);
    expect(w.sent.map((s) => s.fn)).toEqual(["configureTokenParam"]); // paid, published, untagged
    expect(w.hist).toEqual([Y, X]);
  });
  it("invalid tag: refused before ANY write (SDK) -- but the CLI/web upload paths reach this only after content upload", async () => {
    const w = chain([Y]); w.setCur(X);
    await expect(publishRootAndTag(w.clients, project, 5n, X, { tag: "Bad Tag", settleOpts: FAST })).rejects.toThrow(/invalid tag/);
    expect(w.sent).toEqual([]);
  });
});
