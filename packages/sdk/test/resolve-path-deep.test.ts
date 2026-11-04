/**
 * `resolvePath` past the contracts' per-call depth limit.
 *
 * `DirectoryStore.resolvePath` reverts `PathTooDeep` on the 33rd segment of ONE call, while directories nest to any
 * depth. The SDK chains calls of at most 32 segments. The mock below answers `resolvePath` rule for rule as the
 * contract does (including the cap), so a reader that did not chain would fail
 * here exactly as it fails on chain, and every call's arguments are recorded so the runs can be checked.
 */
import type { Address, PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_PATH_SEGMENTS,
  PathNotResolvedError,
  RESOLVE_PATH_SEGMENTS_PER_CALL,
  readFileByPath,
  resolvePath,
} from "../src/read.js";
import type { AbxfsCid, ContractAddresses } from "../src/types.js";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const C = (n: number): AbxfsCid => `0x${n.toString(16).padStart(64, "0")}` as AbxfsCid;

const ADDR: ContractAddresses = {
  sstore2Backend: A(0xb1),
  fastLzBackend: A(0xb2),
  chunkStore: A(0xc0),
  fileStore: A(0xf1),
  directoryStore: A(0xd1),
};

type Entry = { name: string; cid: AbxfsCid; isDirectory: boolean };
interface Call {
  address: string;
  fn: string;
  args: readonly unknown[];
}

/** A revert as the contract raises it: the gateway and every caller see a thrown error from `readContract`. */
class Revert extends Error {}

/**
 * A chain of `depth` nested directories `d1/d2/…`, the deepest holding `f.txt`.
 * `fileAt` replaces the directory at that depth with a file of the same name (to descend into a file).
 */
function deepWorld(depth: number, opts: { fileAt?: number } = {}) {
  const dirs = new Map<string, Entry[]>();
  const calls: Call[] = [];
  const fileCid = C(0xf00d);
  // Directory at level k (root is level 0) has cid C(0x1000 + k).
  for (let k = 0; k < depth; k++) {
    const childIsLeaf = k === depth - 1;
    const child: Entry = childIsLeaf
      ? { name: "f.txt", cid: fileCid, isDirectory: false }
      : opts.fileAt === k + 1
        ? { name: `d${k + 1}`, cid: C(0xbad), isDirectory: false }
        : { name: `d${k + 1}`, cid: C(0x1000 + k + 1), isDirectory: true };
    dirs.set(C(0x1000 + k), [child]);
  }
  const dirStore = ADDR.directoryStore!;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  function resolve(root: string, path: string): readonly [AbxfsCid, boolean] {
    if (!dirs.has(root)) throw new Revert("DirectoryNotFound");
    if (path === "" || path.startsWith("/") || path.endsWith("/")) throw new Revert("PathNotFound");
    let cur = root;
    let isDirectory = true;
    let n = 0;
    for (const seg of path.split("/")) {
      if (seg === "" || !isDirectory) throw new Revert("PathNotFound");
      if (++n > 32) throw new Revert("PathTooDeep");
      const hit = dirs.get(cur)?.find((e) => e.name === seg);
      if (!hit) throw new Revert("PathNotFound");
      cur = hit.cid;
      isDirectory = hit.isDirectory;
    }
    return [cur as AbxfsCid, isDirectory];
  }

  const client = {
    async readContract(a: { address: string; functionName: string; args?: readonly unknown[] }) {
      const args = a.args ?? [];
      calls.push({ address: a.address, fn: a.functionName, args });
      if (a.functionName === "directoryExists") return eq(a.address, dirStore) && dirs.has(String(args[0]));
      if (a.functionName === "fileExists") return false;
      if (a.functionName === "resolvePath" && eq(a.address, dirStore)) return resolve(String(args[0]), String(args[1]));
      throw new Error(`unscripted ${a.address}.${a.functionName}`);
    },
  } as unknown as PublicClient;

  const segs = (n: number) => Array.from({ length: n }, (_, i) => (i === depth - 1 ? "f.txt" : `d${i + 1}`));
  const resolveCalls = () => calls.filter((c) => c.fn === "resolvePath");
  return { client, calls, resolveCalls, dirStore, fileCid, root: C(0x1000), path: (n: number) => segs(n).join("/") };
}

