/**
 * DELTA-3, the remembered call-budget refusal:
 *
 *  - I3: a ranged request on a file WITH a codec reads the whole file (a codec's output cannot be sliced before it is
 *    decoded), but its call-budget refusal was remembered under the RANGE: the next whole request, and every other
 *    range, read the whole file again. It is now remembered as `whole`, which is what was read, and any request that
 *    would read the whole file is refused from it.
 *  - I2: call-budget refusals shared the capped map of the day-long codec and `outputHash` refusals. They are keyed per
 *    range, so a client could fill that map with ranges of one file and evict the others. They have a map of their own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CODEC_FILE = `0x31${"c0".repeat(31)}`;
const PLAIN_FILE = `0x31${"a0".repeat(31)}`;
const UNKNOWN_CODEC_FILE = `0x31${"e0".repeat(31)}`;
const ZERO = `0x${"00".repeat(32)}`;
// A codec registered below (so the file is readable, whole), and a label no reader here decodes. Left-aligned in a
// bytes32, as the SDK writes a codec label.
const KNOWN = `0x${Buffer.from("x-test").toString("hex").padEnd(64, "0")}`;
const UNKNOWN = `0x${Buffer.from("x-nope").toString("hex").padEnd(64, "0")}`;
/** Big enough that every range below is inside it. */
const SIZE = 1 << 20;

const state = vi.hoisted(() => ({ readCalls: 0, infoCalls: new Map<string, number>(), locateCalls: 0 }));

vi.mock("@artblocks/abxfs-sdk", async (orig) => {
  const real = await orig<typeof import("@artblocks/abxfs-sdk")>();
  return {
    ...real,
    getFileInfo: async (_c: unknown, _a: unknown, cid: string) => {
      state.infoCalls.set(cid, (state.infoCalls.get(cid) ?? 0) + 1);
      const codec = cid === CODEC_FILE ? KNOWN : cid === UNKNOWN_CODEC_FILE ? UNKNOWN : ZERO;
      return { root: `0x${"55".repeat(32)}`, rootLevel: 0, chunkCount: 7, size: SIZE, mimeType: "video/mp4", codec, outputHash: codec === ZERO ? ZERO : `0x${"99".repeat(32)}` };
    },
    readFile: async () => {
      state.readCalls++;
      throw new real.LimitExceededError("calls", 10, "reading file 0x.. (7 chunks)");
    },
    locateByte: async () => {
      state.locateCalls++;
      throw new real.LimitExceededError("calls", 10, "reading file 0x.. (7 chunks)");
    },
  };
});

import { ProjectKind, registerFileCodec, type AbxfsCid, type FileCodec } from "@artblocks/abxfs-sdk";

registerFileCodec({ label: KNOWN as FileCodec, name: "x-test", encode: (b) => b, decode: (b) => b });

import { GatewayError } from "../../src/subjects.js";
import { __resetResolveCaches, serveContent, type RangeSpec, type ResolvedRequest } from "../../src/resolve.js";

const chain = {
  id: 84532,
  contracts: {
    chunkStore: "0x00000000000000000000000000000000000000c1",
    directoryStore: "0x00000000000000000000000000000000000000d2",
    fileStore: "0x00000000000000000000000000000000000000f1",
  } as never,
  client: {} as never,
};
const request = (cid: string): ResolvedRequest => ({
  chain,
  addressing: { kind: "cid", cid: cid as AbxfsCid } as never,
  rootCid: cid as AbxfsCid,
  subpath: "",
  preferredGateway: null,
  kind: ProjectKind.File,
});
async function serve(cid: string, range?: RangeSpec): Promise<GatewayError> {
  const err = await serveContent(request(cid), { located: { type: "file", cid: cid as AbxfsCid, path: "" }, ...(range ? { range } : {}) }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GatewayError);
  return err as GatewayError;
}

beforeEach(() => {
  __resetResolveCaches();
  state.readCalls = 0;
  state.locateCalls = 0;
  state.infoCalls.clear();
});

describe("I3: a ranged request that read the whole file is remembered as the whole file", () => {
  it("a range of a file with a codec, refused for its call budget, refuses the whole file and every other range without a read", async () => {
    const first = await serve(CODEC_FILE, { start: 0, end: 9 });
    expect(first.status).toBe(502);
    expect(first.message).toMatch(/could not be read within the gateway's call budget/);
    expect(state.readCalls).toBe(1);
    expect(state.locateCalls).toBe(0); // the ranged branch was not taken: a codec's output is read whole
    expect((await serve(CODEC_FILE)).status).toBe(502); // the whole file: no read at all
    expect((await serve(CODEC_FILE, { start: 10, end: 19 })).status).toBe(502); // another range: its file record, no read
    expect((await serve(CODEC_FILE, { suffix: 5 })).status).toBe(502);
    expect(state.readCalls).toBe(1);
  });

  it("and the other way round: a whole-file refusal refuses a later range of the same codec file", async () => {
    expect((await serve(CODEC_FILE)).status).toBe(502);
    expect((await serve(CODEC_FILE, { start: 0, end: 9 })).status).toBe(502);
    expect(state.readCalls).toBe(1);
  });

  it("a range of a file WITHOUT a codec is still remembered for that range only", async () => {
    expect((await serve(PLAIN_FILE, { start: 0, end: 9 })).status).toBe(502);
    expect((await serve(PLAIN_FILE, { start: 0, end: 9 })).status).toBe(502);
    expect(state.locateCalls).toBe(1);
    expect((await serve(PLAIN_FILE, { start: 10, end: 19 })).status).toBe(502);
    expect(state.locateCalls).toBe(2);
    expect(state.readCalls).toBe(0);
    // The whole file is another read.
    expect((await serve(PLAIN_FILE)).status).toBe(502);
    expect(state.readCalls).toBe(1);
  });
});

describe("I2: call-budget refusals cannot evict the day-long refusals", () => {
  it("6,000 remembered ranges later, a codec no reader here decodes is still refused without a read", async () => {
    const first = await serve(UNKNOWN_CODEC_FILE);
    expect(first.status).toBe(501);
    expect(state.infoCalls.get(UNKNOWN_CODEC_FILE)).toBe(1);
    // More distinct ranges than any one map holds (5,000): each is its own remembered refusal.
    for (let i = 0; i < 6_000; i++) expect((await serve(PLAIN_FILE, { start: i, end: i })).status).toBe(502);
    expect(state.locateCalls).toBe(6_000);
    const again = await serve(UNKNOWN_CODEC_FILE);
    expect(again.status).toBe(501);
    expect(state.infoCalls.get(UNKNOWN_CODEC_FILE)).toBe(1); // remembered: not even the file record was read again
  });

  it("the call-budget map is capped too: the oldest ranges are forgotten, the newest are still remembered", async () => {
    for (let i = 0; i < 5_001; i++) await serve(PLAIN_FILE, { start: i, end: i });
    expect(state.locateCalls).toBe(5_001);
    await serve(PLAIN_FILE, { start: 5_000, end: 5_000 }); // the newest: remembered
    expect(state.locateCalls).toBe(5_001);
    await serve(PLAIN_FILE, { start: 0, end: 0 }); // the oldest: dropped when the map filled
    expect(state.locateCalls).toBe(5_002);
  });
});
