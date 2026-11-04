/**
 * Audit 8: the gateway's seek path (`readRange` with `locateByte`), suffix ranges and the call budget.
 *
 * R1 is a correctness sweep: every range around every chunk boundary of a file with mixed chunk sizes (1 byte up to
 * the backend maximum) must serve exactly `file.subarray(start, end + 1)` with a matching Content-Range, and the same
 * answers `byteRange` (the whole-file slicer) would give.
 *
 * R2 is a FINDING: a small CLOSED range over a file of one-byte chunks reads one chunk per round trip, and each round
 * trip is now TWO sequential calls (`getChunkIds` sized to the bundle, then the chunk read). `want` assumes
 * 12,287-byte chunks, so for any range under that it is 1 every time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asAbxfsCid, rootContentLabel, type AbxfsCid } from "@abxfs/sdk";

import { byteRange, createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { FakeChain, chunkBytes } from "../fake-chain.js";

const BASE = "content.example";
let chain: FakeChain;
beforeEach(() => {
  __resetResolveCaches();
  chain = new FakeChain();
});

function gateway() {
  const gw = createGateway({
    chains: [{ id: 84532, contracts: chain.contracts, client: chain.client }],
    defaultChainId: 84532,
    hostMode: { baseHost: BASE },
    onError: () => {},
  });
  return (root: AbxfsCid, headers: Record<string, string> = {}, method = "GET") => {
    const host = `${rootContentLabel(asAbxfsCid(root))}.${BASE}`;
    return gw(new Request(`http://${host}/`, { method, headers: { host, ...headers } }));
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("audit8 gateway ranges", () => {
  it("R1 every range around every chunk boundary serves exactly the reference bytes", async () => {
    const sizes = [1, 2, 3, 700, 1, 5000, 13, 1, 24_575, 2];
    const chunks = sizes.map((s, i) => chunkBytes(i, s));
    const whole = concat(chunks);
    const total = whole.length;
    const { cid } = chain.addFile(chunks, "application/octet-stream");
    const get = gateway();

    const points = new Set<number>([0, 1, total - 2, total - 1, total, total + 7]);
    let b = 0;
    for (const s of sizes) {
      for (const d of [-1, 0, 1]) if (b + d >= 0) points.add(b + d);
      b += s;
    }
    const pts = [...points].sort((x, y) => x - y);
    const etag = (r: Response) => r.headers.get("etag")!;

    const check = async (header: string) => {
      const res = await get(cid, { range: header });
      const expected = byteRange(header, null, "x", total);
      if (expected === "unsatisfiable") {
        expect(res.status, header).toBe(416);
        expect(res.headers.get("content-range"), header).toBe(`bytes */${total}`);
        return;
      }
      expect(expected, header).not.toBeNull();
      const { start, end } = expected as { start: number; end: number };
      expect(res.status, header).toBe(206);
      expect(res.headers.get("content-range"), header).toBe(`bytes ${start}-${end}/${total}`);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length, header).toBe(end - start + 1);
      expect(Buffer.from(body).equals(Buffer.from(whole.subarray(start, end + 1))), header).toBe(true);
      expect(res.headers.get("content-length"), header).toBe(String(end - start + 1));
      void etag;
    };

    for (const a of pts) {
      await check(`bytes=${a}-`);
      await check(`bytes=-${a}`);
      for (const e of pts) if (e >= a) await check(`bytes=${a}-${e}`);
    }

    // HEAD of a range: same headers, no body.
    const head = await get(cid, { range: "bytes=5-6" }, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 5-6/${total}`);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("R2 FIXED: a ranged read of a one-byte-chunk file reads full bundles and pages of hashes (tens of round trips, not thousands)", async () => {
    const N = 4000;
    const { cid } = chain.addFile(
      Array.from({ length: N }, (_, i) => new Uint8Array([i & 0xff])),
      "application/octet-stream",
    );
    // Count real round trips: one per readContract, one per simulateContract (a whole multicall bundle).
    let roundTrips = 0;
    const inner = chain.client as unknown as {
      readContract: (a: unknown) => Promise<unknown>;
      simulateContract: (a: unknown) => Promise<unknown>;
    };
    const counted = {
      readContract: (a: unknown) => (roundTrips++, inner.readContract(a)),
      simulateContract: (a: unknown) => (roundTrips++, inner.simulateContract(a)),
    } as never;
    const gw = createGateway({
      chains: [{ id: 84532, contracts: chain.contracts, client: counted }],
      defaultChainId: 84532,
      hostMode: { baseHost: BASE },
      onError: () => {},
    });
    const host = `${rootContentLabel(asAbxfsCid(cid))}.${BASE}`;
    const req = (range: string) => gw(new Request(`http://${host}/`, { headers: { host, range } }));

    for (const range of ["bytes=0-12286", "bytes=0-", "bytes=-4000"]) {
      __resetResolveCaches();
      roundTrips = 0;
      chain.reset();
      const res = await req(range);
      expect(res.status).toBe(206);
      // Truncated at the ranged chunk budget (1,024 chunks), which the Content-Range states honestly.
      expect(res.headers.get("content-range")).toMatch(/^bytes \d+-\d+\/4000$/);
      console.log(`AUDIT8 R2 ${range}: ${res.headers.get("content-range")} getChunkIds=${chain.count("getChunkIds")} sequential round trips=${roundTrips}`);
      // `want` follows the chunk sizes actually seen, and hashes come a page (100) at a time: 1,024 chunks cost about
      // 11 hash pages and 16 bundles. (Before the fix: one chunk per iteration, ~2,050 sequential round trips.)
      expect(chain.count("getChunkIds")).toBeLessThanOrEqual(12);
      expect(roundTrips).toBeLessThanOrEqual(40);
    }
  });
});
