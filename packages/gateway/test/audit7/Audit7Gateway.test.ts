import { beforeEach, describe, expect, it } from "vitest";
import { asAbxfsCid, rootContentLabel, type AbxfsCid, type DirectoryEntry } from "@abxfs/sdk";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches, chunkBudget } from "../../src/resolve.js";
import { FakeChain, chunkBytes } from "../fake-chain.js";

const BASE = "content.example";
let chain: FakeChain;
beforeEach(() => {
  __resetResolveCaches();
  chain = new FakeChain();
});
function gateway(extra: Partial<Parameters<typeof createGateway>[0]> = {}) {
  const gw = createGateway({
    chains: [{ id: 84532, contracts: chain.contracts, client: chain.client }],
    defaultChainId: 84532,
    hostMode: { baseHost: BASE },
    onError: () => {},
    ...extra,
  });
  return (root: AbxfsCid, path = "/", headers: Record<string, string> = {}, method = "GET") => {
    const host = `${rootContentLabel(asAbxfsCid(root))}.${BASE}`;
    return gw(new Request(`http://${host}${path}`, { method, headers: { host, ...headers } }));
  };
}
const file = (name: string, cid: AbxfsCid): DirectoryEntry => ({ name, cid, isDirectory: false });

describe("audit7 gateway", () => {
  it("F1 call budget: a ranged read of a tiny-chunk file costs one seek, whatever the chunk count", async () => {
    const N = 20_000; // one-byte chunks; chunkBudget(64MiB) = 16384 so a whole read would be refused
    const chunks = Array.from({ length: N }, (_, i) => new Uint8Array([i & 0xff]));
    const { cid } = chain.addFile(chunks, "application/octet-stream");
    expect(N).toBeGreaterThan(chunkBudget(64 * 1024 * 1024));
    const get = gateway();
    // control: whole file is refused cheaply
    chain.reset();
    const whole = await get(cid);
    const wholeCalls = chain.calls.length;
    // ranged: ask for the last byte
    __resetResolveCaches();
    chain.reset();
    const res = await get(cid, "/", { range: `bytes=${N - 1}-${N - 1}` });
    const rangedCalls = chain.calls.length;
    console.log(`AUDIT7 F1 whole status=${whole.status} calls=${wholeCalls}; ranged status=${res.status} calls=${rangedCalls} (getChunkIds=${chain.count("getChunkIds")}, chunk reads=${chain.count("multicall:read")})`);
    expect(wholeCalls).toBeLessThan(15);
    console.log("AUDIT7 F1 round trips ~", chain.count("getChunkIds") + Math.ceil(chain.count("multicall:read") / 64));
    // Now a seek: the last byte is located directly and served from its one chunk.
    expect(res.status).toBe(206);
    expect(chain.count("multicall:read")).toBe(1);    // An open-ended range over one-byte chunks stops at the ranged chunk budget (1,024) and says what it served.
    chain.reset();
    const open = await get(cid, "/", { range: "bytes=0-" });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe(`bytes 0-1023/${N}`);
    expect(chain.count("multicall:read")).toBe(1024);
  });

  it("F2 ?start beyond total", async () => {
    const f = chain.addFile([new Uint8Array([1])]).cid;
    const root = chain.addDirectory(Array.from({ length: 5 }, (_, i) => file(`f${i}`, f)));
    const get = gateway();
    for (const q of ["999999999", "-1", "NaN", "1e3", "5", "4", "%34"]) {
      const r = await get(root, `/?start=${q}`);
      const t = await r.text();
      console.log("AUDIT7 F2", q, r.status, (/<p>([^<]*)/.exec(t) ?? [])[1], r.headers.get("etag"));
    }
    const r = await get(root, `/?start=5&start=0`);
    console.log("AUDIT7 F2 repeated", r.status, (/<p>([^<]*)/.exec(await r.text()) ?? [])[1]);
  });

  it("F3 hostile names are escaped; NUL / bidi / 255 bytes", async () => {
    const f = chain.addFile([new Uint8Array([1])]).cid;
    const names = ["<script>alert(1)<x>", "a\u0000b", "x‮fdp.exe", "\"><img src=x onerror=1>", "z".repeat(255), "&amp;"];
    const root = chain.addDirectory(names.map((n) => file(n, f)));
    const r = await gateway()(root);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    console.log("AUDIT7 F3 raw NUL in html:", html.includes("\u0000"), " raw RLO in html:", html.includes("‮"), "csp:", r.headers.get("content-security-policy"));
  });

  it("F4 path traversal / encodings", async () => {
    const f = chain.addFile([new Uint8Array([1])]).cid;
    const root = chain.addDirectory([file("a", f), file("a\u0000b", f), file("é", f)]);
    const get = gateway();
    for (const p of ["/%2e%2e/a", "/a%2f", "/%2fa", "/a%00", "/%5ca", "/a/../a", "/./a", "/e%CC%81", "/%C3%A9", "/a%5Cb", "//a", "/" + "x/".repeat(40) + "a", "/" + "a".repeat(5000), "/a%00b", "/%E0%A4%A"]) {
      const r = await get(root, p);
      console.log("AUDIT7 F4", JSON.stringify(p.slice(0, 30)), r.status);
    }
  });

  it("F5 range matrix at chunk boundaries", async () => {
    const C = 12_300;
    const chunks = Array.from({ length: 5 }, (_, i) => chunkBytes(i, C));
    const all = new Uint8Array(chunks.flatMap((c) => [...c]));
    const { cid } = chain.addFile(chunks, "video/mp4");
    const get = gateway();
    const cases: Array<[string, number, number, number | "*"]> = [
      [`bytes=0-0`, 0, 0, "*"],
      [`bytes=${C - 1}-${C}`, C - 1, C, "*"],
      [`bytes=${C}-${C}`, C, C, "*"],
      [`bytes=${5 * C - 1}-${5 * C - 1}`, 5 * C - 1, 5 * C - 1, 5 * C],
      [`bytes=${5 * C - 5}-`, 5 * C - 5, 5 * C - 1, 5 * C],
      [`bytes=0-${5 * C + 100}`, 0, 5 * C - 1, 5 * C],
    ];
    for (const [h, s, e] of cases) {
      const r = await get(cid, "/", { range: h });
      const b = new Uint8Array(await r.arrayBuffer());
      console.log("AUDIT7 F5", h, r.status, r.headers.get("content-range"), r.headers.get("cache-control"));
      expect(r.status).toBe(206);
      expect(Buffer.from(b).equals(Buffer.from(all.subarray(s, e + 1)))).toBe(true);
    }
    for (const h of [`bytes=${5 * C}-`, `bytes=${5 * C + 10}-${5 * C + 20}`, "bytes=-1", "bytes=0-1,5-6", "bytes=5-1", "items=0-1", "bytes=-", "bytes=0-0 "]) {
      const r = await get(cid, "/", { range: h });
      console.log("AUDIT7 F5b", JSON.stringify(h), r.status, r.headers.get("content-range"));
    }
    const head = await get(cid, "/", { range: "bytes=0-9" }, "HEAD");
    console.log("AUDIT7 F5 HEAD", head.status, head.headers.get("content-length"), head.headers.get("content-range"));
    const inm = await get(cid, "/", { range: "bytes=0-9", "if-none-match": `"${cid}:"` });
    console.log("AUDIT7 F5 INM", inm.status);
    const ifr = await get(cid, "/", { range: "bytes=0-9", "if-range": '"other"' });
    console.log("AUDIT7 F5 If-Range mismatch", ifr.status);
  });

  it("F6 oversize cache scope: a whole-file refusal then a ranged read of the same file", async () => {
    const C = 12_300;
    const { cid } = chain.addFile(Array.from({ length: 10 }, (_, i) => chunkBytes(i, C)), "video/mp4");
    const get = gateway({ maxFileBytes: 50_000 });
    const whole = await get(cid);
    const ranged = await get(cid, "/", { range: "bytes=0-99" });
    console.log("AUDIT7 F6 whole", whole.status, whole.headers.get("cache-control"), "vary:", whole.headers.get("vary"), "ranged", ranged.status);
  });
});
