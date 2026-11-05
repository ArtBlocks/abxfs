import { appendFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const log = (...a: unknown[]) => appendFileSync("/tmp/audit5-range.log", a.join(" ") + "\n");
let size = 100;
let filterCalls = 0;
vi.mock("../../src/resolve.js", async (orig) => {
  const actual = await orig<typeof import("../../src/resolve.js")>();
  return {
    ...actual,
    resolveRoot: async (chain: any, addressing: any, subpath: string) => ({ chain, addressing, rootCid: ("0x" + "11".repeat(32)) as never, subpath, preferredGateway: null, kind: 1 }),
    locate: async () => ({ directory: false, cid: "0x" + "22".repeat(32) }),
    serveContent: async () => ({ bytes: Uint8Array.from({ length: size }, (_, i) => i % 251), mimeType: "text/plain" }),
  };
});
import { byteRange, createGateway } from "../../src/handler.js";

const ETAG = '"0x1111:%2F"';
const gw = createGateway({
  chains: () => ({ id: 84532, contracts: {} as never, client: {} as never }),
  pathMode: {},
  filter: () => { filterCalls++; return { allow: true }; },
});
const get = (h: Record<string, string>, method = "GET") => gw(new Request(`http://gw.test/g/cid/84532/0x${"11".repeat(32)}/`, { method, headers: h }));

describe("AUDIT5 byteRange", () => {
  beforeEach(() => { size = 100; });
  const L = 100;
  const cases: Array<[string, string | null, any]> = [
    ["0-", "bytes=0-", { start: 0, end: 99 }],
    ["0-0", "bytes=0-0", { start: 0, end: 0 }],
    ["99-99", "bytes=99-99", { start: 99, end: 99 }],
    ["100-", "bytes=100-", "unsatisfiable"],
    ["-0", "bytes=-0", "unsatisfiable"],
    ["-1000 suffix > size", "bytes=-1000", { start: 0, end: 99 }],
    ["5-3 inverted", "bytes=5-3", null],
    ["0-1,5-6 multi", "bytes=0-1,5-6", null],
    ["16 digits", "bytes=0-9999999999999999", null],
    ["15 digits end", "bytes=0-999999999999999", { start: 0, end: 99 }],
    ["15 digits start", "bytes=999999999999999-", "unsatisfiable"],
    ["-", "bytes=-", null],
    ["unit case", "Bytes=0-1", null],
    ["space", "bytes= 0-1", null],
    ["leading zeros", "bytes=00-01", { start: 0, end: 1 }],
    ["NaN-ish hex", "bytes=0x1-2", null],
    ["unicode digits", "bytes=١-2", null],
  ];
  for (const [n, h, want] of cases) it(n, () => expect(byteRange(h, null, ETAG, L)).toEqual(want));
  it("empty file: bytes=0- ; suffix", () => {
    log("empty bytes=0-:", JSON.stringify(byteRange("bytes=0-", null, ETAG, 0)), " bytes=-5:", JSON.stringify(byteRange("bytes=-5", null, ETAG, 0)));
  });
  it("If-Range mismatch / weak / date -> whole", () => {
    expect(byteRange("bytes=0-1", `W/${ETAG}`, ETAG, L)).toBeNull();
    expect(byteRange("bytes=0-1", "Wed, 21 Oct 2015 07:28:00 GMT", ETAG, L)).toBeNull();
    expect(byteRange("bytes=0-1", ETAG, ETAG, L)).toEqual({ start: 0, end: 1 });
  });
});

describe("AUDIT5 handler Range", () => {
  beforeEach(() => { size = 100; filterCalls = 0; });
  it("206 headers consistent, body length == content-length, HEAD parity", async () => {
    const res = await get({ range: "bytes=10-19" });
    const body = new Uint8Array(await res.arrayBuffer());
    const head = await get({ range: "bytes=10-19" }, "HEAD");
    log("206:", res.status, res.headers.get("content-range"), res.headers.get("content-length"), body.length, "cc=", res.headers.get("cache-control"), "vary=", res.headers.get("vary"), "ae=", res.headers.get("accept-ranges"));
    log("HEAD206:", head.status, head.headers.get("content-range"), head.headers.get("content-length"));
    expect(res.status).toBe(206); expect(body.length).toBe(10); expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("10");
  });
  it("416 on GET and HEAD; If-Range mismatch -> 200 whole; plain -> 200", async () => {
    const r = await get({ range: "bytes=500-" });
    log("416:", r.status, r.headers.get("content-range"), r.headers.get("content-length"), r.headers.get("cache-control"), r.headers.get("content-type"), r.headers.get("etag"));
    expect(r.status).toBe(416);
    expect((await get({ range: "bytes=500-" }, "HEAD")).status).toBe(416);
    const w = await get({ range: "bytes=0-1", "if-range": '"other"' });
    expect(w.status).toBe(200);
    expect(w.headers.get("content-range")).toBeNull();
    expect((await get({})).headers.get("content-length")).toBe("100");
  });
  it("304 wins over Range; Range does not skip the filter (2 phases not needed for cid)", async () => {
    const r = await get({ range: "bytes=0-1", "if-none-match": `"0x${"11".repeat(32)}:%2F"` });
    log("INM+Range:", r.status);
    expect(filterCalls).toBeGreaterThan(0);
  });
  it("empty file with bytes=0-", async () => {
    size = 0;
    const r = await get({ range: "bytes=0-" });
    const h = await get({});
    log("empty file Range 0-: ", r.status, r.headers.get("content-range"), "plain:", h.status, h.headers.get("content-length"));
  });
  it("Range through the cors wrapper keeps content-range exposed", async () => {
    const g2 = createGateway({ chains: () => ({ id: 84532, contracts: {} as never, client: {} as never }), pathMode: {}, cors: "*" });
    const r = await g2(new Request(`http://gw.test/g/cid/84532/0x${"11".repeat(32)}/`, { headers: { range: "bytes=1-2" } }));
    log("cors 206:", r.status, r.headers.get("access-control-expose-headers"));
  });
});
