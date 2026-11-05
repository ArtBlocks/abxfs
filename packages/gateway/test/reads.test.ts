/**
 * ABX FS content through the gateway handler, against an in-memory deployment that counts every call (see
 * `fake-chain.ts`). The SDK readers run for real; only the RPC is fake. What is pinned here is what a request costs:
 * a path is found with a lookup, never by listing; a range reads the chunks it needs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asAbxfsCid, rootContentLabel, type AbxfsCid, type DirectoryEntry } from "@abxfs/sdk";

import { createGateway, rangeSpecOf } from "../src/handler.js";
import { __resetResolveCaches, chunkBudget } from "../src/resolve.js";
import { DIR, FILE, FakeChain, chunkBytes } from "./fake-chain.js";

const BASE = "content.example";
const te = (s: string) => new TextEncoder().encode(s);

let chain: FakeChain;
beforeEach(() => {
  __resetResolveCaches();
  chain = new FakeChain();
});

function gateway(extra: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const gw = createGateway({
    chains: [{ id: 84532, contracts: chain.contracts, client: chain.client }],
    hostMode: { baseHost: BASE },
    onError: () => {},
    ...extra,
  });
  return (root: AbxfsCid, path = "/", headers: Record<string, string> = {}, method = "GET") => {
    const host = hostOf(root);
    return gw(new Request(`http://${host}${path}`, { method, headers: { host, ...headers } }));
  };
}

const hostOf = (root: AbxfsCid) => `${rootContentLabel(84532, asAbxfsCid(root))}.${BASE}`;
const file = (name: string, cid: AbxfsCid): DirectoryEntry => ({ name, cid, isDirectory: false });
const dir = (name: string, cid: AbxfsCid): DirectoryEntry => ({ name, cid, isDirectory: true });

describe("a small tree", () => {
  it("serves index.html at the root and a file by path", async () => {
    const index = chain.addFile([te("<h1>hi</h1>")], "text/html").cid;
    const note = chain.addFile([te("hello "), te("world")], "text/plain").cid;
    const root = chain.addDirectory([file("index.html", index), file("note.txt", note)]);
    const get = gateway();

    const home = await get(root);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toBe("text/html");
    expect(await home.text()).toBe("<h1>hi</h1>");

    const n = await get(root, "/note.txt");
    expect(n.status).toBe(200);
    expect(await n.text()).toBe("hello world");
    expect(n.headers.get("etag")).toBe(`"${root}:note.txt"`);

    expect(chain.count("getFileInfo", FILE)).toBeGreaterThan(0);
    expect(chain.count("resolvePath", DIR)).toBeGreaterThan(0);
  });

  it("a root that is a FILE is served whole", async () => {
    const { cid } = chain.addFile([te("abc"), te("def")], "text/plain");
    const res = await gateway()(cid);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abcdef");
  });

  it("a v2 directory with no index.html is listed, one page of entries", async () => {
    const f = chain.addFile([te("x")]).cid;
    const root = chain.addDirectory([file("<b>.txt", f), dir("sub", chain.addDirectory([file("y", f)]))]);
    const res = await gateway()(root);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("&lt;b&gt;.txt");
    expect(html).toContain(`href="//${hostOf(root)}/sub/"`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("a listing's links name the host and directory that served it, so a copy of the page elsewhere still leads here", async () => {
    // OpenSea shows `animation_url` as a copy saved to its own storage: a bare-relative `y` there named a file on its
    // host, and every click in its viewer was that host's "Access Denied".
    const f = chain.addFile([te("x")]).cid;
    const root = chain.addDirectory([file("top.txt", f), dir("it's", chain.addDirectory([file("y", f)]))]);
    const get = gateway();
    const host = hostOf(root);

    const top = await (await get(root)).text();
    expect(top).toContain(`href="//${host}/top.txt"`);
    expect(top).toContain(`href="//${host}/it's/"`);
    const sub = await (await get(root, "/it's/")).text();
    expect(sub).toContain(`href="//${host}/it&#39;s/y"`);
    for (const html of [top, sub]) expect(html.match(/href="(?!\/\/)/g)).toBeNull();
  });
});

describe("a nested path", () => {
  it("resolves a/b/c with one path lookup and serves the file; a missing path is a 404, not a 502", async () => {
    const leaf = chain.addFile([te("deep")]).cid;
    const b = chain.addDirectory([file("c.txt", leaf)]);
    const a = chain.addDirectory([dir("b", b)]);
    const root = chain.addDirectory([dir("a", a)]);
    const get = gateway();

    const ok = await get(root, "/a/b/c.txt");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("deep");
    expect(chain.count("resolvePath", DIR)).toBe(1);

    const missing = await get(root, "/a/b/nope.txt");
    expect(missing.status).toBe(404);
    const missingDir = await get(root, "/zzz/x");
    expect(missingDir.status).toBe(404);
  });

  it("a directory URL is redirected to its slash form and served as its index.html", async () => {
    const index = chain.addFile([te("nested index")], "text/html").cid;
    const sub = chain.addDirectory([file("index.html", index)]);
    const root = chain.addDirectory([dir("docs", sub)]);
    const get = gateway();
    const redirect = await get(root, "/docs");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/docs/");
    expect(await (await get(root, "/docs/")).text()).toBe("nested index");
  });
});

describe("a 1,000-entry directory", () => {
  const N = 1_000;
  const name = (i: number) => `f${String(i).padStart(4, "0")}.txt`;
  function build() {
    const bodies = new Map<number, AbxfsCid>();
    const entries: DirectoryEntry[] = [];
    for (let i = 0; i < N; i++) {
      // A handful of distinct files is enough: the point is the directory's size, not 1,000 chunks.
      const key = i % 5;
      if (!bodies.has(key)) bodies.set(key, chain.addFile([te(`body ${key}`)]).cid);
      entries.push(file(name(i), bodies.get(key)!));
    }
    return chain.addDirectory(entries);
  }

  it("finds one file by path in a bounded number of calls, never listing the directory", async () => {
    const root = build();
    chain.reset();
    const res = await gateway()(root, `/${name(777)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("body 2");
    expect(chain.count("getEntries")).toBe(0);
    expect(chain.count("entryCount")).toBe(0);
    expect(chain.count("listDirectory")).toBe(0);
    // 4 existence probes (the batched layer probe), one path lookup, file info, one hash page, one chunk bundle.
    expect(chain.calls.length).toBeLessThanOrEqual(12);
    // And the same cost at the other end of the directory: the call count does not depend on where the name sorts.
    chain.reset();
    expect((await gateway()(root, `/${name(0)}`)).status).toBe(200);
    expect(chain.calls.length).toBeLessThanOrEqual(12);
    expect(chain.count("getEntries")).toBe(0);
  });

  it("a repeat request for the same root does not probe the layer again", async () => {
    const root = build();
    const get = gateway();
    await get(root, `/${name(1)}`);
    const first = chain.count("directoryExists") + chain.count("fileExists");
    chain.reset();
    await get(root, `/${name(2)}`);
    expect(first).toBeGreaterThan(0);
    expect(chain.count("directoryExists") + chain.count("fileExists")).toBe(0);
  });

  it("lists it 100 entries at a time with a cursor, one page read per request", async () => {
    const root = build();
    const get = gateway();
    chain.reset();
    const first = await get(root, "/");
    const html = await first.text();
    expect(first.status).toBe(200);
    expect(html).toContain("1-100 of 1000");
    expect(html).toContain(name(0));
    expect(html).not.toContain(name(100));
    expect(html).toContain(`href="//${hostOf(root)}/?start=100"`);
    expect(chain.count("getEntries")).toBe(1);

    const last = await (await get(root, "/?start=900")).text();
    expect(last).toContain("901-1000 of 1000");
    expect(last).toContain(name(999));
    expect(last).toContain(`href="//${hostOf(root)}/?start=800"`);
    expect(last).not.toContain("next</a>");

    // A second spelling of an index is not honoured (it reads as the first page), and a page has its own ETag.
    const odd = await (await get(root, "/?start=0100")).text();
    expect(odd).toContain("1-100 of 1000");
    const page = await get(root, "/?start=100");
    expect(page.headers.get("etag")).toContain(":s100");
  });
});

describe("a two-level file and Range", () => {
  const CHUNK = 12_300; // about the chunker's minimum, so the gateway's bundle estimate holds
  const COUNT = 800; // more than 750 hashes: the chunk tree has a branch level
  let root: AbxfsCid;
  const at = (offset: number) => chunkBytes(Math.floor(offset / CHUNK), CHUNK)[offset % CHUNK]!;

  beforeEach(() => {
    const chunks = Array.from({ length: COUNT }, (_, i) => chunkBytes(i, CHUNK));
    const added = chain.addFile(chunks, "video/mp4");
    expect(added.rootLevel).toBe(1);
    root = added.cid;
  });

  it("serves the whole file, paging its 800 chunk hashes (8 pages), when it is under the cap", async () => {
    const res = await gateway({ maxFileBytes: 16 * 1024 * 1024 })(root);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(CHUNK * COUNT);
    expect(bytes[CHUNK * 500 + 3]).toBe(at(CHUNK * 500 + 3));
    expect(chain.count("getChunkIds")).toBe(8);
  });

  it("refuses a file over the cap with a 413 before reading a byte of it (the chunk-count budget)", async () => {
    // 800 chunks against a 1 MiB cap: the budget for that cap is 256 chunks, so no chunk is read.
    const res = await gateway({ maxFileBytes: 1024 * 1024 })(root);
    expect(res.status).toBe(413);
    expect(chain.count("multicall:read")).toBe(0);
    expect(chunkBudget(1024 * 1024)).toBe(256);
  });

  it("answers a range from the middle by seeking to it: one locateByte, then only the chunks the range covers", async () => {
    const start = 5_000_000;
    const res = await gateway({ maxFileBytes: 16 * 1024 * 1024 })(root, "/", { range: `bytes=${start}-${start + 99}` });
    expect(res.status).toBe(206);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(100);
    for (let i = 0; i < 100; i++) expect(bytes[i]).toBe(at(start + i));
    expect(res.headers.get("content-range")).toBe(`bytes ${start}-${start + 99}/${CHUNK * COUNT}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    // The 100 bytes sit inside one chunk: one seek, one page of hashes, one chunk read. Nothing before it is read.
    expect(chain.count("locateByte")).toBe(1);
    expect(chain.count("multicall:read")).toBe(1);
    expect(chain.count("getChunkIds")).toBe(1);
  });

  it("answers a range at the start with a single bundle of chunks", async () => {
    const res = await gateway()(root, "/", { range: "bytes=0-1023" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1023/${CHUNK * COUNT}`);
    expect(chain.count("multicall:read")).toBe(1);
    expect(chain.count("getChunkIds")).toBe(1);
    // HEAD agrees, and reads the same.
    const head = await gateway()(root, "/", { range: "bytes=0-1023" }, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("1024");
  });

  it("states the length once the read reaches the end, and a range past it is 416", async () => {
    const size = CHUNK * COUNT;
    const get = gateway({ maxFileBytes: 16 * 1024 * 1024 });
    const tail = await get(root, "/", { range: `bytes=${size - 10}-` });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    const past = await get(root, "/", { range: `bytes=${size + 5}-` });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${size}`);
  });

  it("answers a range anywhere in a file over the cap (a seek is not a whole-file read), reading only that chunk", async () => {
    const res = await gateway({ maxFileBytes: 1024 * 1024 })(root, "/", { range: "bytes=9800000-9800009" });
    expect(res.status).toBe(206);
    const bytes = new Uint8Array(await res.arrayBuffer());
    for (let i = 0; i < 10; i++) expect(bytes[i]).toBe(at(9_800_000 + i));
    expect(chain.count("multicall:read")).toBe(1);
  });

  it("an open-ended range is answered with at most the file cap, and says so", async () => {
    const res = await gateway({ maxFileBytes: 100_000 })(root, "/", { range: "bytes=0-" });
    expect(res.status).toBe(206);
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBe(100_000);
    expect(res.headers.get("content-range")).toBe(`bytes 0-99999/${CHUNK * COUNT}`);
  });

  it("a suffix range (an mp4 index at the end) is answered from the length, reading only the last chunk", async () => {
    const size = CHUNK * COUNT;
    const res = await gateway({ maxFileBytes: 1024 * 1024 })(root, "/", { range: "bytes=-100" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${size - 100}-${size - 1}/${size}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    for (let i = 0; i < 100; i++) expect(bytes[i]).toBe(at(size - 100 + i));
    expect(chain.count("multicall:read")).toBe(1);
    // bytes=-0 is unsatisfiable; a suffix longer than the file is the whole file (within the slice cap).
    expect((await gateway()(root, "/", { range: "bytes=-0" })).status).toBe(416);
  });

  it("an If-Range that is not our ETag gets the whole file, never a slice of something else", async () => {
    const res = await gateway({ maxFileBytes: 16 * 1024 * 1024 })(root, "/", { range: "bytes=0-9", "if-range": '"someone-else"' });
    expect(res.status).toBe(200);
  });
});

describe("rangeSpecOf", () => {
  const ETAG = '"e"';
  it("takes `a-b`, `a-` and `-n` and nothing else", () => {
    expect(rangeSpecOf("bytes=5-9", null, ETAG)).toEqual({ start: 5, end: 9 });
    expect(rangeSpecOf("bytes=5-", null, ETAG)).toEqual({ start: 5 });
    expect(rangeSpecOf("bytes=-5", null, ETAG)).toEqual({ suffix: 5 });
    for (const bad of ["bytes=-", "bytes=9-5", "bytes=0-1,4-5", "items=0-1", "bytes=", "bytes=a-b", "bytes=0-9999999999999999", null]) {
      expect(rangeSpecOf(bad, null, ETAG)).toBeNull();
    }
    expect(rangeSpecOf("bytes=5-9", '"other"', ETAG)).toBeNull();
    expect(rangeSpecOf("bytes=5-9", ETAG, ETAG)).toEqual({ start: 5, end: 9 });
  });
});

describe("a node that is missing", () => {
  it("a file whose chunk is gone is an upstream error (502), never partial bytes or a 200", async () => {
    const a = chunkBytes(1, 40);
    const b = chunkBytes(2, 40);
    const { cid } = chain.addFile([a, b]);
    // The second chunk's backend stops serving it (its record stays).
    const { keccak256 } = await import("viem");
    const h = keccak256(b);
    const id = (await import("@abxfs/sdk")).chunkId("0x00000000000000000000000000000000000000b1", h, h, b.length);
    chain.dropChunk(id);
    const res = await gateway()(cid);
    expect(res.status).toBe(502);
  });

  it("a root that no store holds is a 404", async () => {
    const res = await gateway()(asAbxfsCid(`0x${"ab".repeat(32)}`));
    expect(res.status).toBe(404);
  });
});

describe("a range past the end", () => {
  it("is a 416 from the recorded length, before a single chunk is read", async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => chunkBytes(i, 12_300));
    const { cid } = chain.addFile(chunks);
    chain.reset();
    const res = await gateway({ maxFileBytes: 10_000 })(cid, "/", { range: "bytes=500000-500009" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${20 * 12_300}`);
    expect(chain.count("multicall:read")).toBe(0);
    expect(chain.count("getChunkIds")).toBe(0);
  });
});
