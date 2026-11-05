/**
 * DELTA AUDIT guard: a blocked CID never gets a 304, whichever filter pass blocks it (the URL's subjects, the
 * project's resolved root, the served file, the directory whose index courtesy answered), whatever `If-None-Match`
 * says. The 304 is decided after every filter pass, so a client holding an ETag from before the block still gets 451.
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
import { FakeChain } from "../fake-chain.js";

const BASE = "content.example";
const ORG = "0x00000000000000000000000000000000000000a1";
const enc = (s: string) => new TextEncoder().encode(s);
beforeEach(() => __resetResolveCaches());

describe("a 304 never outranks a block", () => {
  it("URL subject, project root, served CID and courtesy directory blocks all answer 451 to a matching or * If-None-Match", async () => {
    const fc = new FakeChain();
    const F = fc.addFile([enc("<h1>x</h1>")], "text/html").cid;
    const R = fc.addDirectory([{ name: "index.html", cid: F, isDirectory: false }]);
    const W = fc.addDirectory([{ name: "site", cid: R, isDirectory: true }]);
    const chain = {
      id: 84532,
      contracts: { ...(fc.contracts as object), orgFactory: "0x00000000000000000000000000000000000000e1", projectHook: "0x00000000000000000000000000000000000000f1" },
      client: fc.client,
    };
    const mk = (blocked: string[]) => createGateway({ chains: [chain as never], hostMode: { baseHost: BASE }, filter: denylistFilter(blocked), onError: () => {} });
    const get = (gw: ReturnType<typeof mk>, label: string, path: string, inm: string) =>
      gw(new Request(`https://${label}.${BASE}${path}`, { headers: { host: `${label}.${BASE}`, ...(inm ? { "if-none-match": inm } : {}) } }));
    state.projectRoot = R;
    const P = `84532-${ORG.slice(2)}-7`;
    // the ETags an earlier, unblocked visit got: each one really does earn a 304 while nothing is blocked
    const etag = (await get(mk([]), rootContentLabel(84532, R), "/", "")).headers.get("etag")!;
    const wrappedEtag = (await get(mk([]), rootContentLabel(84532, W), "/site/", "")).headers.get("etag")!;
    expect((await get(mk([]), rootContentLabel(84532, R), "/", etag)).status).toBe(304);
    expect((await get(mk([]), rootContentLabel(84532, W), "/site/", wrappedEtag)).status).toBe(304);

    for (const inm of [etag, "*", `W/${etag}`]) {
      expect((await get(mk([rootSubject(R)]), rootContentLabel(84532, R), "/", inm)).status).toBe(451); // URL subject
      expect((await get(mk([rootSubject(R)]), P, "/", inm)).status).toBe(451); // the project's resolved root
      expect((await get(mk([rootSubject(F)]), rootContentLabel(84532, R), "/", inm)).status).toBe(451); // served CID
      expect((await get(mk([rootSubject(F)]), P, "/", inm)).status).toBe(451);
    }
    for (const inm of [wrappedEtag, "*", `W/${wrappedEtag}`]) {
      expect((await get(mk([rootSubject(R)]), rootContentLabel(84532, W), "/site/", inm)).status).toBe(451); // the courtesy directory
    }
  });
});
