/**
 * AUDIT 9, M1: a root block was matched EXACTLY. Content under a blocked root was served at its own root host, and a
 * blocked file was served by any directory (one SSTORE to make) or project that named it. The handler now runs the
 * filter once more with the CID it actually SERVES, and a root host never marks anything but the root itself
 * `immutable`, so that later block can still reach it.
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

import { rootContentLabel } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { denylistFilter } from "../../src/filters.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { rootSubject } from "../../src/subjects.js";
import type { Filter } from "../../src/types.js";
import { FakeChain } from "../fake-chain.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => __resetResolveCaches());

function setup(blocked: (ids: ReturnType<typeof tree>) => string[] = () => [], extra: Record<string, unknown> = {}) {
  const fc = new FakeChain();
  const ids = tree(fc);
  const calls: string[][] = [];
  const deny = denylistFilter(blocked(ids));
  const filter: Filter = (ctx) => {
    calls.push(ctx.subjects);
    return deny(ctx);
  };
  const chain = {
    id: 84532,
    contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" },
    client: fc.client,
  };
  const gw = createGateway({ chains: [chain as never], defaultChainId: 84532, hostMode: { baseHost: BASE }, filter, onError: () => {}, ...extra });
  const get = (label: string, path = "/", headers: Record<string, string> = {}) =>
    gw(new Request(`https://${label}.${BASE}${path}`, { headers: { host: `${label}.${BASE}`, ...headers } }));
  return { fc, ...ids, get, calls };
}

/**
 * ROOT/{index.html=F, sub/=D{secret.html=S}, site/=DI{index.html=P}}, and W, a wrapper anyone can make: a directory
 * naming the existing F. D has no `index.html` (a listing); DI has one (the index courtesy).
 */
function tree(fc: FakeChain) {
  const F = fc.addFile([enc("<h1>BLOCKED SITE INDEX</h1>")], "text/html").cid;
  const S = fc.addFile([enc("<h1>BLOCKED SECRET</h1>")], "text/html").cid;
  const P = fc.addFile([enc("<h1>BLOCKED SUBSITE</h1>")], "text/html").cid;
  const D = fc.addDirectory([{ name: "secret.html", cid: S, isDirectory: false }]);
  const DI = fc.addDirectory([{ name: "index.html", cid: P, isDirectory: false }]);
  const ROOT = fc.addDirectory([
    { name: "index.html", cid: F, isDirectory: false },
    { name: "site", cid: DI, isDirectory: true },
    { name: "sub", cid: D, isDirectory: true },
  ]);
  const W = fc.addDirectory([{ name: "index.html", cid: F, isDirectory: false }]);
  return { F, S, P, D, DI, ROOT, W };
}

const PROJECT = `84532-${ORG.slice(2)}-7`;

