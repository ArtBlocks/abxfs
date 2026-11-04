/**
 * ABX FS reads, the address book's stores, and kind detection, against a mocked client: no chain. The mock answers
 * `readContract` and the `multicall` simulation the way the stores would, and records every call so the tests can assert
 * HOW the SDK read (page sizes, which store, what was skipped) as well as what it returned.
 */
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";

import { chunkStoreAbi } from "../src/abi.js";
import { chunkId, ZERO_HASH } from "../src/cid.js";
import { codecLabel } from "../src/compression.js";
import { locateContent, cidKind } from "../src/kind.js";
import { LimitExceededError } from "../src/limits.js";
import {
  ChunkUnavailableError,
  PAGE_MAX,
  directoryEntryCount,
  getDirectoryEntriesPage,
  getFileChunkIdsPage,
  lookupEntry,
  readDirectory,
  readFile,
  readFileByPath,
  resolvePath,
  walkDirectory,
  walkDirectoryTree,
} from "../src/read.js";
import { assertHookAcceptsContent, contentStores, hookAcceptsContent } from "../src/stores.js";
import { ProjectKind, type AbxfsCid, type ContractAddresses } from "../src/types.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const C = (n: number): AbxfsCid => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;

const BACKEND = A(0xb1);
const ADDR: ContractAddresses = {
  sstore2Backend: BACKEND,
  fastLzBackend: A(0xb2),
  chunkStore: A(0xc0),
  fileStore: A(0xf1),
  directoryStore: A(0xd1),
};

interface Call {
  address: string;
  fn: string;
  args: readonly unknown[];
}

/** A scripted chain: which cids exist where, directory contents and file chunk lists. */
interface World {
  files?: Map<string, { mime: string; outputHash: Hex; chunkIds: Hex[] }>;
  dirs?: Map<string, Array<{ name: string; cid: string; isDirectory: boolean }>>;
  /** chunk id -> its data (stored through {@link BACKEND}). */
  chunks?: Map<string, Uint8Array>;
  /** Ids on a backend the chain cannot read: `read` reverts, `recordOf` names {@link UNREADABLE}. */
  unreadable?: Set<string>;
  /** What the unreadable backend's `retrieval()` answers; undefined makes it revert. */
  retrieval?: readonly [Hex, string];
  hookStores?: { file: Address; dir: Address };
}

const UNREADABLE = A(0x10c);