describe("resolvePath chains calls past 32 segments", () => {
  it("the contract cap the mock enforces is the SDK's per-call constant", () => {
    expect(RESOLVE_PATH_SEGMENTS_PER_CALL).toBe(32);
    expect(DEFAULT_MAX_PATH_SEGMENTS).toBe(256);
  });

  it("exactly 32 segments: one call, with the path passed through unchanged", async () => {
    const w = deepWorld(32);
    const r = await resolvePath(w.client, ADDR, w.root, w.path(32));
    expect(r).toEqual({ cid: w.fileCid, isDirectory: false });
    expect(w.resolveCalls().map((c) => c.args)).toEqual([[w.root, w.path(32)]]);
  });

  it("70 segments: three calls of 32, 32 and 6 segments, each from the directory the last ended at", async () => {
    const w = deepWorld(70);
    const r = await resolvePath(w.client, ADDR, w.root, w.path(70));
    expect(r).toEqual({ cid: w.fileCid, isDirectory: false });
    const calls = w.resolveCalls();
    expect(calls).toHaveLength(3);
    const segs = w.path(70).split("/");
    expect(calls[0]!.args).toEqual([w.root, segs.slice(0, 32).join("/")]);
    expect(calls[1]!.args).toEqual([C(0x1000 + 32), segs.slice(32, 64).join("/")]);
    expect(calls[2]!.args).toEqual([C(0x1000 + 64), segs.slice(64).join("/")]);
    // No existence probe: there is one directory store, and every run went to it.
    expect(w.calls.filter((c) => c.fn === "directoryExists" || c.fn === "fileExists")).toHaveLength(0);
    expect(calls.every((c) => c.address === w.dirStore)).toBe(true);
  });

  it("a directory 40 deep resolves as a directory", async () => {
    const w = deepWorld(50);
    expect(await resolvePath(w.client, ADDR, w.root, w.path(40))).toEqual({ cid: C(0x1000 + 40), isDirectory: true });
  });

  it("a file ending a run with segments after it is not found, and no further call is made", async () => {
    const w = deepWorld(70, { fileAt: 32 });
    await expect(resolvePath(w.client, ADDR, w.root, w.path(70))).rejects.toBeInstanceOf(PathNotResolvedError);
    expect(w.resolveCalls()).toHaveLength(1);
  });

  it("a file mid-run is the contract's own PathNotFound", async () => {
    const w = deepWorld(70, { fileAt: 40 });
    await expect(resolvePath(w.client, ADDR, w.root, w.path(70))).rejects.toThrow(/PathNotFound/);
  });

  it("a missing name at segment 40 is the contract's PathNotFound", async () => {
    const w = deepWorld(70);
    const segs = w.path(70).split("/");
    segs[39] = "nope";
    await expect(resolvePath(w.client, ADDR, w.root, segs.join("/"))).rejects.toThrow(/PathNotFound/);
    expect(w.resolveCalls()).toHaveLength(2);
  });

  it("empty segments and stray slashes still reach the contract and revert there, at any position", async () => {
    const w = deepWorld(70);
    const segs = w.path(70).split("/");
    const atBoundary = [...segs.slice(0, 32), "", ...segs.slice(32)].join("/"); // `…/d32//d33/…`
    const lastInRun = [...segs.slice(0, 31), "", ...segs.slice(31)].join("/"); // run 1 ends in `/`
    for (const p of [atBoundary, lastInRun, `/${w.path(70)}`, `${w.path(70)}/`]) {
      await expect(resolvePath(w.client, ADDR, w.root, p)).rejects.toBeInstanceOf(Revert);
    }
  });

  it("256 segments resolve in 8 calls; 257 are refused before any call", async () => {
    const w = deepWorld(256);
    expect(await resolvePath(w.client, ADDR, w.root, w.path(256))).toEqual({ cid: w.fileCid, isDirectory: false });
    expect(w.resolveCalls()).toHaveLength(8);

    const deeper = deepWorld(257);
    const err = await resolvePath(deeper.client, ADDR, deeper.root, deeper.path(257)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PathNotResolvedError);
    expect((err as PathNotResolvedError).reason).toBe("too-deep");
    expect(deeper.calls).toHaveLength(0);
  });

  it("maxSegments lowers or raises the cap", async () => {
    const w = deepWorld(40);
    await expect(resolvePath(w.client, ADDR, w.root, w.path(40), { maxSegments: 33 })).rejects.toBeInstanceOf(PathNotResolvedError);
    const big = deepWorld(300);
    expect((await resolvePath(big.client, ADDR, big.root, big.path(300), { maxSegments: 300 })).cid).toBe(big.fileCid);
  });

  it("readFileByPath goes through the same chaining", async () => {
    const w = deepWorld(40);
    // Resolution succeeds past 32; the file read itself is unscripted here, so it is the next call that fails.
    await expect(readFileByPath(w.client, ADDR, w.root, w.path(40))).rejects.toThrow(/unscripted/);
    expect(w.resolveCalls()).toHaveLength(2);
  });
});
