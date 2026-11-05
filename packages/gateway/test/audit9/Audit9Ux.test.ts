/**
 * AUDIT 9, L6 and the UX items, plus two negative results kept as regression tests:
 *
 *  - L6: `If-None-Match` was answered 304 only AFTER the whole file had been read. The ETag depends only on the root,
 *    the sub-path and the listing start, so a match is now answered before any content is read.
 *  - A directory URL with a backslash in its QUERY was a 400; it is the same 307 as any other query.
 *  - A token id over 10 digits was "invalid token id"; it now says why it cannot be addressed.
 *  - N2: no other spelling of a blocked project or root host is served.
 *  - N3: a random single range over a file of uneven chunks returns exactly the bytes `Content-Range` names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@abxfs/sdk", async (orig) => {
  const real = await orig<typeof import("@abxfs/sdk")>();
  return { ...real, isOrg: async () => true };
});

import * as sdk from "@abxfs/sdk";
import { rootContentLabel } from "@abxfs/sdk";

import { parsePathSegments, parseTokenId } from "../../src/addressing.js";
import { GatewayError } from "../../src/errors.js";
import { createGateway, etagMatches } from "../../src/handler.js";
import { denylistFilter } from "../../src/filters.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { projectSubject, rootSubject } from "../../src/subjects.js";
import { FakeChain, chunkBytes } from "../fake-chain.js";

beforeEach(() => __resetResolveCaches());

function setup() {
  const fc = new FakeChain();
  const F = fc.addFile(Array.from({ length: 100 }, (_, i) => chunkBytes(i, 16 * 1024)), "application/octet-stream").cid;
  const D = fc.addDirectory([{ name: "f.bin", cid: F, isDirectory: false }]);
  const ROOT = fc.addDirectory([{ name: "dir", cid: D, isDirectory: true }]);
  const gw = createGateway({ chains: [{ id: 84532, contracts: fc.contracts, client: fc.client } as never], hostMode: { baseHost: "c.example" }, onError: () => {} });
  const host = `${rootContentLabel(84532, ROOT)}.c.example`;
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => gw(new Request(`https://${host}${path}`, { method, headers: { host, ...headers } }));
  return { fc, get, F, ROOT };
}

describe("L6: a matching If-None-Match reads no content", () => {
  it("304 for a 1.6 MB file costs no chunk read and not even the file's record", async () => {
    const { fc, get } = setup();
    const first = await get("/dir/f.bin");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    fc.reset();
    const again = await get("/dir/f.bin", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(fc.count("multicall:read")).toBe(0);
    expect(fc.count("getFileInfo")).toBe(0);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    expect(again.headers.get("x-abxfs-root")).toBe(first.headers.get("x-abxfs-root"));
    expect(await again.text()).toBe("");
  });

  it("a list, a weak tag and `*` match; another tag does not", async () => {
    const { get } = setup();
    const etag = (await get("/dir/f.bin")).headers.get("etag")!;
    expect((await get("/dir/f.bin", { "if-none-match": `"other", W/${etag}` })).status).toBe(304);
    expect((await get("/dir/f.bin", { "if-none-match": "*" })).status).toBe(304);
    expect((await get("/dir/f.bin", { "if-none-match": '"other"' })).status).toBe(200);
    expect((await get("/dir/f.bin", { "if-none-match": etag }, "HEAD")).status).toBe(304);
  });

  it("a listing's ETag carries its page, and is answered before the page is read", async () => {
    const { fc, get } = setup();
    const page = await get("/dir/");
    const etag = page.headers.get("etag")!;
    fc.reset();
    expect((await get("/dir/", { "if-none-match": etag })).status).toBe(304);
    expect(fc.count("getEntries")).toBe(0);
    expect((await get("/dir/?start=1", { "if-none-match": etag })).status).toBe(200);
  });

  it("etagMatches", () => {
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches("", '"a"')).toBe(false);
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches(' "b" ,  W/"a" ', '"a"')).toBe(true);
    expect(etagMatches('"a', '"a"')).toBe(false);
  });
});

describe("UX: a directory URL's query", () => {
  it("a backslash in the QUERY is the same 307 (percent-encoded), not a 400", async () => {
    const { get } = setup();
    const plain = await get("/dir?x=1");
    expect(plain.status).toBe(307);
    expect(plain.headers.get("location")).toBe("/dir/?x=1");
    const slash = await get("/dir?x=a\\b");
    expect(slash.status).toBe(307);
    expect(slash.headers.get("location")).toBe("/dir/?x=a%5Cb");
  });
});

describe("UX: a token id over 10 digits", () => {
  it("says why it cannot be addressed, instead of `invalid token id`", () => {
    const err = (() => {
      try {
        parseTokenId("12345678901");
      } catch (e) {
        return e as GatewayError;
      }
    })()!;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/more than 10 digits/);
    expect(() => parsePathSegments(["p", "84532", `0x${"a1".repeat(20)}`, "99999999999"])).toThrow(/more than 10 digits/);
    // a typo is still a typo, and the wide form (the app's own pages) still takes any uint256
    expect(() => parseTokenId("012")).toThrow(/^invalid token id$/);
    expect(() => parseTokenId("1e3")).toThrow(/^invalid token id$/);
    expect(parseTokenId("12345678901", true)).toBe(12345678901n);
  });
});

describe("N2: host spellings never serve a blocked project or root", () => {
  const BASE = "content.example";
  const ORG = "00000000000000000000000000000000000000a1";
  it("every variant is refused (451) or names nothing (404/400)", async () => {
    const fc = new FakeChain();
    const F = fc.addFile([new TextEncoder().encode("x")], "text/plain").cid;
    const spy = vi.spyOn(sdk, "readProject").mockResolvedValue({ cid: F, kind: 2, versionCount: 1, preferredGateway: null } as never);
    const chain = { id: 84532, contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" }, client: fc.client };
    const gw = createGateway({ chains: [chain as never], hostMode: { baseHost: BASE }, filter: denylistFilter([projectSubject(84532, `0x${ORG}`, 1n), rootSubject(F)]), onError: () => {} });
    const root = rootContentLabel(84532, F).slice("84532-".length);
    const hosts = [
      `84532-${ORG}-1.${BASE}`, `84532-${ORG}-1-v1.${BASE}`, `84532-${ORG.toUpperCase()}-1.${BASE}`.toUpperCase(),
      `84532-${ORG}-01.${BASE}`, `084532-${ORG}-1.${BASE}`, `+84532-${ORG}-1.${BASE}`, `84532-0x${ORG}-1.${BASE}`,
      `84532-${ORG}-1.${BASE}.`, `84532-${ORG}-1.${BASE}:443`, `84532-${ORG}-1-v0.${BASE}`, `84532-${ORG}-1-v01.${BASE}`,
      `84532-${ORG}-１.${BASE}`, `x.84532-${ORG}-1.${BASE}`, `84532-${ORG}-1%2e${BASE}`, `xn--84532-${ORG}-1.${BASE}`,
      `84532-${root}.${BASE}`, `84532-${root.toUpperCase()}.${BASE}`, `84532-${root.replace(/.$/, (c) => (c === "a" ? "b" : "a"))}.${BASE}`,
      `84532-${root}=.${BASE}`, `84532-${root.replace(/k/g, "K")}.${BASE}`, `084532-${root}.${BASE}`, `+84532-${root}.${BASE}`,
      `c-${root}.${BASE}`, `${root}.${BASE}`, `84532-c-${root}.${BASE}`,
    ];
    for (const host of hosts) {
      let status: number;
      try {
        status = (await gw(new Request("https://placeholder.invalid/", { headers: { host } }))).status;
      } catch {
        status = -1;
      }
      expect(status, host).not.toBe(200);
    }
    spy.mockRestore();
  });
});

describe("N3: ranges return exactly the bytes Content-Range names", () => {
  it("random single ranges over files of very uneven chunks", async () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let f = 0; f < 3; f++) {
      const fc = new FakeChain();
      const sizes = Array.from({ length: 50 + rnd(200) }, () => (rnd(10) === 0 ? 1 + rnd(3) : 1 + rnd(20_000)));
      const chunks = sizes.map((s, i) => Uint8Array.from({ length: s }, (_, k) => (i * 131 + k * 17 + f) & 0xff));
      const all = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
      let o = 0;
      for (const c of chunks) (all.set(c, o), (o += c.length));
      const { cid } = fc.addFile(chunks, "application/octet-stream");
      const gw = createGateway({ chains: [{ id: 84532, contracts: fc.contracts, client: fc.client } as never], hostMode: { baseHost: "c.example" }, maxFileBytes: 64 * 1024 + rnd(256 * 1024), onError: () => {} });
      const host = `${rootContentLabel(84532, cid)}.c.example`;
      const L = all.length;
      for (let i = 0; i < 30; i++) {
        const kind = rnd(3);
        const a = rnd(L + 50);
        const b = a + rnd(200_000);
        const spec = kind === 0 ? `bytes=${a}-${b}` : kind === 1 ? `bytes=${a}-` : `bytes=-${rnd(L + 50)}`;
        const res = await gw(new Request(`https://${host}/`, { headers: { host, range: spec } }));
        const body = new Uint8Array(await res.arrayBuffer());
        if (res.status === 416) {
          expect(res.headers.get("content-range")).toBe(`bytes */${L}`);
          expect(kind === 2 ? spec === "bytes=-0" : a >= L, `${spec} on ${L}`).toBe(true);
          continue;
        }
        expect(res.status, spec).toBe(206);
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range")!)!;
        const [s, e, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
        expect(t).toBe(L);
        expect(body.length).toBe(e - s + 1);
        expect(Buffer.from(body).equals(Buffer.from(all.subarray(s, e + 1))), `${spec} -> ${s}-${e}`).toBe(true);
        expect(s).toBe(kind === 2 ? Math.max(0, L - Number(spec.slice(7))) : a);
      }
    }
  });
});
