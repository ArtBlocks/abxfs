/**
 * Paths deeper than one `resolvePath` call allows.
 *
 * Both directory stores revert `PathTooDeep` on the 33rd segment of a single call, but directories nest to any depth,
 * so a file 40 levels down uploads fine. The fake chain enforces that cap exactly as the contracts do; the gateway
 * resolves through the SDK, which chains calls of at most 32 segments, up to 256 segments (8 calls) per resolution.
 * Past that, and for a file mid-path, the answer is the same 404 as any other path that names nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asAbxfsCid, rootContentLabel, type AbxfsCid, type DirectoryEntry } from "@abxfs/sdk";

import { createGateway } from "../src/handler.js";
import { __resetResolveCaches } from "../src/resolve.js";
import { DIR, FakeChain, MAX_PATH_DEPTH } from "./fake-chain.js";

const BASE = "content.example";
const te = (s: string) => new TextEncoder().encode(s);

let chain: FakeChain;
beforeEach(() => {
  __resetResolveCaches();
  chain = new FakeChain();
});

function gateway() {
  const gw = createGateway({
    chains: [{ id: 84532, contracts: chain.contracts, client: chain.client }],
    hostMode: { baseHost: BASE },
    onError: () => {},
  });
  return (root: AbxfsCid, path: string) => {
    const host = `${rootContentLabel(84532, asAbxfsCid(root))}.${BASE}`;
    return gw(new Request(`http://${host}${path}`, { headers: { host } }));
  };
}

const file = (name: string, cid: AbxfsCid): DirectoryEntry => ({ name, cid, isDirectory: false });
const dir = (name: string, cid: AbxfsCid): DirectoryEntry => ({ name, cid, isDirectory: true });

/**
 * `d1/d2/…/d{n-1}/f.txt`: a file at segment `n`. `fileAt` puts a FILE named `d{k}` at segment k instead of the
 * directory, so the path descends into a file there. `index` adds an index.html to the deepest directory.
 */
function deepTree(n: number, opts: { fileAt?: number; index?: boolean } = {}): { root: AbxfsCid; url: string } {
  const addFile = (body: string, mime = "text/plain") => chain.addFile([te(body)], mime).cid;
  const addDir = (entries: DirectoryEntry[]) => chain.addDirectory(entries);

  const leafEntries = [file("f.txt", addFile(`depth ${n}`))];
  if (opts.index) leafEntries.push(file("index.html", addFile("<p>deep index</p>", "text/html")));
  let cur = addDir(leafEntries);
  for (let k = n - 1; k >= 1; k--) {
    const entry = opts.fileAt === k ? file(`d${k}`, addFile("not a directory")) : dir(`d${k}`, cur);
    cur = addDir([entry]);
  }
  const segs = Array.from({ length: n - 1 }, (_, i) => `d${i + 1}`);
  return { root: cur, url: `/${[...segs, "f.txt"].join("/")}` };
}

describe("the fake chain is honest about the per-call cap", () => {
  it("one resolvePath call of 33 segments reverts PathTooDeep; 32 resolve", async () => {
    const { root, url } = deepTree(33);
    const path = url.slice(1);
    const call = (p: string) =>
      (chain.client as { readContract: (a: unknown) => Promise<unknown> }).readContract({ address: DIR, functionName: "resolvePath", args: [root, p] });
    await expect(call(path)).rejects.toMatchObject({ details: "PathTooDeep" });
    await expect(call(path.split("/").slice(0, MAX_PATH_DEPTH).join("/"))).resolves.toBeDefined();
  });
});

describe("deep paths through the gateway", () => {
  for (const [n, calls] of [
    [32, 1],
    [33, 2],
    [64, 2],
    [70, 3],
  ] as const) {
    it(`a file at segment ${n} is served with ${calls} resolvePath call(s)`, async () => {
      const { root, url } = deepTree(n);
      const res = await gateway()(root, url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`depth ${n}`);
      expect(chain.count("resolvePath", DIR)).toBe(calls);
    });
  }

  it("a directory 40 deep redirects to its slash form, then serves its index.html", async () => {
    const { root, url } = deepTree(41, { index: true });
    const dirUrl = url.slice(0, url.lastIndexOf("/")); // `/d1/…/d40`
    const get = gateway();
    const redirect = await get(root, dirUrl);
    expect(redirect.status).toBe(307);
    const res = await get(root, `${dirUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>deep index</p>");
  });

  it("descending into a file mid-path is a 404, whether the file ends a call's run or sits inside one", async () => {
    for (const fileAt of [32, 40]) {
      __resetResolveCaches();
      const { root, url } = deepTree(70, { fileAt });
      expect((await gateway()(root, url)).status).toBe(404);
    }
  });

  it("a name missing at segment 40 is a 404, not a 502", async () => {
    const { root, url } = deepTree(70);
    const segs = url.slice(1).split("/");
    segs[39] = "nope";
    const res = await gateway()(root, `/${segs.join("/")}`);
    expect(res.status).toBe(404);
    expect(chain.count("resolvePath", DIR)).toBe(2);
  });

  it("256 segments resolve in 8 calls; 257 are a 404 without a single resolvePath call", async () => {
    const ok = deepTree(256);
    const res = await gateway()(ok.root, ok.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("depth 256");
    expect(chain.count("resolvePath", DIR)).toBe(8);

    chain.reset();
    const tooDeep = deepTree(257);
    const refused = await gateway()(tooDeep.root, tooDeep.url);
    expect(refused.status).toBe(404);
    expect(chain.count("resolvePath")).toBe(0);
  });
});
