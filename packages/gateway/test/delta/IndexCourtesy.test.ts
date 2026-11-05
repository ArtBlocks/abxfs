/**
 * DELTA AUDIT (freeze-1 -> freeze-2), M2: a bare `root:<D>` block on a DIRECTORY that has an `index.html` was served
 * through any wrapper directory (or a project publishing one) at `/<name>/`, because `locate` returned only the
 * `index.html` CID for the courtesy and the handler's served-CID pass checked that CID, never the directory it came
 * from. `locate` now hands back the directory with the file (`dirCid`), and the handler checks both, at no extra RPC.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ projectRoot: "" as string }));
vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
  return {
    ...real,
    isOrg: async () => true,
    readProject: async () => ({ cid: state.projectRoot, kind: real.ProjectKind.Directory, versionCount: 1, preferredGateway: null, owner: "0x0000000000000000000000000000000000000001" }),
  };
});

import { rootContentLabel, type AbxfsCid } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { denylistFilter } from "../../src/filters.js";
import { __resetResolveCaches, locate, resolveRoot } from "../../src/resolve.js";
import { rootSubject } from "../../src/subjects.js";
import type { Filter } from "../../src/types.js";
import { FakeChain } from "../fake-chain.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const PROJECT = `84532-${ORG.slice(2)}-7`;
const enc = (s: string) => new TextEncoder().encode(s);
beforeEach(() => __resetResolveCaches());

function setup(blocked: (ids: { I: string; D: string; W: string }) => string[] = () => []) {
  const fc = new FakeChain();
  const I = fc.addFile([enc("<h1>PHISHING SITE</h1>")], "text/html").cid;
  const D = fc.addDirectory([{ name: "index.html", cid: I, isDirectory: false }]);
  const W = fc.addDirectory([{ name: "site", cid: D, isDirectory: true }]); // one write, made by anyone
  const chain = {
    id: 84532,
    contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" },
    client: fc.client,
  };
  const calls: string[][] = [];
  const deny = denylistFilter(blocked({ I, D, W }));
  const filter: Filter = (ctx) => {
    calls.push(ctx.subjects);
    return deny(ctx);
  };
  const gw = createGateway({ chains: [chain as never], hostMode: { baseHost: BASE }, filter, onError: () => {} });
  const get = (label: string, path = "/") => gw(new Request(`https://${label}.${BASE}${path}`, { headers: { host: `${label}.${BASE}` } }));
  return { fc, chain, I, D, W, get, calls };
}

describe("M2: a bare directory block holds through a wrapper's index courtesy", () => {
  it("refuses the blocked directory's page at <chain>-<W>/site/ and through a project, as at its own root host", async () => {
    const { get, D, W } = setup(({ D }) => [rootSubject(D)]);
    expect((await get(rootContentLabel(84532, D))).status).toBe(451); // its own root host
    const wrapped = await get(rootContentLabel(84532, W), "/site/");
    expect(wrapped.status).toBe(451);
    expect(await wrapped.text()).not.toContain("PHISHING");
    state.projectRoot = W;
    const viaProject = await get(PROJECT, "/site/");
    expect(viaProject.status).toBe(451);
    expect(await viaProject.text()).not.toContain("PHISHING");
  });

  it("the redirect from /site to /site/ is refused too (it names the same directory)", async () => {
    const { get, W } = setup(({ D }) => [rootSubject(D)]);
    expect((await get(rootContentLabel(84532, W), "/site")).status).toBe(451);
  });

  it("an unblocked wrapper still serves, and the file named outright is a different subject (documented)", async () => {
    const { get, W } = setup(({ D }) => [rootSubject(D)]);
    // The file inside a blocked directory is its own CID: a bare directory block does not cover it by path. A list that
    // should cover it names it too.
    expect((await get(rootContentLabel(84532, W), "/site/index.html")).status).toBe(200);
    expect((await get(rootContentLabel(84532, W), "/")).status).toBe(200); // W's own listing names D and serves nothing of it
  });

  it("the filter sees [file, directory] for a courtesy, never the request's own root twice", async () => {
    const { get, I, D, W, calls } = setup();
    await get(rootContentLabel(84532, W), "/site/");
    expect(calls).toEqual([[rootSubject(W)], [rootSubject(W), rootSubject(I), rootSubject(D)]]);
    calls.length = 0;
    // The root's own courtesy: the directory IS the root, already checked, so only the file is added.
    await get(rootContentLabel(84532, D), "/");
    expect(calls).toEqual([[rootSubject(D)], [rootSubject(D), rootSubject(I)]]);
  });

  it("costs no extra RPC call", async () => {
    const plain = setup();
    plain.fc.reset();
    await plain.get(rootContentLabel(84532, plain.W), "/site/");
    const without = plain.fc.calls.length;
    const filtered = setup(() => [`root:0x${"ee".repeat(32)}`]);
    filtered.fc.reset();
    await filtered.get(rootContentLabel(84532, filtered.W), "/site/");
    expect(filtered.fc.calls.length).toBe(without);
  });

  it("`locate` carries the directory with the file, and caching stays keyed to the served file", async () => {
    const { chain, get, I, D, W } = setup();
    const resolved = await resolveRoot(chain as never, { kind: "cid", rootCid: W as AbxfsCid }, "site");
    expect(await locate(resolved)).toEqual({ type: "file", cid: I, path: "site/index.html", directory: true, dirCid: D });
    const root = await resolveRoot(chain as never, { kind: "cid", rootCid: D as AbxfsCid }, "");
    expect(await locate(root)).toEqual({ type: "file", cid: I, path: "index.html", dirCid: D });
    // D's own page is not D itself (it is I): short-lived, as before.
    expect((await get(rootContentLabel(84532, D))).headers.get("cache-control")).toContain("s-maxage=60");
  });
});
