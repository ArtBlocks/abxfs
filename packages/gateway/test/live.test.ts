/**
 * The standalone gateway and mirror against REAL Base Sepolia content, with no Next.js anywhere.
 * Skipped unless `ABXFS_RPC_URL_84532` is set.
 *
 * Reads the org created while proving the fourth factory generation (`0x42b7…fd4B`), whose project 0 holds a
 * two-file site. It is testnet, public, and was made for this.
 */
import { describe, expect, it } from "vitest";
import type { IpfsCid } from "@artblocks/abxfs-sdk";

import { chainsFromEnv } from "../src/config.js";
import { denylistFilter } from "../src/filters.js";
import { createGateway } from "../src/handler.js";
import { memoryCursor, runMirrorGenerations } from "../src/mirror.js";
import { orgSubject } from "../src/subjects.js";
import { contentLabel, rootContentLabel, asAbxfsCid } from "@artblocks/abxfs-sdk";

const rpc = process.env["ABXFS_RPC_URL_84532"];
const ORG = "0x450ddacfe7ccba64abda147ffd5a888626982242";
const OLD_COLLECTION = "0x7015Ab36fA7d62dAf286561114E7f3c250511E31"; // a real ABX collection, not an org

describe.skipIf(!rpc)("live: Base Sepolia", () => {
  const { chains } = chainsFromEnv(process.env, [84532]);
  const BASE = "c.example";
  const gateway = createGateway({ chains, hostMode: { baseHost: BASE } });
  const hostFor = (id: number, version?: number) => `${contentLabel({ chainId: 84532, org: ORG, tokenId: id, ...(version ? { version } : {}) })}.${BASE}`;
  const getAt = (host: string, path = "/", init?: RequestInit, gw = gateway) =>
    gw(new Request(`http://${host}${path}`, { ...init, headers: { host, ...(init?.headers as object) } }));
  const get = (path: string, init?: RequestInit) => getAt(hostFor(1), path, init);

  it("serves a project from chain, with the headers a client relies on", async () => {
    const res = await get(`/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("fifth generation");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-abxfs-root")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate"); // `latest` is mutable
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });

  it("serves a pinned version from its own host, short-lived at the edge, and a validator match is a 304", async () => {
    const first = await getAt(hostFor(1, 1), "/index.html");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).not.toContain("immutable");
    const etag = first.headers.get("etag")!;
    const again = await getAt(hostFor(1, 1), "/index.html", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("answers HEAD without a body", async () => {
    const head = await get(`/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves the same bytes by raw CID, with no project involved", async () => {
    const byProject = await get(`/index.html`);
    const root = byProject.headers.get("x-abxfs-root")!;
    const byCid = await getAt(`${rootContentLabel(84532, asAbxfsCid(root as `0x${string}`))}.${BASE}`, `/index.html`);
    expect(byCid.status).toBe(200);
    expect(await byCid.text()).toBe(await byProject.text());
    expect(byCid.headers.get("cache-control")).toContain("immutable");
  });

  /** The reason the gateway checks the factory: a real collection with real data is still not an org. */
  it("refuses an address the factory did not create, even a real ABX collection", async () => {
    const res = await getAt(`${contentLabel({ chainId: 84532, org: OLD_COLLECTION, tokenId: 1 })}.${BASE}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not an org/);
  });

  it("404s a project that does not exist rather than failing upstream", async () => {
    expect((await getAt(hostFor(99999))).status).toBe(404);
  });

  it("applies a filter before touching the chain: an org block refuses its projects, not another org's", async () => {
    const filtered = createGateway({
      chains,
      hostMode: { baseHost: BASE },
      filter: denylistFilter([orgSubject(84532, ORG)]),
    });
    const res = await getAt(hostFor(1), "/", undefined, filtered);
    expect(res.status).toBe(451);
  });


  it("mirrors the real ledger: every published root is read from chain and handed to a provider", async () => {
    const pinned: Array<{ root: IpfsCid; bytes: number }> = [];
    const provider = {
      name: "memory",
      async pinCar({ root, car }: { root: IpfsCid; car: Blob }) {
        pinned.push({ root, bytes: car.size });
        return { pinnedCid: root };
      },
      async unpin() {},
      async isPinned() {
        return false;
      },
    };
    const lines: string[] = [];
    const stats = await runMirrorGenerations({
      chain: chains[0]!,
      provider,
      cursorFor: () => memoryCursor(),
      once: true,
      // The real ledger only grows (every browser and CLI proof adds roots, some with hundreds of files),
      // so mirroring all of it makes this test slower each week. A bounded run proves the same thing.
      maxRootsPerRun: 3,
      log: (l) => lines.push(l),
      backoffMs: () => 0,
    });
    expect(stats.pinned).toBeGreaterThan(0);
    expect(pinned).toHaveLength(stats.pinned);
    expect(pinned.every((p) => p.bytes > 0)).toBe(true);
    expect(lines.some((l) => l.startsWith("GAVE UP"))).toBe(false);
  });
});