function mockClient(world: World): { client: PublicClient; calls: Call[] } {
  const calls: Call[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  function record(id: string): readonly [Address, number, Hex, Hex] {
    if (world.unreadable?.has(id)) return [UNREADABLE, 5, C(9), keccak256("0x0102030405")];
    const data = world.chunks?.get(id);
    if (!data) throw new Error("ChunkNotFound");
    return [BACKEND, data.length, C(9), keccak256(data)];
  }

  function read(id: string): Uint8Array {
    // A revert, as a node answers one (code 3): only a revert is the backend's to explain, never a node's other errors.
    if (world.unreadable?.has(id)) throw Object.assign(new Error("execution reverted: RetrieveFailed()"), { code: 3 });
    const data = world.chunks?.get(id);
    if (!data) throw Object.assign(new Error("execution reverted: ChunkNotFound()"), { code: 3 });
    return data;
  }

  function answer(address: string, fn: string, args: readonly unknown[]): unknown {
    calls.push({ address, fn, args });
    if (eq(address, ADDR.fileStore!)) {
      const f = world.files?.get(String(args[0]));
      if (fn === "fileExists") return Boolean(f);
      if (!f) throw new Error("FileNotFound");
      const size = f.chunkIds.reduce((n, id) => n + (world.chunks?.get(id)?.length ?? 0), 0);
      if (fn === "getFileInfo")
        return {
          root: f.chunkIds.length === 0 ? ZERO_HASH : C(1),
          rootLevel: 1,
          chunkCount: BigInt(f.chunkIds.length),
          size: BigInt(size),
          mimeType: f.mime,
          codec: ZERO_HASH,
          outputHash: f.outputHash,
        };
      if (fn === "chunkCount") return BigInt(f.chunkIds.length);
      if (fn === "getChunkIds") return f.chunkIds.slice(Number(args[1]), Number(args[2]));
    }
    if (eq(address, ADDR.directoryStore!)) {
      const d = world.dirs?.get(String(args[0]));
      if (fn === "directoryExists") return Boolean(d);
      if (!d) throw new Error("DirectoryNotFound");
      if (fn === "entryCount") return BigInt(d.length);
      if (fn === "getEntries") return d.slice(Number(args[1]), Number(args[2]));
      if (fn === "lookup") {
        const e = d.find((x) => x.name === args[1]);
        if (!e) throw new Error("PathNotFound");
        return [e.cid, e.isDirectory];
      }
      if (fn === "resolvePath") return [C(0x77), false];
    }
    if (eq(address, ADDR.chunkStore!)) {
      if (fn === "recordOf") return record(String(args[0]));
      if (fn === "read") return ("0x" + Buffer.from(read(String(args[0]))).toString("hex")) as Hex;
    }
    if (eq(address, UNREADABLE) && fn === "retrieval") {
      if (!world.retrieval) throw new Error("no retrieval");
      return world.retrieval;
    }
    if (world.hookStores && fn === "fileStore") return world.hookStores.file;
    if (world.hookStores && fn === "directoryStore") return world.hookStores.dir;
    throw new Error(`unscripted call ${address}.${fn}`);
  }

  const client = {
    async readContract(a: { address: string; functionName: string; args?: readonly unknown[] }) {
      return answer(a.address, a.functionName, a.args ?? []);
    },
    async simulateContract(a: { address: string; abi: never; functionName: string; args: [Hex[]] }) {
      // `multicall(bytes[])`: answer each inner call through the same scripted world, encoded as the contract would.
      // One inner revert reverts the whole multicall, as `Multicallable` does.
      if (a.functionName !== "multicall") throw new Error("unexpected simulateContract " + a.functionName);
      if (!eq(a.address, ADDR.chunkStore!)) throw new Error("unscripted multicall target " + a.address);
      const out: Hex[] = [];
      for (const data of a.args[0]) {
        const { functionName, args } = decodeFunctionData({ abi: chunkStoreAbi, data });
        calls.push({ address: a.address, fn: `multicall:${functionName}`, args: args ?? [] });
        const id = String(args![0]);
        if (functionName === "read") {
          out.push(encodeFunctionResult({ abi: chunkStoreAbi, functionName: "read", result: ("0x" + Buffer.from(read(id)).toString("hex")) as Hex }));
        } else if (functionName === "recordOf") {
          out.push(encodeFunctionResult({ abi: chunkStoreAbi, functionName: "recordOf", result: record(id) }));
        } else throw new Error("unscripted chunk store call " + functionName);
      }
      return { result: out };
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("the address book's stores", () => {
  it("contentStores returns the three stores, and refuses a book that lacks any", () => {
    expect(contentStores(ADDR)).toEqual({ chunkStore: ADDR.chunkStore, fileStore: ADDR.fileStore, directoryStore: ADDR.directoryStore });
    for (const key of ["chunkStore", "fileStore", "directoryStore"] as const) {
      const missing = { ...ADDR, [key]: undefined } as unknown as ContractAddresses;
      expect(() => contentStores(missing)).toThrow(/no ABX FS content stores/);
    }
  });
});

describe("kind detection", () => {
  const root = C(100);

  it("a directory is a Directory; both stores are probed, in parallel", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[root, []]]) });
    expect(await locateContent(client, ADDR, root)).toEqual({ kind: ProjectKind.Directory });
    expect(await cidKind(client, ADDR, root)).toBe(ProjectKind.Directory);
    expect(calls.slice(0, 2).map((c) => `${c.address}:${c.fn}`).sort()).toEqual(
      [`${ADDR.directoryStore}:directoryExists`, `${ADDR.fileStore}:fileExists`].sort(),
    );
  });

  it("a file is a File", async () => {
    const { client } = mockClient({ files: new Map([[C(1), { mime: "text/plain", outputHash: C(0), chunkIds: [] }]]) });
    expect(await locateContent(client, ADDR, C(1))).toEqual({ kind: ProjectKind.File });
  });

  it("in neither is Unset (not null)", async () => {
    const { client } = mockClient({});
    expect(await locateContent(client, ADDR, C(5))).toEqual({ kind: ProjectKind.Unset });
    expect(await cidKind(client, ADDR, C(5))).toBe(ProjectKind.Unset);
  });

  it("in both is an error (disjoint prefixes make it impossible: a lying RPC)", async () => {
    const both = C(6);
    const { client } = mockClient({
      dirs: new Map([[both, []]]),
      files: new Map([[both, { mime: "text/plain", outputHash: C(0), chunkIds: [] }]]),
    });
    await expect(cidKind(client, ADDR, both)).rejects.toThrow(/both a directory and a file/);
  });

  it("a book without stores refuses before any read", async () => {
    const { client, calls } = mockClient({});
    await expect(cidKind(client, { ...ADDR, fileStore: undefined } as unknown as ContractAddresses, C(5))).rejects.toThrow(
      /no ABX FS content stores/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("directory reads are paged at 100", () => {
  const dirCid = C(200);
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `e${String(i).padStart(4, "0")}`, cid: C(1000 + i), isDirectory: i % 50 === 0 }));

  it("readDirectory of 250 entries is three getEntries calls: [0,100) [100,200) [200,250)", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, entries(250)]]) });
    const dir = await readDirectory(client, ADDR, dirCid);
    expect(dir.entries).toHaveLength(250);
    expect(dir.entries.map((e) => e.name)).toEqual(entries(250).map((e) => e.name));
    expect(dir.entries[50]!.isDirectory).toBe(true);
    const pages = calls.filter((c) => c.fn === "getEntries").map((c) => [Number(c.args[1]), Number(c.args[2])]);
    expect(pages.sort((a, b) => a[0]! - b[0]!)).toEqual([[0, 100], [100, 200], [200, 250]]);
    for (const [s, e] of pages) expect(e! - s!).toBeLessThanOrEqual(PAGE_MAX);
  });

  it("an exact multiple (200) is two pages, an empty page is never asked for", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, entries(200)]]) });
    await readDirectory(client, ADDR, dirCid);
    expect(calls.filter((c) => c.fn === "getEntries")).toHaveLength(2);
  });

  it("the empty directory is one entryCount and no page", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, []]]) });
    expect((await readDirectory(client, ADDR, dirCid)).entries).toEqual([]);
    expect(calls.filter((c) => c.fn === "getEntries")).toHaveLength(0);
  });

  it("getDirectoryEntriesPage clamps a 500 request to 100 and returns the first page", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, entries(250)]]) });
    const page = await getDirectoryEntriesPage(client, ADDR, dirCid, 0, 500);
    expect(page).toHaveLength(100);
    const get = calls.find((c) => c.fn === "getEntries")!;
    expect(Number(get.args[2]) - Number(get.args[1])).toBe(100);
    expect(await directoryEntryCount(client, ADDR, dirCid)).toBe(250);
    expect(await getDirectoryEntriesPage(client, ADDR, dirCid, 250, 100)).toEqual([]);
  });

  it("maxEntries refuses a directory bigger than the caller wants in memory", async () => {
    const { client } = mockClient({ dirs: new Map([[dirCid, entries(250)]]) });
    await expect(readDirectory(client, ADDR, dirCid, { maxEntries: 100 })).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("lookupEntry is the on-chain binary-search `lookup`", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, entries(10)]]) });
    expect(await lookupEntry(client, ADDR, dirCid, "e0003")).toEqual({ cid: C(1003), isDirectory: false });
    expect(calls.map((c) => `${c.address}:${c.fn}`)).toEqual([`${ADDR.directoryStore}:lookup`]);
  });

  it("resolvePath is one call to the directory store", async () => {
    const { client, calls } = mockClient({ dirs: new Map([[dirCid, entries(1)]]) });
    expect((await resolvePath(client, ADDR, dirCid, "a/b")).cid).toBe(C(0x77));
    expect(calls.map((c) => c.fn)).toEqual(["resolvePath"]);
  });

  it("walkDirectory reads every directory through its pages, once each, with no probe", async () => {
    const root = C(400);
    const sub = C(401);
    const { client, calls } = mockClient({
      dirs: new Map([
        [root, [{ name: "a.txt", cid: C(1), isDirectory: false }, { name: "sub", cid: sub, isDirectory: true }]],
        [sub, [{ name: "b.txt", cid: C(2), isDirectory: false }]],
      ]),
    });
    const files = await walkDirectory(client, ADDR, root);
    expect(files).toEqual([{ path: "a.txt", cid: C(1) }, { path: "sub/b.txt", cid: C(2) }]);
    expect(calls.filter((c) => c.fn === "entryCount")).toHaveLength(2);
    expect(calls.filter((c) => c.fn === "directoryExists" || c.fn === "fileExists")).toHaveLength(0);
  });

  it("walkDirectoryTree reports empty directories at any depth, and only the innermost", async () => {
    const root = C(410);
    const { client } = mockClient({
      dirs: new Map([
        [root, [{ name: "a.txt", cid: C(1), isDirectory: false }, { name: "x", cid: C(411), isDirectory: true }, { name: "e", cid: C(413), isDirectory: true }]],
        [C(411), [{ name: "y", cid: C(412), isDirectory: true }]],
        [C(412), []],
        [C(413), []],
      ]),
    });
    const tree = await walkDirectoryTree(client, ADDR, root);
    expect(tree.files).toEqual([{ path: "a.txt", cid: C(1) }]);
    expect(tree.emptyDirectories).toEqual(["x/y", "e"]);
    expect(await walkDirectory(client, ADDR, root)).toEqual(tree.files);
  });
});

