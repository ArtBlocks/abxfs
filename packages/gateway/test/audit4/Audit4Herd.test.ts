/** AUDIT4 (FIXED): cold-cache stampede and root-host cost amplification, counted at the RPC client. In-flight reads are shared and an unknown root is remembered for seconds. */
import { describe, expect, it } from "vitest";
import { asAbxfsCid, rootContentLabel } from "@artblocks/abxfs-sdk";

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";
import { TEST_ADDRESSES } from "../helpers.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const addresses = TEST_ADDRESSES;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AUDIT4 stampede", () => {
  it("50 concurrent identical cold requests for an org/token: how many RPC reads?", async () => {
    __resetResolveCaches();
    const calls = { isOrg: 0, multicall: 0 };
    const client = {
      async readContract({ functionName }: { functionName: string }) {
        await delay(30);
        if (functionName === "isOrg") { calls.isOrg++; return true; }
        throw new Error("execution reverted");
      },
      async multicall() {
        calls.multicall++;
        await delay(30);
        return [0, 1, 2, 3, 4, 5, 6, 7].map(() => ({ status: "failure", error: new Error("reverted") }));
      },
    } as never;
    const gw = createGateway({ chains: [{ id: 84532, contracts: addresses, client }], hostMode: { baseHost: BASE }, onError: () => {} });
    const host = `84532-${ORG.slice(2)}-1.${BASE}`;
    const rs = await Promise.all(Array.from({ length: 50 }, () => gw(new Request(`http://${host}/`, { headers: { host } }))));
    console.log(`HERD project | statuses=${[...new Set(rs.map((r) => r.status))]} | isOrg calls=${calls.isOrg} | multicalls=${calls.multicall}`);
    expect(calls.isOrg).toBe(1); // one in-flight lookup shared by all 50
    expect(calls.multicall).toBe(1); // and one project read
  });

  it("an unknown root costs how many reads per request on 2 served chains? is it repeated?", async () => {
    const ROOT = asAbxfsCid(`0x${"cd".repeat(32)}`);
    const host = `${rootContentLabel(84532, ROOT)}.${BASE}`;
    let reads = 0;
    const mk = (id: number) => ({
      id,
      contracts: { chunkStore: "0x00000000000000000000000000000000000000c1", sstore2Backend: "0x00000000000000000000000000000000000000b1", fastLzBackend: "0x00000000000000000000000000000000000000b2", fileStore: ORG, directoryStore: ORG } as never,
      client: { readContract: async () => { reads++; await delay(5); return false; } } as never,
    });
    const gw = createGateway({ chains: [mk(84532), mk(8453)], hostMode: { baseHost: BASE }, onError: () => {} });
    for (let i = 0; i < 3; i++) await gw(new Request(`http://${host}/`, { headers: { host } }));
    const first = reads;
    await Promise.all(Array.from({ length: 20 }, () => gw(new Request(`http://${host}/`, { headers: { host } }))));
    console.log(`HERD root | 3 sequential requests = ${first} reads (${first / 3}/req) | +20 concurrent = ${reads - first} reads`);
    expect(first / 3).toBeLessThanOrEqual(2);
    expect(first).toBe(2); // one probe (two store reads) on the chain the host names, once; the repeats and the 20 concurrent ones cost nothing
    expect(reads - first).toBe(0);
  });
});
