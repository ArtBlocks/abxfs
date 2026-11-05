/**
 * The handler's decisions that do not need a chain: what it refuses, and — more importantly — that
 * it refuses BEFORE reading one. A filtered request that still cost an RPC call would make a filter
 * a way to be made to spend money.
 */
import { describe, expect, it, vi } from "vitest";

import { createGateway } from "../src/handler.js";
import { denylistFilter } from "../src/filters.js";
import { orgSubject, projectSubject } from "../src/subjects.js";
import type { GatewayChain } from "../src/types.js";

const ORG = "0x00000000000000000000000000000000000000a1";

/** A chain whose client explodes if it is ever used. */
function untouchableChain(): GatewayChain {
  const boom = () => {
    throw new Error("the chain was read");
  };
  return {
    id: 84532,
    contracts: {} as never,
    client: new Proxy({}, { get: () => boom }) as never,
  };
}

const req = (path: string, init?: RequestInit) => new Request(`http://gw.test${path}`, init);

describe("what is refused before the chain is read", () => {
  it("answers 451 for a filtered project, with a neutral body and no cache", async () => {
    const lookup = vi.fn(() => untouchableChain());
    const gw = createGateway({
      chains: lookup,
      pathMode: {},
      filter: denylistFilter([projectSubject(84532, ORG, 2)]),
    });
    const res = await gw(req(`/g/p/84532/${ORG}/2/latest/`));
    expect(res.status).toBe(451);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toMatch(/not available from this gateway/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a whole org by its namespace", async () => {
    const gw = createGateway({
      chains: () => untouchableChain(),
      pathMode: {},
      filter: denylistFilter([orgSubject(84532, ORG)]),
    });
    expect((await gw(req(`/g/p/84532/${ORG}/1/latest/`))).status).toBe(451);
    expect((await gw(req(`/g/p/84532/${ORG}/99/v/3/index.html`))).status).toBe(451);
  });

  it("uses the operator's refusal message", async () => {
    const gw = createGateway({
      chains: () => untouchableChain(),
      pathMode: {},
      filter: () => ({ allow: false }),
      refusalMessage: "Not served here. Questions: ops@example.org",
    });
    expect(await (await gw(req(`/g/cid/84532/0x${"ab".repeat(32)}/`))).text()).toBe("Not served here. Questions: ops@example.org");
  });

  it("derives subjects the same way wherever the gateway is mounted", async () => {
    const gw = createGateway({
      chains: () => untouchableChain(),
      pathMode: { basePath: "/content" },
      filter: denylistFilter([projectSubject(84532, ORG, 2)]),
    });
    expect((await gw(req(`/content/p/84532/${ORG}/2/latest/`))).status).toBe(451);
  });
});

describe("requests it can turn away without a chain", () => {
  const gw = createGateway({ chains: () => undefined, pathMode: {} });

  it("rejects methods other than GET and HEAD", async () => {
    const res = await gw(req(`/g/cid/84532/0x${"ab".repeat(32)}/`, { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("404s a path outside its mount", async () => {
    expect((await gw(req("/elsewhere/p/1/2/3"))).status).toBe(404);
  });

  it("400s a malformed address, an org name, and the pre-org URL shape", async () => {
    for (const path of ["/g/p/84532/acme/1/latest/", "/g/p/84532/1/latest/", "/g/p/84532/0x1234/1/latest/"]) {
      expect((await gw(req(path))).status, path).toBe(400);
    }
  });

  it("404s a chain it does not serve", async () => {
    expect((await gw(req(`/g/p/1/${ORG}/1/latest/`))).status).toBe(404);
  });

  it("never caches a failure", async () => {
    expect((await gw(req("/g/p/84532/acme/1/latest/"))).headers.get("cache-control")).toBe("no-store");
  });
});

describe("choosing a mode", () => {
  it("refuses to be built with no addressing mode: how projects are separated is not a default", () => {
    expect(() => createGateway({ chains: [] })).toThrow(/exactly one/);
  });

  it("refuses to be built with two", () => {
    expect(() =>
      createGateway({ chains: [], pathMode: {}, hostMode: { baseHost: "c.example" } }),
    ).toThrow(/exactly one/);
  });
});

describe("single-project mode", () => {
  const ORG = "0x00000000000000000000000000000000000000a1";
  /** A filter that records what the request resolved to and refuses, so the chain (one that throws if read) is not read. */
  function probe(project: NonNullable<Parameters<typeof createGateway>[0]["project"]>) {
    const seen: string[][] = [];
    const gw = createGateway({
      chains: [untouchableChain()],
      project,
      filter: ({ subjects }) => {
        seen.push(subjects);
        return { allow: false };
      },
    });
    return { seen, get: (path: string) => gw(new Request(`http://site.test${path}`)) };
  }

  it("reads every path as a path INSIDE the project, with no /g prefix", async () => {
    const { seen, get } = probe({ chainId: 84532, org: ORG, tokenId: 3 });
    await get("/style.css");
    await get("/");
    for (const subjects of seen) {
      expect(subjects).toContain(`project:84532:${ORG}:3`);
      expect(subjects).toContain(`org:84532:${ORG}`);
    }
    expect(seen).toHaveLength(2);
  });

  it("serves nothing else: a raw CID path is a path inside the project, not the CID namespace", async () => {
    const { seen, get } = probe({ chainId: 84532, org: ORG, tokenId: 3 });
    await get(`/g/cid/84532/0x${"ab".repeat(32)}/index.html`);
    expect(seen[0]!.some((s) => s.startsWith("root:"))).toBe(false);
  });

  it("applies the same filters as the normal mode, so a blocked org is blocked here too", async () => {
    const res = await probe({ chainId: 84532, org: ORG, tokenId: 3 }).get("/index.html");
    expect(res.status).toBe(451);
  });
});

describe("cors option", () => {
  const ORG = "0x00000000000000000000000000000000000000a1";
  const host = `84532-${ORG.slice(2)}-3.c.example`;
  const req = () => new Request(`http://${host}/`, { headers: { host } });

  it("is off by default", async () => {
    const gw = createGateway({ chains: [], hostMode: { baseHost: "c.example" }, filter: () => ({ allow: false }) });
    expect((await gw(req())).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds allow-origin and exposes the x-abxfs headers on every response, errors included", async () => {
    const gw = createGateway({
      chains: [],
      hostMode: { baseHost: "c.example" },
      cors: "*",
      filter: () => ({ allow: false }),
    });
    const res = await gw(req());
    expect(res.status).toBe(451);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-abxfs-root");
  });
});

describe("a partial response is never re-encoded", () => {
  it("206 and 416 carry no-transform, so no layer can gzip a slice under a Content-Range for the raw bytes", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/handler.ts", import.meta.url), "utf8");
    // The behaviour is in the handler's source of truth; the live range tests check the headers end to end.
    expect(src).toMatch(/no-store, no-transform/);
    expect(src).toMatch(/no-transform`/);
  });
});