describe("file reads", () => {
  /** A file of `n` chunks whose ids really are chunkId(backend, keccak(data), keccak(data), size): raw chunks. */
  function file(n: number) {
    const chunks = new Map<string, Uint8Array>();
    const ids: Hex[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = new TextEncoder().encode(`chunk number ${i} `.repeat(3));
      const h = keccak256(bytes);
      const id = chunkId(BACKEND, h, h, bytes.length);
      chunks.set(id, bytes);
      ids.push(id);
    }
    const expected = Buffer.concat(ids.map((h) => Buffer.from(chunks.get(h)!)));
    return { chunks, ids, expected };
  }

  const cid = C(500);

  it("reads 250 chunk ids in pages of 100, then the data through ChunkStore.read", async () => {
    const f = file(250);
    const { client, calls } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
    });
    const r = await readFile(client, ADDR, cid);
    expect(r.mimeType).toBe("text/plain");
    expect(r.chunkIds).toEqual(f.ids);
    expect(Buffer.from(r.bytes).equals(f.expected)).toBe(true);
    expect(Buffer.from(r.data).equals(f.expected)).toBe(true);
    const pages = calls.filter((c) => c.fn === "getChunkIds").map((c) => Number(c.args[2]) - Number(c.args[1]));
    expect(pages.sort((a, b) => a - b)).toEqual([50, 100, 100]);
    // Every chunk: one `read` (the contract checks it against its record). The reader trusts its RPC and checks nothing
    // itself; past one call's worth of chunks it reads the records once, in one batch, only to size its calls (S-M2).
    expect(calls.filter((c) => c.fn === "multicall:read")).toHaveLength(250);
    expect(calls.filter((c) => c.fn === "multicall:recordOf")).toHaveLength(250);
  });

  it("a chunk the chain cannot serve throws ChunkUnavailableError with the backend's own retrieval answer", async () => {
    const f = file(3);
    const { client } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
      unreadable: new Set([f.ids[1]!]),
      retrieval: [codecLabel("evm-log"), "Stored(bytes32,bytes) at the block of the write."],
    });
    const err = await readFile(client, ADDR, cid).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkUnavailableError);
    const e = err as ChunkUnavailableError;
    expect(e.chunkId).toBe(f.ids[1]);
    expect(e.backend).toBe(UNREADABLE);
    expect(e.scheme).toBe("evm-log");
    expect(e.message).toMatch(/The backend says: Stored/);
  });

  it("an unreadable chunk whose backend gives no retrieval answer still names the backend", async () => {
    const f = file(1);
    const { client } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
      unreadable: new Set([f.ids[0]!]),
    });
    const err = await readFile(client, ADDR, cid).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkUnavailableError);
    expect((err as ChunkUnavailableError).scheme).toBe("");
    expect((err as ChunkUnavailableError).message).toMatch(/no retrieval instructions/);
  });

  it("a chunk with no record at all is NOT reported as unavailable: the original failure stands", async () => {
    const f = file(2);
    const { client, calls } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: [f.ids[0]!, C(0xdead)] }]]),
      chunks: f.chunks,
    });
    const err = await readFile(client, ADDR, cid).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/ChunkNotFound/);
    // Its read reverted, so its record was asked for, and there is none.
    expect(calls.filter((c) => c.fn === "recordOf").map((c) => c.args[0])).toEqual([C(0xdead)]);
  });

  // Delta round 7, I-2: a node that simulates less than one chunk's read refuses a chunk on an EVM-readable backend,
  // which was then reported as "cannot be read on chain ... The backend says: EVM-readable".
  it("a chunk whose backend says it is EVM-readable is NOT reported as unavailable: the original failure stands", async () => {
    const f = file(2);
    const { client, calls } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
      unreadable: new Set([f.ids[1]!]),
      retrieval: [codecLabel("evm"), "EVM-readable: ChunkStore.read(id), or retrieve(pointer) on this contract."],
    });
    const err = await readFile(client, ADDR, cid).then(() => undefined, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(ChunkUnavailableError);
    expect(String(err)).toMatch(/RetrieveFailed/);
    expect(calls.some((c) => c.fn === "retrieval")).toBe(true);
  });

  it("the empty file reads as zero bytes with no chunk read", async () => {
    const { client, calls } = mockClient({ files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: [] }]]) });
    const r = await readFile(client, ADDR, cid);
    expect(r.bytes.length).toBe(0);
    expect(r.chunkIds).toEqual([]);
    expect(calls.some((c) => c.fn === "getChunkIds" || c.fn.startsWith("multicall:"))).toBe(false);
  });

  it("getFileChunkIdsPage clamps to 100 and never reads past the end", async () => {
    const f = file(130);
    const { client } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
    });
    expect(await getFileChunkIdsPage(client, ADDR, cid, 0, 1000)).toHaveLength(100);
    expect(await getFileChunkIdsPage(client, ADDR, cid, 100, 1000)).toEqual(f.ids.slice(100));
    expect(await getFileChunkIdsPage(client, ADDR, cid, 130, 10)).toEqual([]);
  });

  it("refuses a file with absurdly many chunks before paging them in (a hostile chunkCount)", async () => {
    const { client } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: [] }]]),
    });
    // Script a chunkCount far past the limit.
    const orig = client.readContract.bind(client);
    (client as unknown as { readContract: unknown }).readContract = async (a: { functionName: string }) =>
      a.functionName === "getFileInfo"
        ? { root: C(1), rootLevel: 3, chunkCount: 10_000_000n, size: 1n, mimeType: "text/plain", codec: ZERO_HASH, outputHash: C(0) }
        : (orig as (a: unknown) => Promise<unknown>)(a);
    await expect(readFile(client, ADDR, cid)).rejects.toBeInstanceOf(LimitExceededError);
  });

  it("refuses a file whose recorded size is past the byte cap before reading a chunk", async () => {
    const { client, calls } = mockClient({
      files: new Map([[cid, { mime: "text/plain", outputHash: C(0), chunkIds: [] }]]),
    });
    const orig = client.readContract.bind(client);
    (client as unknown as { readContract: unknown }).readContract = async (a: { functionName: string }) =>
      a.functionName === "getFileInfo"
        ? { root: C(1), rootLevel: 1, chunkCount: 2n, size: 2n ** 40n, mimeType: "text/plain", codec: ZERO_HASH, outputHash: C(0) }
        : (orig as (a: unknown) => Promise<unknown>)(a);
    await expect(readFile(client, ADDR, cid, { maxStoredBytes: 1024 })).rejects.toBeInstanceOf(LimitExceededError);
    expect(calls.some((c) => c.fn === "getChunkIds")).toBe(false);
  });

  it("readFileByPath resolves once and reads the file with no existence probe", async () => {
    const f = file(2);
    const root = C(600);
    const fileCid = C(0x77); // what the scripted `resolvePath` answers
    const { client, calls } = mockClient({
      dirs: new Map([[root, [{ name: "a.txt", cid: fileCid, isDirectory: false }]]]),
      files: new Map([[fileCid, { mime: "text/plain", outputHash: C(0), chunkIds: f.ids }]]),
      chunks: f.chunks,
    });
    const r = await readFileByPath(client, ADDR, root, "a/b.txt");
    expect(Buffer.from(r.bytes).equals(f.expected)).toBe(true);
    expect(calls.filter((c) => c.fn === "resolvePath")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "fileExists" || c.fn === "directoryExists")).toHaveLength(0);
  });
});