describe("M1: a blocked file is refused wherever it is served", () => {
  it("a blocked FILE served as a wrapper directory's index.html is a 451, at no chunk read", async () => {
    const { get, F, W, fc } = setup(({ F }) => [rootSubject(F)]);
    expect((await get(rootContentLabel(F))).status).toBe(451);
    fc.reset();
    const wrapped = await get(rootContentLabel(W));
    expect(wrapped.status).toBe(451);
    expect(await wrapped.text()).not.toContain("BLOCKED");
    expect(fc.count("multicall:read")).toBe(0);
  });

  it("…and through a project that publishes the wrapper", async () => {
    const { get, W } = setup(({ F }) => [rootSubject(F)]);
    state.projectRoot = W;
    const res = await get(PROJECT);
    expect(res.status).toBe(451);
    expect(await res.text()).not.toContain("BLOCKED");
  });

  it("…and by path under any root that holds it (c-<ROOT>/index.html)", async () => {
    const { get, ROOT } = setup(({ F }) => [rootSubject(F)]);
    expect((await get(rootContentLabel(ROOT), "/index.html")).status).toBe(451);
    // the rest of that root is still served
    expect((await get(rootContentLabel(ROOT), "/sub/secret.html")).status).toBe(200);
  });

  it("a blocked SUBDIRECTORY's listing is refused under any parent", async () => {
    const { get, ROOT, D } = setup(({ D }) => [rootSubject(D)]);
    expect((await get(rootContentLabel(D))).status).toBe(451);
    expect((await get(rootContentLabel(ROOT), "/sub/")).status).toBe(451);
    // a file inside it is a different CID: covered only if that CID is blocked too
    expect((await get(rootContentLabel(ROOT), "/sub/secret.html")).status).toBe(200);
  });

  it("a blocked SUBDIRECTORY's index courtesy is refused under any parent (delta audit M2)", async () => {
    // DI has an index.html, so `/site/` serves a FILE (P): the directory travels with it and is checked too.
    const { get, ROOT, DI } = setup(({ DI }) => [rootSubject(DI)]);
    expect((await get(rootContentLabel(DI))).status).toBe(451);
    const res = await get(rootContentLabel(ROOT), "/site/");
    expect(res.status).toBe(451);
    expect(await res.text()).not.toContain("BLOCKED");
    state.projectRoot = ROOT;
    expect((await get(PROJECT, "/site/")).status).toBe(451);
    // the file named outright is its own CID, as above
    expect((await get(rootContentLabel(ROOT), "/site/index.html")).status).toBe(200);
  });

  it("a directory root blocked WITH its descendants leaves nothing reachable", async () => {
    const { get, ROOT, D, S, F, W } = setup(({ ROOT, D, S, F }) => [ROOT, D, S, F].map(rootSubject));
    for (const [label, path] of [
      [ROOT, "/"],
      [ROOT, "/sub/secret.html"],
      [D, "/secret.html"],
      [D, "/"],
      [S, "/"],
      [F, "/"],
      [W, "/"],
    ] as const) {
      const res = await get(rootContentLabel(label), path);
      expect(res.status, `${label} ${path}`).toBe(451);
    }
  });

  it("asks the filter a third time only when the served CID is not the root, and with every subject so far", async () => {
    const { get, ROOT, F, S, calls } = setup();
    await get(rootContentLabel(F)); // a file root: serves itself
    expect(calls).toEqual([[rootSubject(F)]]);
    calls.length = 0;
    await get(rootContentLabel(ROOT), "/sub/secret.html");
    expect(calls).toEqual([[rootSubject(ROOT)], [rootSubject(ROOT), rootSubject(S)]]);
    calls.length = 0;
    state.projectRoot = ROOT;
    await get(PROJECT, "/");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual([`project:84532:${ORG}:7`, `org:84532:${ORG}`, rootSubject(ROOT), rootSubject(F)]);
  });

  it("the extra pass costs no RPC call", async () => {
    const plain = setup();
    plain.fc.reset();
    await plain.get(rootContentLabel(plain.ROOT), "/sub/secret.html");
    const without = plain.fc.calls.length;
    const filtered = setup(() => [`root:0x${"ee".repeat(32)}`]);
    filtered.fc.reset();
    await filtered.get(rootContentLabel(filtered.ROOT), "/sub/secret.html");
    expect(filtered.fc.calls.length).toBe(without);
  });
});

describe("M1: what a root host may cache forever", () => {
  it("the root itself (a file root, a directory root's own listing) is immutable", async () => {
    const { fc, get, F } = setup();
    expect((await get(rootContentLabel(F))).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const bare = fc.addDirectory([{ name: "a.txt", cid: F, isDirectory: false }]); // no index.html: its own listing
    expect((await get(rootContentLabel(bare))).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("anything else on a root host (index.html, a sub-path, a nested listing) is short-lived, never immutable", async () => {
    const { get, ROOT } = setup();
    for (const path of ["/", "/index.html", "/sub/", "/sub/secret.html"]) {
      const res = await get(rootContentLabel(ROOT), path);
      expect(res.status, path).toBe(200);
      const cc = res.headers.get("cache-control")!;
      expect(cc, path).not.toContain("immutable");
      expect(cc, path).toContain("s-maxage=60");
    }
  });

  it("a Range answer keeps the short policy (no-transform added, never immutable)", async () => {
    const { get, ROOT } = setup();
    const res = await get(rootContentLabel(ROOT), "/index.html", { range: "bytes=0-3" });
    expect(res.status).toBe(206);
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });

  it("`rootMaxAge` shortens the root's own lifetime, and validates", async () => {
    const { get, F, ROOT } = setup(() => [], { rootMaxAge: 120 });
    expect((await get(rootContentLabel(F))).headers.get("cache-control")).toBe("public, max-age=120, s-maxage=120");
    expect((await get(rootContentLabel(ROOT))).headers.get("cache-control")).toContain("s-maxage=60");
    const zero = setup(() => [], { rootMaxAge: 0 });
    expect((await zero.get(rootContentLabel(zero.F))).headers.get("cache-control")).toBe("no-cache");
    expect((await zero.get(rootContentLabel(zero.ROOT))).headers.get("cache-control")).toBe("no-cache");
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => setup(() => [], { rootMaxAge: bad }), String(bad)).toThrow(/rootMaxAge/);
  });
});
