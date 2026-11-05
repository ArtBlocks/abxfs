/**
 * DELTA AUDIT L9: the gateway refuses a blocked CID wherever it is served, but the mirror asked its filter about the
 * published ROOT only, so a wrapper directory W = {F} around a blocked file F was pinned to IPFS. `assessRoot` now asks
 * the filter about `root:<cid>` of every CID the tree lists (no extra RPC: the listing names them), together with the
 * entry's own subjects, and the mirror skips a root that holds a blocked CID.
 */
import { describe, expect, it } from "vitest";
import { ProjectKind, type AbxfsCid } from "@artblocks/abxfs-sdk";

import { allowlistFilter, denylistFilter } from "../../src/filters.js";
import { RootContainsBlockedError, assessRoot, memoryCursor, runMirror, type TreeFilter } from "../../src/mirror.js";
import { orgSubject, projectSubject, rootSubject } from "../../src/subjects.js";
import type { Filter, GatewayChain } from "../../src/types.js";
import { FakeChain } from "../fake-chain.js";

const ORG = "0x00000000000000000000000000000000000000a1" as const;
const FACTORY = "0x00000000000000000000000000000000000000c0";
const HOOK = "0x00000000000000000000000000000000000000c1";
const LENS = "0x00000000000000000000000000000000000000c2";
const enc = (s: string) => new TextEncoder().encode(s);
const fast = { backoffMs: () => 0, pollMs: 1 };

/** The fake stores, plus a ledger in which entry i is token i publishing ledger[i]. */
function world() {
  const fc = new FakeChain();
  const F = fc.addFile([enc("blocked bytes")], "text/html").cid;
  const G = fc.addFile([enc("fine bytes")], "text/html").cid;
  const W = fc.addDirectory([{ name: "index.html", cid: F, isDirectory: false }]);
  const NESTED = fc.addDirectory([{ name: "deep", cid: W, isDirectory: true }]);
  const OK = fc.addDirectory([{ name: "index.html", cid: G, isDirectory: false }]);
  const chainFor = (ledger: AbxfsCid[]): GatewayChain => {
    const inner = fc.client as unknown as {
      readContract: (p: { address: string; functionName: string; args: readonly unknown[] }) => Promise<unknown>;
      simulateContract: unknown;
    };
    return {
      id: 84532,
      contracts: { ...(fc.contracts as object), orgFactory: FACTORY, projectHook: HOOK, lens: LENS } as never,
      client: {
        async readContract(p: { address: string; functionName: string; args: readonly unknown[] }) {
          if (p.functionName === "globalPublishCount") return BigInt(ledger.length);
          if (p.functionName === "publishRange") {
            const [start, count] = p.args as [bigint, bigint];
            return ledger.slice(Number(start), Number(start + count)).map((c, k) => ({
              org: ORG,
              record: { cid: c, publisher: ORG, publishedAt: 1, version: 1, tokenId: BigInt(Number(start) + k) },
            }));
          }
          return inner.readContract(p);
        },
        simulateContract: inner.simulateContract,
      } as never,
    };
  };
  return { fc, F, G, W, NESTED, OK, chainFor };
}

describe("L9: the mirror skips a root that holds a blocked CID", () => {
  it("a mirror run with root:F denied skips W = {F}, at any depth, and pins nothing of it", async () => {
    const { F, W, NESTED, chainFor } = world();
    const logs: string[] = [];
    const stats = await runMirror({
      chain: chainFor([W, NESTED]),
      provider: {} as never, // never reached: the tree check refuses first
      cursor: memoryCursor(),
      once: true,
      filter: denylistFilter([rootSubject(F)]),
      log: (l) => logs.push(l),
      ...fast,
    });
    expect(stats).toEqual({ pinned: 0, skipped: 2, next: 2 });
    expect(logs.filter((l) => l.startsWith("skip (it holds a CID the filter refuses"))).toHaveLength(2);
  });

  it("a replacement pinRoot is handed the same tree filter, and a clean tree is pinned", async () => {
    const { F, OK, W, chainFor } = world();
    const chain = chainFor([OK, W]);
    const pinned: string[] = [];
    const filter = denylistFilter([rootSubject(F)]);
    const stats = await runMirror({
      chain,
      provider: {} as never,
      cursor: memoryCursor(),
      once: true,
      filter,
      pinRoot: async (cid, treeFilter) => {
        expect(treeFilter?.filter).toBe(filter);
        await assessRoot(chain, cid, ProjectKind.Directory, {}, treeFilter);
        pinned.push(cid);
      },
      ...fast,
    });
    expect(pinned).toEqual([OK]);
    expect(stats).toEqual({ pinned: 1, skipped: 1, next: 2 });
  });

  it("assessRoot sends the entry's subjects with the tree's CIDs, so an allowlist that admitted the entry admits its tree", async () => {
    const { F, G, OK, W, chainFor } = world();
    const chain = chainFor([]);
    const entry = [projectSubject(84532, ORG, 0), orgSubject(84532, ORG), rootSubject(OK)];
    const seen: string[][] = [];
    const spy = (inner: Filter): Filter => (ctx) => {
      seen.push(ctx.subjects);
      return inner(ctx);
    };
    // An allowlist of the project alone: every inner CID is unlisted, and still the tree is admitted.
    const allowed: TreeFilter = { filter: spy(allowlistFilter([entry[0]!])), subjects: entry };
    await expect(assessRoot(chain, OK, ProjectKind.Directory, {}, allowed)).resolves.toMatchObject({ files: 1 });
    expect(seen).toEqual([[...entry, rootSubject(G)]]);
    // A denylist naming an inner CID refuses it.
    const denied: TreeFilter = { filter: denylistFilter([rootSubject(F)]), subjects: [rootSubject(W)] };
    await expect(assessRoot(chain, W, ProjectKind.Directory, {}, denied)).rejects.toBeInstanceOf(RootContainsBlockedError);
    // No filter: the walk is what it was.
    await expect(assessRoot(chain, W, ProjectKind.Directory)).resolves.toMatchObject({ files: 1 });
  });

  it("the tree check reads nothing extra from the chain", async () => {
    const { fc, OK, chainFor } = world();
    const chain = chainFor([]);
    fc.reset();
    await assessRoot(chain, OK, ProjectKind.Directory);
    const without = fc.calls.length;
    fc.reset();
    await assessRoot(chain, OK, ProjectKind.Directory, {}, { filter: denylistFilter([]), subjects: [] });
    expect(fc.calls.length).toBe(without);
  });
});