describe("hook binding", () => {
  const HOOK = A(0x4001);
  it("a hook bound to this book's stores accepts; one bound to other stores (or unreadable) does not", async () => {
    const bound = mockClient({ hookStores: { file: ADDR.fileStore!, dir: ADDR.directoryStore! } });
    expect(await hookAcceptsContent(bound.client, ADDR, HOOK)).toBe(true);
    await expect(assertHookAcceptsContent(bound.client, ADDR, HOOK)).resolves.toBeUndefined();

    const other = mockClient({ hookStores: { file: A(0xf9), dir: A(0xd9) } });
    expect(await hookAcceptsContent(other.client, ADDR, HOOK)).toBe(false);
    await expect(assertHookAcceptsContent(other.client, ADDR, HOOK)).rejects.toThrow(/does not validate roots against this deployment's stores/);

    // Half a match is no match: the hook asks both stores.
    const half = mockClient({ hookStores: { file: ADDR.fileStore!, dir: A(0xd9) } });
    expect(await hookAcceptsContent(half.client, ADDR, HOOK)).toBe(false);

    const unreadable = mockClient({});
    expect(await hookAcceptsContent(unreadable.client, ADDR, HOOK)).toBe(false);
    // A book with no stores never accepts, and never throws.
    expect(await hookAcceptsContent(bound.client, { ...ADDR, fileStore: undefined } as unknown as ContractAddresses, HOOK)).toBe(false);
  });
});
