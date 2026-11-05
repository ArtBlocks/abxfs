/**
 * AUDIT 9, coverage: branches the audit found no test reached.
 *
 *  - `resolve.ts`: a TAG and a pinned VERSION, each through its success, "the chain said no" (revert: 404) and "the
 *    chain could not be asked" (transport: 503, never a 404) paths.
 *  - the ranged read's integrity guards: `locateByte` and `getChunkIds` disagreeing, a chunk of the wrong size, an
 *    empty chunk-id page. Each refuses (a generic 502) rather than serve bytes that are not the range asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { outageError, revertError } from "../helpers.js";

const ORG = "0x00000000000000000000000000000000000000a1";
const TAG_CID = `0x${"21".repeat(32)}`;
const V_CID = `0x${"22".repeat(32)}`;
const CHUNK = `0x${"66".repeat(32)}`;
const state = vi.hoisted(() => ({
  tag: null as null | { cid?: string; error?: unknown },
  history: null as null | { value?: unknown; error?: unknown },
  versionCount: 3,
  headCid: null as string | null,
  // ranged reads
  locate: null as null | { index: number; chunkStart: number; chunkId: string; chunkSize: number },
  page: [] as string[],
  slices: [] as Uint8Array[],
}));

vi.mock("@artblocks/abxfs-sdk", async (orig) => {
  const real = await orig<typeof import("@artblocks/abxfs-sdk")>();
  return {
    ...real,
    isOrg: async () => true,
    readProject: async () => ({ cid: state.headCid, kind: real.ProjectKind.File, versionCount: state.versionCount, preferredGateway: null, owner: "0x0000000000000000000000000000000000000001" }),
    readTag: async (_c: unknown, _p: unknown, _id: bigint, tag: string) => {
      if (state.tag?.error) throw state.tag.error;
      return { cid: state.tag?.cid ?? TAG_CID, version: 1, tag };
    },
    readVersionHistory: async () => {
      if (state.history?.error) throw state.history.error;
      return state.history?.value ?? [{ cid: V_CID }];
    },
    getFileInfo: async () => ({
      root: `0x${"55".repeat(32)}`,
      rootLevel: 1,
      chunkCount: 3,
      size: 30,
      mimeType: "text/plain",
      codec: `0x${"00".repeat(32)}`,
      outputHash: `0x${"00".repeat(32)}`,
    }),
    readFile: async () => ({ bytes: new TextEncoder().encode("whole-file"), mimeType: "text/plain" }),
    locateByte: async () => state.locate,
    getChunkIdsPage: async () => state.page,
    readChunkSlices: async () => state.slices,
  };
});

import { createGateway } from "../../src/handler.js";
import { __resetResolveCaches } from "../../src/resolve.js";

const contracts = {
  chunkStore: "0x00000000000000000000000000000000000000c1",
  directoryStore: "0x00000000000000000000000000000000000000d2",
  fileStore: "0x00000000000000000000000000000000000000d1",
  sstore2Backend: "0x00000000000000000000000000000000000000b1",
  fastLzBackend: "0x00000000000000000000000000000000000000b2",
  orgFactory: "0x00000000000000000000000000000000000000e1",
  projectHook: "0x00000000000000000000000000000000000000f1",
} as never;

beforeEach(() => {
  __resetResolveCaches();
  state.tag = null;
  state.history = null;
  state.versionCount = 3;
  state.headCid = `0x${"11".repeat(32)}`;
  state.locate = { index: 0, chunkStart: 0, chunkId: CHUNK, chunkSize: 10 };
  state.page = [CHUNK, `0x${"67".repeat(32)}`, `0x${"68".repeat(32)}`];
  state.slices = [new TextEncoder().encode("0123456789")];
});

const errors: string[] = [];
/** The path layout reaches every addressing kind, tags included (a host cannot carry a tag). */
const gw = () => createGateway({ chains: [{ id: 84532, contracts, client: {} as never }], pathMode: {}, onError: (e) => errors.push(e) });
const get = (path: string, headers: Record<string, string> = {}) => gw()(new Request(`http://gw.example/g/p/84532/${ORG}/1/${path}`, { headers }));

describe("resolve: a tag", () => {
  it("serves what the tag points at", async () => {
    const res = await get("tag/stable");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(TAG_CID);
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");
  });

  it("a tag the chain says does not exist (revert) is a 404 naming it", async () => {
    state.tag = { error: revertError("TagNotFound") };
    const res = await get("tag/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('project 1 has no tag "nope"');
  });

  it("a tag the chain could not be asked about is a retryable 503, never a 404", async () => {
    state.tag = { error: outageError("HttpRequestError", { status: 429 }) };
    const res = await get("tag/stable");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("two tags of one project in flight at once are two resolutions, not one shared", async () => {
    state.tag = { cid: TAG_CID };
    const [a, b] = await Promise.all([get("tag/a"), get("tag/b")]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});

describe("resolve: a pinned version", () => {
  it("serves that version's root", async () => {
    const res = await get("v/2");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-abxfs-root")).toBe(V_CID);
  });

  it("past the version count is a 404 that says how many there are, without reading the history", async () => {
    state.history = { error: new Error("must not be read") };
    const res = await get("v/4");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("project 1 has 3 version(s); no v4");
  });

  it("a history read that REVERTS is a 404", async () => {
    state.history = { error: revertError() };
    const res = await get("v/2");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("project 1 has no version 2");
  });

  it("an empty history page, or one whose entry has no root, is a 404", async () => {
    for (const value of [[], [{ cid: null }]]) {
      __resetResolveCaches();
      state.history = { value };
      const res = await get("v/2");
      expect(res.status, JSON.stringify(value)).toBe(404);
      expect(await res.text()).toBe("project 1 has no version 2");
    }
  });

  it("a history the chain could not be asked for is a 503", async () => {
    state.history = { error: outageError("TimeoutError") };
    expect((await get("v/2")).status).toBe(503);
  });

  it("an unpublished project's latest is a 404 that says so", async () => {
    state.headCid = null;
    const res = await get("latest");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("project 1 has not published anything yet");
  });
});

describe("ranged reads: the integrity guards", () => {
  it("a well-formed range is served from the located chunk", async () => {
    const res = await get("latest", { range: "bytes=2-5" });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
  });

  for (const [name, mutate] of [
    ["locateByte and getChunkIds disagree about the chunk", () => (state.page = [`0x${"77".repeat(32)}`])],
    ["the located chunk is not the size its record says", () => (state.slices = [new TextEncoder().encode("01234")])],
    ["the chunk-id page comes back empty", () => (state.page = [])],
  ] as const) {
    it(`${name}: refused, nothing served`, async () => {
      mutate();
      errors.length = 0;
      const res = await get("latest", { range: "bytes=2-5" });
      expect(res.status).toBe(502);
      expect(await res.text()).toBe("upstream error");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(errors.join("\n")).toMatch(/locateByte and getChunkIds disagree|is 5 bytes, recorded as 10|no chunk ids at index/);
    });
  }
});
